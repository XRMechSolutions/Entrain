@echo off
REM ============================================================================
REM  Entrain - one-time setup (Windows).
REM  Checks for Node.js (installs it via winget if missing), then installs the
REM  project's dependencies. After this, use start.bat or preview.bat.
REM ============================================================================
title Entrain - Setup
cd /d "%~dp0"

echo ============================================================
echo   Entrain - one-time setup
echo ============================================================
echo.

REM --- 1. Node.js -----------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 goto :no_node

for /f "delims=" %%v in ('node -v') do set "NODEVER=%%v"
echo Node.js found: %NODEVER%
goto :install_deps

:no_node
echo Node.js is not installed - it is required to run this app.
echo.
where winget >nul 2>&1
if errorlevel 1 goto :manual_node
echo Installing the latest Node.js LTS via winget...
echo.
winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
echo.
echo Node.js was installed. Please CLOSE this window and run setup.bat again
echo so Node is on your PATH - that finishes installing the dependencies.
echo.
pause
exit /b 0

:manual_node
echo Could not find winget. Please install Node.js LTS ^(version 20 or newer^) from:
echo.
echo     https://nodejs.org/
echo.
echo then run setup.bat again.
pause
exit /b 1

REM --- 2. Dependencies ------------------------------------------------------
:install_deps
echo.
echo Installing project dependencies ^(npm install^)...
echo.
call npm install
if errorlevel 1 (
  echo.
  echo npm install failed - see the errors above.
  pause
  exit /b 1
)

echo.
echo ============================================================
echo   Setup complete!
echo.
echo   Next, just double-click:
echo     start.bat     - run the app in your browser ^(dev server^)
echo     preview.bat   - build + preview the installable PWA
echo ============================================================
echo.
pause
