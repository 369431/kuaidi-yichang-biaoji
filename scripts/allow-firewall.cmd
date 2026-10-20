@echo off
rem Allow inbound TCP for the inner-mismatch panel so phones / other PCs on the same LAN can open it.
rem Double click this file; it asks for administrator rights (UAC) automatically.
rem Usage: allow-firewall.cmd [port]   (default 8792)
setlocal
set PORT=%~1
if "%PORT%"=="" set PORT=8792

net session >nul 2>nul
if not errorlevel 1 goto elevated

echo Requesting administrator rights...
set "PPEXT_SELF=%~f0"
set "PPEXT_PORT=%PORT%"
powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath $env:PPEXT_SELF -ArgumentList $env:PPEXT_PORT"
exit /b

:elevated
echo Adding firewall rule for TCP %PORT% (private/domain networks)...
netsh advfirewall firewall delete rule name="PackingProof InnerMismatch Panel" >nul 2>nul
netsh advfirewall firewall add rule name="PackingProof InnerMismatch Panel" dir=in action=allow protocol=TCP localport=%PORT% profile=private,domain
if errorlevel 1 (
  echo [ERROR] Failed to add the firewall rule.
  pause
  exit /b 1
)
echo.
echo Done. Phones and other PCs on the same network can now open:
echo    http://^<this-pc-ip^>:%PORT%/
echo    http://^<this-pc-ip^>:%PORT%/manage
echo.
pause
