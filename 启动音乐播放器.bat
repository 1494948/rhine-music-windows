@echo off
rem Rhine Music Windows - source-mode launcher (Windows)
rem Pure ASCII content on purpose: the project path may contain non-ASCII characters.
rem See docs/CROSS-PLATFORM-AUDIT.md - this replaces the macOS-only "启动音乐播放器.command".
setlocal

rem Must clear this, otherwise electron.exe starts in plain Node mode.
set "ELECTRON_RUN_AS_NODE="

set "APP_DIR=%~dp0"
set "APP_DIR=%APP_DIR:~0,-1%"
set "EXE=%APP_DIR%\node_modules\electron\dist\electron.exe"

if not exist "%EXE%" (
  echo [ERROR] Electron is not installed. Run "npm install" first.
  pause
  exit /b 1
)

if not exist "%APP_DIR%\node_modules\three" (
  echo [ERROR] Dependencies are incomplete. Run "npm install" first.
  pause
  exit /b 1
)

start "" "%EXE%" "%APP_DIR%" %*
endlocal
