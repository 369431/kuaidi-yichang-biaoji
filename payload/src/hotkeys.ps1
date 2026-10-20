param(
    [Parameter(Mandatory = $false)]
    [string]$Activator = "",

    [Parameter(Mandatory = $false)]
    [string]$Undo = "",

    [Parameter(Mandatory = $false)]
    [string]$Bindings = "",

    [Parameter(Mandatory = $false)]
    [int]$ArmSeconds = 8
)

# Global hotkey host for the PackingProof inner-mismatch adapter.
# ASCII only: Windows PowerShell 5.1 reads .ps1 files with the OEM code page.
#
# Two marking styles, both optional:
#   - Activator: one global key arms "marking mode" for a few seconds; while armed, bare digits 1..9
#     pick the reason and Esc cancels. This is the two-step flow: press F9, then press 1.
#   - Bindings: direct per-reason combinations (id = 100 + reason index).
#
# Specs are "<modifierBits>=<virtualKey>". modifierBits: Alt=1, Ctrl=2, Shift=4, Win=8.
# -Bindings is a semicolon separated list of "<id>=<modifierBits>=<virtualKey>".
#
# Protocol on stdout:
#   BIND <id> ok|fail
#   READY
#   ARMED | DISARMED | CANCEL
#   PICK <digit>
#   HOTKEY <id>
#   BYE
# Commands on stdin:
#   ARM | DISARM | BEEP OK | BEEP ERR | BEEP UNDO | BEEP ARM | QUIT

$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Threading;
using System.Windows.Forms;
using System.Runtime.InteropServices;

public class PackingProofHotkeys : NativeWindow
{
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    private const int WM_HOTKEY = 0x0312;
    private const uint MOD_NOREPEAT = 0x4000;
    private const int ID_ACTIVATOR = 1;
    private const int ID_UNDO = 99;
    private const int ID_DIGIT_BASE = 10;
    private const int ID_CANCEL = 19;
    public static int ArmSeconds = 8;

    private uint _activatorModifiers;
    private uint _activatorKey;
    private bool _hasActivator;
    private bool _armed;
    private readonly System.Threading.Timer _armTimer;

    public PackingProofHotkeys()
    {
        CreateHandle(new CreateParams());
        _armTimer = new System.Threading.Timer(OnArmTimeout, null, System.Threading.Timeout.Infinite, System.Threading.Timeout.Infinite);
    }

    private void OnArmTimeout(object state)
    {
        Disarm();
    }

    public static void Emit(string line)
    {
        Console.Out.WriteLine(line);
        Console.Out.Flush();
    }

    public bool ConfigureActivator(uint modifiers, uint virtualKey)
    {
        _activatorModifiers = modifiers;
        _activatorKey = virtualKey;
        _hasActivator = true;
        return RegisterHotKey(Handle, ID_ACTIVATOR, modifiers | MOD_NOREPEAT, virtualKey);
    }

    public bool ConfigureUndo(uint modifiers, uint virtualKey)
    {
        return RegisterHotKey(Handle, ID_UNDO, modifiers | MOD_NOREPEAT, virtualKey);
    }

    public bool ConfigureBinding(int id, uint modifiers, uint virtualKey)
    {
        return RegisterHotKey(Handle, id, modifiers | MOD_NOREPEAT, virtualKey);
    }

    public void Arm()
    {
        if (!_hasActivator) return;
        if (_armed)
        {
            _armTimer.Change(ArmSeconds * 1000, System.Threading.Timeout.Infinite);
            Emit("ARMED");
            return;
        }
        bool any = false;
        for (int digit = 1; digit <= 9; digit++)
        {
            if (RegisterHotKey(Handle, ID_DIGIT_BASE + digit, MOD_NOREPEAT, (uint)('0' + digit))) any = true;
        }
        RegisterHotKey(Handle, ID_CANCEL, MOD_NOREPEAT, 0x1B);
        _armed = true;
        _armTimer.Change(ArmSeconds * 1000, System.Threading.Timeout.Infinite);
        if (!any) { Disarm(); return; }
        Emit("ARMED");
        Beep(1240, 70);
    }

