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

  // Web browser pane.
  installWebAdblock: (partition) => ipcRenderer.invoke('web-install-adblock', partition),
  // Use Chromium's auto-dark-mode emulation on the webview's embedded
  // webContents (passed in by id from <webview>.getWebContentsId()).
  forceWebDark: (contentsId) => ipcRenderer.invoke('web-force-dark', contentsId),
  onWebRequestBlocked: (callback) => {
    const handler = (_e, host) => callback(host);
    ipcRenderer.on('web-request-blocked', handler);
    return () => ipcRenderer.removeListener('web-request-blocked', handler);
  },

  // Full app restart (relaunch main + renderer) — for changes that only
  // take effect at process start or at BrowserWindow creation.
  appRelaunch:    () => ipcRenderer.invoke('app-relaunch'),
  appQuit:        () => ipcRenderer.invoke('app-quit'),
  setAirplaneMode: (on) => ipcRenderer.invoke('airplane-mode', !!on),

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
});
