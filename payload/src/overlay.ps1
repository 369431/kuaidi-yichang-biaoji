param(
    [string]$BaseUrl = "http://127.0.0.1:8792",
    [string]$Token = ""
)

# Floating marking bar for the PackingProof inner-mismatch adapter.
#
# A small always-on-top WPF window that sits next to the recording window: it shows the parcel being
# recorded and marks it with one click. All user-visible labels come from the adapter's HTTP API
# (/api/overlay-ui) so this file can stay pure ASCII, which Windows PowerShell 5.1 requires.
#
# ASCII only. Started with -STA by the adapter.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Net.Http
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class OverlayDpi
{
    [DllImport("shcore.dll")]
    private static extern int SetProcessDpiAwareness(int value);

    public static void Enable()
    {
        try { SetProcessDpiAwareness(2); } catch { }
    }
}
'@
# Must run before any window is created so coordinates and rendering match the screen.
[OverlayDpi]::Enable()

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OverlayMouse
{
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT point);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr handle, out RECT rect);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr handle, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);

    // Moves the window in physical pixels (no DIP conversion), keeping it topmost.
    public static void MoveTo(IntPtr handle, int x, int y)
    {
        const uint SWP_NOSIZE = 0x0001;
        const uint SWP_NOACTIVATE = 0x0010;
        SetWindowPos(handle, new IntPtr(-1), x, y, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE);
    }

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr handle, int message, IntPtr wParam, IntPtr lParam);

    // Lets Windows drag the borderless window: no coordinate math, no feedback loop.
    public static void BeginDrag(IntPtr handle)
    {
        const int WM_NCLBUTTONDOWN = 0x00A1;
        const int HTCAPTION = 0x0002;
        ReleaseCapture();
        SendMessage(handle, WM_NCLBUTTONDOWN, new IntPtr(HTCAPTION), IntPtr.Zero);
    }

    public static int ScreenWidth { get { return GetSystemMetrics(0); } }
    public static int ScreenHeight { get { return GetSystemMetrics(1); } }
}
'@
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class OverlayTopmost
{
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint flags);

    public static void Apply(IntPtr handle)
    {
        const uint SWP_NOSIZE = 0x0001;
        const uint SWP_NOMOVE = 0x0002;
        const uint SWP_NOACTIVATE = 0x0010;
        SetWindowPos(handle, new IntPtr(-1), 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
    }
}
'@

if (-not $Token) { $Token = $env:PACKINGPROOF_PANEL_TOKEN }
$script:baseUrl = $BaseUrl.TrimEnd('/')
$script:http = New-Object System.Net.Http.HttpClient
$script:http.Timeout = [TimeSpan]::FromSeconds(5)
if ($Token) { $script:http.DefaultRequestHeaders.Add('X-Panel-Token', $Token) }

$dataDir = $env:PACKINGPROOF_EXTENSION_DATA_DIR
if (-not $dataDir) {
    $dataDir = Join-Path $env:LOCALAPPDATA 'ExpressPackingMonitoring\extension-data\369431.inner-mismatch'
}
$script:positionPath = Join-Path $dataDir 'overlay.json'
$script:state = $null
$script:lastRecordId = ''

function Get-Json($path) {
    try {
        $text = $script:http.GetStringAsync($script:baseUrl + $path).GetAwaiter().GetResult()
        return $text | ConvertFrom-Json
    }
    catch { return $null }
}

function Post-Json($path, $payload) {
    try {
        $json = $payload | ConvertTo-Json -Compress
        $content = New-Object System.Net.Http.StringContent($json, [System.Text.Encoding]::UTF8, 'application/json')
        $response = $script:http.PostAsync($script:baseUrl + $path, $content).GetAwaiter().GetResult()
        $text = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        $data = $text | ConvertFrom-Json
        return @{ ok = [bool]$data.ok; data = $data; status = [int]$response.StatusCode }
    }
    catch { return @{ ok = $false; data = $null; status = 0 } }
}

# --- labels come from the adapter so this file never needs non-ASCII text -------------------------
$ui = Get-Json '/api/overlay-ui'
if (-not $ui) {
    [Console]::Error.Write('adapter not reachable')
    exit 1
}
$labels = $ui.labels
$reasonNames = @($ui.reasons)

