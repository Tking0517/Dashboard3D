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
});
