const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dash', {
  platform:   process.platform,
  systemInfo: () => ipcRenderer.invoke('system-info'),
  storageInfo: () => ipcRenderer.invoke('storage-info'),
  tempsInfo:   () => ipcRenderer.invoke('temps-info'),
  netInfo:     () => ipcRenderer.invoke('net-info'),
  diskInfo:    () => ipcRenderer.invoke('disk-info'),
  transfersInfo: () => ipcRenderer.invoke('transfers-info'),
  getConfig:   () => ipcRenderer.invoke('config-get'),
  setConfig:   (partial) => ipcRenderer.invoke('config-set', partial),
  configPath:  () => ipcRenderer.invoke('config-path'),
  toggleFullscreen: () => ipcRenderer.invoke('toggle-fullscreen'),
  azureAutoConfig:  () => ipcRenderer.invoke('azure-auto-config'),
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),

  // Push subscription: native WASAPI loopback levels from the main process.
  onAudioOutLevel: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on('audio-out-level', handler);
    return () => ipcRenderer.removeListener('audio-out-level', handler);
  },
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
  galleryPath:    () => ipcRenderer.invoke('gallery-path'),
  docsPath:       () => ipcRenderer.invoke('docs-path'),
  galleryList:    (subdir = '') => ipcRenderer.invoke('gallery-list', subdir),
  docsList:       (subdir = '') => ipcRenderer.invoke('docs-list',    subdir),
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
