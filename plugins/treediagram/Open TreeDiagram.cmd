@echo off
setlocal
node "%~dp0scripts\launcher.mjs" %*
if errorlevel 1 (
  echo.
  pause
)
endlocal
