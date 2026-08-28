@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0INSTALL-QWENPAW-COMMAND-DEBUG.ps1" %*
exit /b %ERRORLEVEL%
