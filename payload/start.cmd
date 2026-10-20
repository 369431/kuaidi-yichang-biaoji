@echo off
rem PackingProof inner-mismatch exception marker - manual start entry.
rem
rem A console window is only a nuisance here: the panel and hotkeys do not need one, and closing the
rem window used to kill the process by accident. So this script relaunches itself through
rem start-hidden.vbs (no window) and exits; the hidden instance runs node with the log in the data dir.
setlocal

if not defined PPEXT_HIDDEN (
  set "PPEXT_HIDDEN=1"
  if exist "%~dp0start-hidden.vbs" (
    start "" wscript.exe "%~dp0start-hidden.vbs"
    exit /b 0
  )
)

rem Never keep the package directory as the working directory: PackingProof replaces that directory
rem when the extension updates, and Windows refuses to delete a directory that is some process's CWD.
cd /d "%LOCALAPPDATA%" 2>nul
if errorlevel 1 cd /d "%TEMP%" 2>nul

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node.js 20 or newer, then run this file again.
  echo         https://nodejs.org/
  pause
  exit /b 1
)

node "%~dp0src\index.js" %*

rem Hidden instance: there is no window to keep open, so do not pause.
if defined PPEXT_HIDDEN exit /b 0

echo.
echo Adapter exited. Press any key to close this window.
pause >nul
