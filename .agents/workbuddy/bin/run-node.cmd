@echo off
setlocal EnableExtensions EnableDelayedExpansion
set "NODE_BIN="

if defined NODE_BIN_DIR if exist "%NODE_BIN_DIR%\node.exe" set "NODE_BIN=%NODE_BIN_DIR%\node.exe"

if not defined NODE_BIN if defined WORKBUDDY_EXTRA_PATHS (
  for %%D in ("%WORKBUDDY_EXTRA_PATHS:;=" "%") do (
    if not defined NODE_BIN if exist "%%~D\node.exe" set "NODE_BIN=%%~D\node.exe"
  )
)

if not defined NODE_BIN (
  if defined WORKBUDDY_CONFIG_DIR (
    set "WB_CONFIG=%WORKBUDDY_CONFIG_DIR%"
  ) else if defined CODEBUDDY_CONFIG_DIR (
    set "WB_CONFIG=%CODEBUDDY_CONFIG_DIR%"
  ) else (
    set "WB_CONFIG=%USERPROFILE%\.workbuddy"
  )
  if exist "!WB_CONFIG!\binaries\node\versions" (
    for /f "delims=" %%V in ('dir /b /ad /o-n "!WB_CONFIG!\binaries\node\versions" 2^>nul') do (
      if not defined NODE_BIN if exist "!WB_CONFIG!\binaries\node\versions\%%V\bin\node.exe" set "NODE_BIN=!WB_CONFIG!\binaries\node\versions\%%V\bin\node.exe"
    )
  )
)

if not defined NODE_BIN for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE_BIN set "NODE_BIN=%%N"

if not defined NODE_BIN (
  echo [qdm-harness] cannot locate node 1>&2
  exit /b 127
)

"%NODE_BIN%" %*
exit /b %ERRORLEVEL%
