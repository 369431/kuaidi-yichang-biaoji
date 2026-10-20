@echo off
rem Removes the startup shortcut created by install-autostart.cmd.
setlocal
set "PPEXT_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
if exist "%PPEXT_DIR%\PackingProof InnerMismatch Panel.lnk" (
  del /f /q "%PPEXT_DIR%\PackingProof InnerMismatch Panel.lnk"
  echo Removed the startup shortcut.
) else (
  echo No startup shortcut found.
)
pause
