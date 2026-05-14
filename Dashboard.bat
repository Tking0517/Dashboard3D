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
xcopy /Y "%ROOT%src\main\main.js"             "%ROOT%Dashboard3D-win32-x64\resources\app\src\main\" >nul
xcopy /Y "%ROOT%src\main\preload.js"          "%ROOT%Dashboard3D-win32-x64\resources\app\src\main\" >nul
xcopy /Y "%ROOT%src\main\audify-worker.js"       "%ROOT%Dashboard3D-win32-x64\resources\app\src\main\" >nul
xcopy /Y "%ROOT%src\main\audify-worker-linux.js" "%ROOT%Dashboard3D-win32-x64\resources\app\src\main\" >nul
xcopy /Y "%ROOT%src\main\audio-fft.js"           "%ROOT%Dashboard3D-win32-x64\resources\app\src\main\" >nul
xcopy /Y "%ROOT%src\main\youtube-host.html"   "%ROOT%Dashboard3D-win32-x64\resources\app\src\main\" >nul
xcopy /Y "%ROOT%src\main\youtube-preload.js"  "%ROOT%Dashboard3D-win32-x64\resources\app\src\main\" >nul
xcopy /Y "%ROOT%src\main\default-config.json" "%ROOT%Dashboard3D-win32-x64\resources\app\src\main\" >nul
:: services/ holds the platform adapters (win/linux). /E /I /Y mirrors
:: the whole tree so new files + subdirs land without listing each one.
xcopy /E /I /Y "%ROOT%src\main\services" "%ROOT%Dashboard3D-win32-x64\resources\app\src\main\services" >nul
:: yt-client is a sibling file-dep at E:\VSCODE\yt-client and lives in
:: our node_modules. Mirror it into the packaged resources so source
:: changes in yt-client (engines, yt-dlp wrapper) flow without needing
:: a full electron-packager rebuild. The bundled yt-dlp binaries are
:: in bin/ — /E mirrors them too.
xcopy /E /I /Y "%ROOT%node_modules\yt-client" "%ROOT%Dashboard3D-win32-x64\resources\app\node_modules\yt-client" >nul
:: ffmpeg-static — ~80MB Windows BtbN build with h264_nvenc/hevc_nvenc.
:: Powers the rec-room PROCESS snap-stitcher's GPU fast path. Mirror
:: into packaged resources so the deployed exe finds the binary.
xcopy /E /I /Y "%ROOT%node_modules\ffmpeg-static" "%ROOT%Dashboard3D-win32-x64\resources\app\node_modules\ffmpeg-static" >nul

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
