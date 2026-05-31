@echo off
setlocal

set "ROOT=%~dp0"
set "APP_EXE=%ROOT%Dashboard3D-win32-x64\Dashboard3D.exe"
set "DIST_SRC=%ROOT%dist"
set "DIST_DEST=%ROOT%Dashboard3D-win32-x64\resources\app\dist"

echo Building...
pushd "%ROOT%" && call npm run build && popd
if errorlevel 1 (
  echo Build failed.
  pause
  exit /b 1
)

echo Stopping any running Dashboard3D...
taskkill /IM Dashboard3D.exe /F /T >nul 2>&1
:: brief pause so file handles release before xcopy
ping -n 2 127.0.0.1 >nul

echo Deploying...
xcopy /E /Y /I "%DIST_SRC%\*" "%DIST_DEST%\" >nul
:: Mirror the whole src\main tree — main process, workers, preloads,
:: youtube host, default config, and the services\ platform adapters —
:: into the packaged app. /E /I /Y copies every file and subdir, so a
:: new file in src\main deploys automatically: no per-file line to add
:: and forget (which is how stream-preload.js used to get missed).
xcopy /E /I /Y "%ROOT%src\main" "%ROOT%Dashboard3D-win32-x64\resources\app\src\main" >nul
:: Mirror node_modules into the packaged tree. Robocopy with /XO skips
:: files that are already up-to-date, so subsequent runs are fast. /XD
:: excludes dev/build packages that bloat the package without runtime
:: value (electron itself is bundled separately by electron-packager).
:: This replaces the per-dep xcopy lines we used to maintain — new prod
:: deps (e.g. mail-service's imapflow/mailparser/sanitize-html) deploy
:: automatically without per-package wiring.
robocopy "%ROOT%node_modules" "%ROOT%Dashboard3D-win32-x64\resources\app\node_modules" /E /XO /NJH /NJS /NC /NS /NP /XD electron electron-packager .bin .cache >nul
:: Robocopy uses non-zero exit codes for success (1=files copied,
:: 2=extra files in dest, etc); only 8+ is failure. Reset errorlevel
:: so the bat doesn't think the deploy failed.
if errorlevel 8 (
  echo node_modules mirror failed.
  pause
  exit /b 1
)
ver >nul

if exist "%APP_EXE%" (
  start "" "%APP_EXE%"
  exit /b 0
)

echo Dashboard could not find the packaged application.
echo Expected: %APP_EXE%
echo.
echo Run "npm run package" first to build the standalone exe.
pause
exit /b 1