    public void Disarm()
    {
        if (!_armed) return;
        _armed = false;
        _armTimer.Change(System.Threading.Timeout.Infinite, System.Threading.Timeout.Infinite);
        for (int digit = 1; digit <= 9; digit++) UnregisterHotKey(Handle, ID_DIGIT_BASE + digit);
        UnregisterHotKey(Handle, ID_CANCEL);
        Emit("DISARMED");
    }

    private static void Beep(int frequency, int duration)
    {
        try { Console.Beep(frequency, duration); } catch { }
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_HOTKEY)
        {
            int id = m.WParam.ToInt32();
            if (id == ID_ACTIVATOR)
            {
                Arm();
            }
            else if (id == ID_UNDO)
            {
                Emit("HOTKEY " + id);
            }
            else if (id >= ID_DIGIT_BASE + 1 && id <= ID_DIGIT_BASE + 9)
            {
                int digit = id - ID_DIGIT_BASE;
                Disarm();
                Emit("PICK " + digit);
                Beep(880, 60);
            }
            else if (id == ID_CANCEL)
            {
                Disarm();
                Emit("CANCEL");
                Beep(320, 120);
            }
            else if (id >= 100)
            {
                Emit("HOTKEY " + id);
            }
        }
        base.WndProc(ref m);
    }

    public static void Run(string activatorSpec, string undoSpec, string bindingSpec)
    {
        var host = new PackingProofHotkeys();
        int bound = 0;

        if (!string.IsNullOrEmpty(activatorSpec))
        {
            string[] parts = activatorSpec.Split('=');
            uint modifiers;
            uint key;
            if (parts.Length == 2 && uint.TryParse(parts[0], out modifiers) && uint.TryParse(parts[1], out key))
            {
                bool ok = host.ConfigureActivator(modifiers, key);
                if (ok) bound++;
                Emit("BIND 1 " + (ok ? "ok" : "fail"));
            }
        }

        if (!string.IsNullOrEmpty(undoSpec))
        {
            string[] parts = undoSpec.Split('=');
            uint modifiers;
            uint key;
            if (parts.Length == 2 && uint.TryParse(parts[0], out modifiers) && uint.TryParse(parts[1], out key))
            {
                bool ok = host.ConfigureUndo(modifiers, key);
                if (ok) bound++;
                Emit("BIND 99 " + (ok ? "ok" : "fail"));
            }
        }

        foreach (string part in bindingSpec.Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries))
        {
            string[] fields = part.Split('=');
            if (fields.Length != 3) continue;
            int id;
            uint modifiers;
            uint virtualKey;
            if (!int.TryParse(fields[0], out id)) continue;
            if (!uint.TryParse(fields[1], out modifiers)) continue;
            if (!uint.TryParse(fields[2], out virtualKey)) continue;
            bool ok = host.ConfigureBinding(id, modifiers, virtualKey);
            if (ok) bound++;
            Emit("BIND " + id + " " + (ok ? "ok" : "fail"));
        }

        if (bound == 0)
        {
            Emit("BYE");
            return;
        }
        Emit("READY");

        var reader = new Thread(delegate()
        {
            try
            {
                string line;
                while ((line = Console.In.ReadLine()) != null)
                {
                    string command = line.Trim().ToUpperInvariant();
                    if (command == "QUIT") break;
                    if (command == "ARM") { host.Arm(); continue; }
                    if (command == "DISARM") { host.Disarm(); continue; }
                    if (command.StartsWith("BEEP"))
                    {
                        if (command.Contains("ERR")) Beep(320, 220);
                        else if (command.Contains("UNDO")) { Beep(520, 110); Beep(392, 150); }
                        else if (command.Contains("ARM")) Beep(1240, 70);
                        else { Beep(880, 90); Beep(1180, 90); }
                    }
                }
            }
            catch { }
            Application.ExitThread();
        });
        reader.IsBackground = true;
        reader.Start();

        Application.Run();
        Emit("BYE");
    }
}
'@

Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition $source
[PackingProofHotkeys]::ArmSeconds = [Math]::Max(3, [Math]::Min(30, $ArmSeconds))
[PackingProofHotkeys]::Run($Activator, $Undo, $Bindings)
