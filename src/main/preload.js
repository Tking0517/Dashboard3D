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
});
