@echo off
REM ============================================================================
REM  BinauralAudio - local DEV server (fastest way to test the audio + UI).
REM
REM  On this PC:   a browser opens at http://localhost:5173  (plug in headphones).
REM  On your PHONE: same Wi-Fi, open the "Network:" URL that prints below
REM                 (e.g. http://192.168.x.x:5173). Audio + UI work over http;
REM                 PWA install / offline need https (use preview.bat on the PC,
REM                 or a tunnel) - see README notes.
REM
REM  Press Ctrl+C in this window to stop the server.
REM ============================================================================
cd /d "%~dp0"

if not exist node_modules (
  echo Installing dependencies ^(first run only^)...
  call npm install
  if errorlevel 1 ( echo. & echo npm install failed - see errors above. & pause & exit /b 1 )
)

echo.
echo Starting Vite dev server (Ctrl+C to stop)...
echo.
call npm run dev -- --host --open
