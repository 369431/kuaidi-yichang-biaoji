@echo off
rem Puts a shortcut into this user's Startup folder so the panel is already running after sign-in.
rem No administrator rights needed. Double click once (or pass the installed start.cmd path).
rem
rem Example:
rem   install-autostart.cmd "%LOCALAPPDATA%\ExpressPackingMonitoring\extensions\packages\369431.inner-mismatch\1.0.1\payload\start.cmd"
setlocal
set "START_CMD=%~1"
if "%START_CMD%"=="" (
  echo Usage: install-autostart.cmd "full path to payload\start.cmd"
  echo Example: install-autostart.cmd "%LOCALAPPDATA%\ExpressPackingMonitoring\extensions\packages\369431.inner-mismatch\1.0.1\payload\start.cmd"
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-autostart.ps1" -StartCmd "%START_CMD%"
if errorlevel 1 (
  echo.
  echo [ERROR] Failed to create the startup shortcut.
  pause
  exit /b 1
)
echo.
echo The panel starts minimized next time you sign in.
pause