$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="marker" Width="392" SizeToContent="Height" WindowStyle="None" AllowsTransparency="True"
        Background="Transparent" Topmost="True" ShowInTaskbar="False" ShowActivated="False" ResizeMode="NoResize">
  <Border CornerRadius="12" Background="#F21F2430" BorderBrush="#33FFFFFF" BorderThickness="1" Padding="12">
    <StackPanel>
      <DockPanel Name="TitleBar" LastChildFill="False" Margin="0,0,0,8" Background="Transparent" Height="26">
        <TextBlock Name="TitleText" Foreground="#E5E7EB" FontSize="13" FontWeight="Bold" VerticalAlignment="Center"/>
        <Button Name="CloseButton" DockPanel.Dock="Right" Content="x" Width="22" Height="22" FontSize="12"
                Foreground="#9CA3AF" Background="Transparent" BorderThickness="0" Cursor="Hand"/>
      </DockPanel>
      <TextBlock Name="TrackingText" Foreground="#FFFFFF" FontSize="22" FontWeight="Bold" TextWrapping="Wrap" Margin="0,0,0,2"/>
      <TextBlock Name="StatusText" Foreground="#9CA3AF" FontSize="11" Margin="0,0,0,10"/>
      <UniformGrid Name="ReasonGrid" Columns="2"/>
      <TextBlock Name="FeedbackText" Foreground="#9CA3AF" FontSize="11" TextWrapping="Wrap" Margin="0,8,0,0"/>
    </StackPanel>
  </Border>
</Window>
"@

$reader = New-Object System.Xml.XmlNodeReader ([xml]$xaml)
$window = [Windows.Markup.XamlReader]::Load($reader)

$titleBar = $window.FindName('TitleBar')
$titleText = $window.FindName('TitleText')
$closeButton = $window.FindName('CloseButton')
$trackingText = $window.FindName('TrackingText')
$statusText = $window.FindName('StatusText')
$reasonGrid = $window.FindName('ReasonGrid')
$feedbackText = $window.FindName('FeedbackText')

$titleText.Text = $labels.title
$trackingText.Text = $labels.waiting
$feedbackText.Text = ''

# Dragging is implemented by hand instead of Window.DragMove(): this window is created without
# activation, and DragMove() silently does nothing on a non-activated window.
$titleBar.Add_MouseLeftButtonDown({
        param($sender, $eventArgs)
        if ($eventArgs.ClickCount -ge 2) {
            # Double click brings the bar back to the top-right corner.
            $resetHandle = (New-Object System.Windows.Interop.WindowInteropHelper $window).Handle
            [OverlayMouse]::MoveTo($resetHandle, ([OverlayMouse]::ScreenWidth - 420), 60)
            $eventArgs.Handled = $true
            return
        }
        $handle = (New-Object System.Windows.Interop.WindowInteropHelper $window).Handle
        [OverlayMouse]::BeginDrag($handle)
        $eventArgs.Handled = $true
    })

$closeButton.Add_Click({ $window.Close() })

# WPF's Topmost can be ignored when the window is created without activation; force it through Win32
# and keep re-asserting it, otherwise Edge/PackingProof ends up drawn above the bar.
$window.Add_Loaded({
        try {
            $window.Topmost = $true
            $handle = (New-Object System.Windows.Interop.WindowInteropHelper $window).Handle
            [OverlayTopmost]::Apply($handle)
        }
        catch { }
    })

$topmostTimer = New-Object System.Windows.Threading.DispatcherTimer
$topmostTimer.Interval = [TimeSpan]::FromSeconds(5)
$topmostTimer.Add_Tick({
        try {
            $handle = (New-Object System.Windows.Interop.WindowInteropHelper $window).Handle
            if ($handle -ne [IntPtr]::Zero) { [OverlayTopmost]::Apply($handle) }
        }
        catch { }
    })
$topmostTimer.Start()

$window.Tag = @{ state = $null; lastRecordId = ''; feedbackUntil = [DateTime]::MinValue }
$script:feedbackUntil = [DateTime]::MinValue

function Show-Feedback($text, $color) {
    $script:feedbackUntil = (Get-Date).AddSeconds(6)
    $feedbackText.Text = $text
    $feedbackText.Foreground = (New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString($color)))
}

