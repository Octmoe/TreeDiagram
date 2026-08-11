@echo off
setlocal
node "%~dp0plugins\treediagram\scripts\launcher.mjs" %*
if errorlevel 1 (
  echo.
  pause
)
endlocal
