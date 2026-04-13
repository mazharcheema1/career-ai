@echo off
cd /d "%~dp0"
echo Stopping any existing server...
for /f "tokens=5" %%a in ('netstat -ano 2^>/dev/null ^| findstr ":3738 "') do taskkill /PID %%a /F >/dev/null 2>&1
echo Starting Career AI server...
start "Career AI Server" /D "%~dp0" "C:\Program Files\nodejs\node.exe" career-search.mjs
echo Server starting - browser will open automatically.
echo Close the Career AI Server window to stop.
echo.
pause