function Add-ReasonButtons {
    $reasonGrid.Children.Clear()
    foreach ($reason in $reasonNames) {
        $button = New-Object System.Windows.Controls.Button
        $button.Content = $reason
        $button.Margin = '3'
        $button.Height = 40
        $button.FontSize = 13
        $button.FontWeight = 'Bold'
        $button.Padding = '2'
        $button.HorizontalContentAlignment = 'Center'
        $button.Foreground = (New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString('#111827')))
        $button.Background = (New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString('#F9FAFB')))
        $button.BorderBrush = (New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString('#D1D5DB')))
        $button.Cursor = 'Hand'
        $button.FocusVisualStyle = $null
        $button.Add_Click({
                param($sender, $eventArgs)
                $name = [string]$sender.Content
                $current = $window.Tag.state.watcher.current
                if (-not $current -or -not $current.trackingNumber) {
                    Show-Feedback $labels.notRecording '#F87171'
                    return
                }
                $result = Post-Json '/api/mark' @{
                    trackingNumber = $current.trackingNumber
                    sessionId      = $current.sessionId
                    recordingId    = $current.recordingId
                    reason         = $name
                }
                if ($result.ok) {
                    $window.Tag.lastRecordId = [string]$result.data.record.id
                    $stamp = Get-Date -Format 'HH:mm:ss'
                    Show-Feedback ($name + '  ' + $stamp) '#34D399'
                }
                else {
                    $message = $labels.failed
                    if ($result.data -and $result.data.error) { $message = [string]$result.data.error }
                    Show-Feedback $message '#F87171'
                }
            })
        [void]$reasonGrid.Children.Add($button)
    }

    $undo = New-Object System.Windows.Controls.Button
    $undo.Content = $labels.undo
    $undo.Margin = '3,8,3,0'
    $undo.Height = 32
    $undo.Foreground = (New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString('#E5E7EB')))
    $undo.Background = (New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString('#374151')))
    $undo.BorderThickness = 0
    $undo.Cursor = 'Hand'
    $undo.FocusVisualStyle = $null
    $undo.Add_Click({
            param($sender, $eventArgs)
            if (-not $window.Tag.lastRecordId) {
                Show-Feedback $labels.nothingToUndo '#FBBF24'
                return
            }
            $result = Post-Json '/api/revoke' @{ id = $window.Tag.lastRecordId }
            if ($result.ok) {
                $window.Tag.lastRecordId = ''
                Show-Feedback $labels.revoked '#FBBF24'
            }
            else {
                Show-Feedback $labels.failed '#F87171'
            }
        })
    [void]$reasonGrid.Children.Add($undo)
}

Add-ReasonButtons

function Refresh-State {
    $state = Get-Json '/api/state'
    if ($script:feedbackUntil -lt (Get-Date)) {
        $feedbackText.Text = ''
        $feedbackText.Foreground = (New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString('#9CA3AF')))
    }
    if (-not $state) {
        $statusText.Text = $labels.offline
        $trackingText.Text = '--'
        return
    }
    $window.Tag.state = $state
    $current = $state.watcher.current
    if ($current -and $current.trackingNumber) {
        $trackingText.Text = [string]$current.trackingNumber
        if ($state.auth -and $state.auth.status -ne 'authorized') {
            $statusText.Text = $labels.notAuthorized
            $statusText.Foreground = (New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString('#F87171')))
        }
        else {
            # A fresh recording invalidates the "nothing is recording" warning from before.
            if ($feedbackText.Text -eq $labels.notRecording) { $feedbackText.Text = '' }
            $statusText.Text = $labels.recording
            $statusText.Foreground = (New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString('#34D399')))
        }
        return
    }
    if ($state.watcher.lastScan -and $state.watcher.lastScan.trackingNumber) {
        $trackingText.Text = [string]$state.watcher.lastScan.trackingNumber
        $statusText.Text = $labels.stopped
        $statusText.Foreground = (New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString('#9CA3AF')))
        return
    }
    $trackingText.Text = $labels.waiting
    $statusText.Text = $labels.waitingHint
}

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds(1)
$timer.Add_Tick({ Refresh-State })
$timer.Start()

Refresh-State

# Placement and persistence use physical pixels: with per-monitor DPI, WPF Left/Top and GetWindowRect
# disagree by the scale factor.
$script:startPosition = $null
try {
    if (Test-Path -LiteralPath $script:positionPath) {
        $saved = Get-Content -LiteralPath $script:positionPath -Raw | ConvertFrom-Json
        if ($saved.x -ne $null -and $saved.y -ne $null) { $script:startPosition = @{ x = [int]$saved.x; y = [int]$saved.y } }
    }
}
catch { }

$window.Add_Loaded({
        try {
            $handle = (New-Object System.Windows.Interop.WindowInteropHelper $window).Handle
            if ($script:startPosition) {
                [OverlayMouse]::MoveTo($handle, $script:startPosition.x, $script:startPosition.y)
            }
            else {
                [OverlayMouse]::MoveTo($handle, ([OverlayMouse]::ScreenWidth - 420), 60)
            }
            [OverlayTopmost]::Apply($handle)
        }
        catch { }
    })

$window.Add_Closing({
        try {
            $handle = (New-Object System.Windows.Interop.WindowInteropHelper $window).Handle
            $rect = New-Object OverlayMouse+RECT
            if ([OverlayMouse]::GetWindowRect($handle, [ref]$rect)) {
                $payload = @{ x = [int]$rect.Left; y = [int]$rect.Top } | ConvertTo-Json -Compress
                [System.IO.File]::WriteAllText($script:positionPath, $payload)
            }
        }
        catch { }
    })

[void]$window.ShowDialog()
