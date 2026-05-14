const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dash', {
  platform:   process.platform,
  systemInfo: () => ipcRenderer.invoke('system-info'),
  storageInfo: () => ipcRenderer.invoke('storage-info'),
  tempsInfo:   () => ipcRenderer.invoke('temps-info'),
  netInfo:     () => ipcRenderer.invoke('net-info'),
  diskInfo:    () => ipcRenderer.invoke('disk-info'),
  getConfig:   () => ipcRenderer.invoke('config-get'),
  setConfig:   (partial) => ipcRenderer.invoke('config-set', partial),
  configPath:  () => ipcRenderer.invoke('config-path'),
  // Pollen.com unofficial endpoint — main process fetches with the
  // required Referer header (renderer can't override it). Returns
  // { ok: true, data: {...} } or { error: '...' }.
  getPollen:   (zip) => ipcRenderer.invoke('get-pollen', zip),
  toggleFullscreen: () => ipcRenderer.invoke('toggle-fullscreen'),
  setAlwaysOnTop:   (on) => ipcRenderer.invoke('set-always-on-top', on),
  azureAutoConfig:  () => ipcRenderer.invoke('azure-auto-config'),
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),

  // Push subscription: native WASAPI loopback levels from the main process.
  onAudioOutLevel: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on('audio-out-level', handler);
    return () => ipcRenderer.removeListener('audio-out-level', handler);
  },
  // Raw PCM samples from the same WASAPI loopback worker, gated by
  // setLoopbackPcm(true). Used by the screen recorder to mix loopback
  // audio into the recording's MediaStream (so window-source captures
  // — which Chromium delivers without an audio track — still record
  // sound). data = { pcm: Float32Array (interleaved), sampleRate, channels }.
  onLoopbackPcm: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on('audio-out-pcm', handler);
    return () => ipcRenderer.removeListener('audio-out-pcm', handler);
  },
  setLoopbackPcm: (on) => ipcRenderer.invoke('audio-loopback-pcm', !!on),

  // GENERATE pane — ComfyUI workflow front-end. Workflows live in
  // cfg.comfyWorkflowDir; the renderer talks to ComfyUI's HTTP API
  // directly so submission/polling don't need IPC.
  comfyListWorkflows: () => ipcRenderer.invoke('comfy-list-workflows'),
  comfyLoadWorkflow:  (file) => ipcRenderer.invoke('comfy-load-workflow', file),
  comfySaveOutput:    (kind, bytes, ext) => ipcRenderer.invoke('comfy-save-output', kind, bytes, ext),
  // CORS-bypassing HTTP proxy via main's Node http module. Used by
  // the GENERATE pane to talk to ComfyUI (default 127.0.0.1:8000).
  comfyHttp:          (opts) => ipcRenderer.invoke('comfy-http', opts),
  setAudioDevice: (deviceId) => ipcRenderer.invoke('audio-set-device', deviceId),
  setOutputMute:  (mute)     => ipcRenderer.invoke('audio-set-out-mute', mute),
  setInputMute:   (mute)     => ipcRenderer.invoke('audio-set-in-mute',  mute),
  getMuteStates:  ()         => ipcRenderer.invoke('audio-get-mute-states'),
  // Switch the OS default render (dataFlow 0) or capture (1) device. name
  // is matched against the registry's friendly-name (substring, both ways).
  setDefaultEndpoint: (dataFlow, name) => ipcRenderer.invoke('audio-set-default-endpoint', { dataFlow, name }),

  // Full app restart (relaunch main + renderer) — for changes that only
  // take effect at process start or at BrowserWindow creation.
  appRelaunch:    () => ipcRenderer.invoke('app-relaunch'),
  appQuit:        () => ipcRenderer.invoke('app-quit'),
  appVersion:     () => ipcRenderer.invoke('app-version'),
  processStats:   () => ipcRenderer.invoke('process-stats'),
  appMetrics:     () => ipcRenderer.invoke('app-metrics'),
  wifiStatus:     () => ipcRenderer.invoke('wifi-status'),
  wifiScan:       () => ipcRenderer.invoke('wifi-scan'),
  wifiConnect:    (ssid, password) => ipcRenderer.invoke('wifi-connect', { ssid, password }),
  galleryPath:    () => ipcRenderer.invoke('gallery-path'),
  docsPath:       () => ipcRenderer.invoke('docs-path'),
  downloadsPath:  () => ipcRenderer.invoke('downloads-path'),
  galleryList:    (subdir = '') => ipcRenderer.invoke('gallery-list',   subdir),
  docsList:       (subdir = '') => ipcRenderer.invoke('docs-list',      subdir),
  downloadsList:  (subdir = '') => ipcRenderer.invoke('downloads-list', subdir),
  docsWrite:      (rel, content) => ipcRenderer.invoke('docs-write', rel, content),
  shellOpenPath:  (abs) => ipcRenderer.invoke('shell-open-path', abs),
  openImageViewer:    (abs)   => ipcRenderer.invoke('open-image-viewer', abs),
  openContactSheet:   (paths) => ipcRenderer.invoke('open-contact-sheet', paths),
  clipboardCopyFiles: (paths) => ipcRenderer.invoke('clipboard-copy-files', paths),
  exploreMkdir:   (which, rel)  => ipcRenderer.invoke('explore-mkdir',  which, rel),
  exploreRename:  (oldAbs, newName) => ipcRenderer.invoke('explore-rename', oldAbs, newName),
  exploreDelete:  (abs) => ipcRenderer.invoke('explore-delete', abs),
  flushRam:        () => ipcRenderer.invoke('flush-ram'),

  // Set Windows power-scheme processor min/max state (used to throttle CPU
  // during zen mode and restore performance on resume).
  setPowerProfile: (opts) => ipcRenderer.invoke('set-power-profile', opts),

  openYoutube: () => ipcRenderer.invoke('open-youtube'),
  setYoutubeZenMode: (on) => ipcRenderer.invoke('set-youtube-zen-mode', on),

  onForceLeaveZen: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('force-leave-zen', handler);
    return () => ipcRenderer.removeListener('force-leave-zen', handler);
  },

  // Embedded BROWSER pane: live ad-block counter (popups are intercepted
  // in main's app-level web-contents-created handler). Push subscription
  // fires whenever the main process tallies a new block (throttled to 4 Hz).
  browserGetStats:   () => ipcRenderer.invoke('browser-get-stats'),
  browserResetStats: () => ipcRenderer.invoke('browser-reset-stats'),
  // Per-tab visit history (cumulative across the persistent session,
  // capped at 500 entries, debounce-flushed to userData JSON). Clear
  // wipes both memory + disk file.
  browserHistoryGet:   (limit = 100) => ipcRenderer.invoke('browser-history-get', limit),
  browserHistoryClear: () => ipcRenderer.invoke('browser-history-clear'),
  // Clear cache + browsing history + transient storage (service workers,
  // shader cache, …) while KEEPING cookies/localStorage/IndexedDB so
  // active sign-ins survive. Result reads as "cleared everything except
  // logins" to the user.
  browserClearData:    () => ipcRenderer.invoke('browser-clear-data'),
  browserSetReaderMode: (on) => ipcRenderer.invoke('browser-set-reader-mode', on),
  browserGetDarkMode:   () => ipcRenderer.invoke('browser-get-dark-mode'),
  browserSetDarkMode:   (on) => ipcRenderer.invoke('browser-set-dark-mode', on),
  browserSetZenMode:    (on) => ipcRenderer.invoke('browser-set-zen-mode', on),
  // CSS-injected opacity on the active BrowserView page + transparent BV
  // background so the zen dashboard underneath shows through. 1.0 =
  // fully opaque (default), 0.4 = 60% transparent. Mirrors what the
  // YouTube popout does via BrowserWindow.setOpacity, but for the
  // in-pane browser which has no native window-level opacity.
  browserSetOpacity:    (o) => ipcRenderer.invoke('browser-set-opacity', o),
  // Visualizer "mirror active video" — returns { id, name } of the
  // desktopCapturer source most likely showing the active video right
  // now (YT popout if open, else dashboard window, else first screen).
  // Renderer plugs `id` into chromeMediaSourceId for getUserMedia.
  visualizerGetVideoSource: () => ipcRenderer.invoke('visualizer-get-video-source'),
  // Full enumeration of windows + screens with thumbnails for the
  // source picker UI. Returns an array of { id, name, kind, thumbnail }.
  visualizerListSources:    () => ipcRenderer.invoke('visualizer-list-sources'),

  // Screencap — input-driven JPEG capture of the active mirror stream.
  // Main owns the powerMonitor poll; when input is detected anywhere
  // on the system it pushes 'screencap-trigger' and the renderer grabs
  // a frame + sends it back via screencapSave.
  screencapWatchStart: () => ipcRenderer.invoke('screencap-watch-start'),
  screencapWatchStop:  () => ipcRenderer.invoke('screencap-watch-stop'),
  screencapSave:       (dataUrl) => ipcRenderer.invoke('screencap-save', dataUrl),
  onScreencapTrigger:  (callback) => {
    const handler = () => callback();
    ipcRenderer.on('screencap-trigger', handler);
    return () => ipcRenderer.removeListener('screencap-trigger', handler);
  },

  // Screen record — continuous video capture of the mirror stream to
  // <gallery>/recordings/*.mkv. Renderer owns MediaRecorder + chunks
  // them to main via screenrecChunk; main appends to a write stream.
  screenrecStart: () => ipcRenderer.invoke('screenrec-start'),
  screenrecChunk: (id, bytes) => ipcRenderer.invoke('screenrec-chunk', id, bytes),
  screenrecStop:  (id) => ipcRenderer.invoke('screenrec-stop', id),

  // Snap-to-video processor — renderer ships a single Uint8Array blob
  // produced by canvas + MediaRecorder; main writes it to
  // gallery/recordings/ with a date-stamped, collision-free filename.
  processSnapsSave: (bytes, ext) => ipcRenderer.invoke('process-snaps-save', bytes, ext),

  // GPU-accelerated snap-to-video via bundled ffmpeg (ffmpeg-static).
  // ffmpegInfo() reports whether ffmpeg + NVENC are available so the
  // renderer can pick fast-path (ffmpeg) vs fallback (MediaRecorder).
  // processSnapsFfmpeg() runs the encode in main and writes the file.
  // onProcessSnapsProgress() streams { frame, total, fps, elapsedMs }.
  ffmpegInfo:          () => ipcRenderer.invoke('ffmpeg-info'),
  processSnapsFfmpeg:  (opts) => ipcRenderer.invoke('process-snaps-ffmpeg', opts),
  onProcessSnapsProgress: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on('process-snaps-progress', handler);
    return () => ipcRenderer.removeListener('process-snaps-progress', handler);
  },

  // Key capture — global keyboard observation (does not intercept).
  // Main spawns a PowerShell child polling GetAsyncKeyState and pushes
  // {vk, name, ts} on each fresh key-down edge. The renderer overlays
  // these on the recording canvas only (never on the visible DOM).
  keycaptureStart: () => ipcRenderer.invoke('keycapture-start'),
  keycaptureStop:  () => ipcRenderer.invoke('keycapture-stop'),
  onKeycapture:    (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on('keycapture-key', handler);
    return () => ipcRenderer.removeListener('keycapture-key', handler);
  },
  onBrowserStats: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on('browser-stats', handler);
    return () => ipcRenderer.removeListener('browser-stats', handler);
  },

  // BrowserView-backed tabs. Renderer drives state via these calls; main
  // owns the native views. browserTabBounds is sent every time the host
  // panel resizes so the view tracks our layout.
  browserTabCreate:   (url)        => ipcRenderer.invoke('browser-tab-create', url),
  browserTabClose:    (id)         => ipcRenderer.invoke('browser-tab-close', id),
  browserTabNavigate: (id, url)    => ipcRenderer.invoke('browser-tab-navigate', id, url),
  browserTabBack:     (id)         => ipcRenderer.invoke('browser-tab-back', id),
  browserTabForward:  (id)         => ipcRenderer.invoke('browser-tab-forward', id),
  browserTabReload:   (id)         => ipcRenderer.invoke('browser-tab-reload', id),
  browserTabReloadFresh: (id)      => ipcRenderer.invoke('browser-tab-reload-fresh', id),
  browserTabActivate: (id)         => ipcRenderer.invoke('browser-tab-activate', id),
  browserTabBounds:   (rect)       => ipcRenderer.invoke('browser-tab-bounds', rect),
  onBrowserTabEvent: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on('browser-tab-event', handler);
    return () => ipcRenderer.removeListener('browser-tab-event', handler);
  },

  // Scrape DuckDuckGo's HTML endpoint for clean web results. Main does
  // the fetch (CORS-free) and returns raw HTML; renderer parses.
  browserSearch: (query, kind, page) => ipcRenderer.invoke('browser-search', query, kind, page),

  // Popup → new tab. Main intercepts every window.open / target=_blank
  // path (both top-level and iframes) and pushes the URL back here. The
  // renderer responds by spawning a fresh tab on the BrowserView side.
  onBrowserNewTabRequest: (callback) => {
    const handler = (_e, url) => callback(url);
    ipcRenderer.on('browser-newtab-request', handler);
    return () => ipcRenderer.removeListener('browser-newtab-request', handler);
  },
});
