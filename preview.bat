@echo off
REM ============================================================================
REM  BinauralAudio - PRODUCTION build + preview (tests the real PWA: service
REM  worker, offline, "Add to Home Screen", and the bundled audio worklet).
REM
REM  Open the "Local:" URL that prints below (http://localhost:4173). To test
REM  install/offline on your phone you need https (this is plain http) - use a
REM  tunnel (e.g. cloudflared / ngrok) pointed at port 4173, or test on the PC.
REM
REM  Press Ctrl+C to stop.
REM ============================================================================
cd /d "%~dp0"

if not exist node_modules (
  echo Installing dependencies ^(first run only^)...
  call npm install
  if errorlevel 1 ( echo. & echo npm install failed. & pause & exit /b 1 )
)

echo.
echo Building for production...
call npm run build
if errorlevel 1 ( echo. & echo Build failed - see errors above. & pause & exit /b 1 )

echo.
echo Starting preview server (Ctrl+C to stop)...
echo.
call npm run preview -- --host
