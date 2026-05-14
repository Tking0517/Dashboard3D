const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('youtubeHost', {
  toggleAlwaysOnTop: () => ipcRenderer.invoke('youtube-toggle-aot'),
  // Set the YT window opacity (0.1–1.0). Used by the OPAQUE / SEE-THROUGH
  // buttons in the chrome — the latter dims the window to 0.4 so the
  // zen-mode dashboard underneath shows through the video.
  setOpacity: (o) => ipcRenderer.invoke('youtube-set-opacity', o),
});

// yt-client bridge — main process owns the yt-dlp binary + the search
// engines. Renderer is data-only.
contextBridge.exposeInMainWorld('yt', {
  search:        (query, opts) => ipcRenderer.invoke('yt:search', query, opts),
  searchGeneral: (query, opts) => ipcRenderer.invoke('yt:search-general', query, opts),
  getStream:     (idOrUrl)     => ipcRenderer.invoke('yt:get-stream', idOrUrl),
  getMetadata:   (idOrUrl)     => ipcRenderer.invoke('yt:get-metadata', idOrUrl),
});
