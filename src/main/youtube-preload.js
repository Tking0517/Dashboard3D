const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('youtubeHost', {
  toggleAlwaysOnTop: () => ipcRenderer.invoke('youtube-toggle-aot'),
});
