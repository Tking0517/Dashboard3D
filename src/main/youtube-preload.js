const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('youtubeHost', {
  toggleAlwaysOnTop: () => ipcRenderer.invoke('youtube-toggle-aot'),
});

// yt-client bridge — main process owns the yt-dlp binary + the search
// engines. Renderer is data-only.
contextBridge.exposeInMainWorld('yt', {
  search:        (query, opts) => ipcRenderer.invoke('yt:search', query, opts),
  searchGeneral: (query, opts) => ipcRenderer.invoke('yt:search-general', query, opts),
  getStream:     (idOrUrl)     => ipcRenderer.invoke('yt:get-stream', idOrUrl),
  getMetadata:   (idOrUrl)     => ipcRenderer.invoke('yt:get-metadata', idOrUrl),
});
