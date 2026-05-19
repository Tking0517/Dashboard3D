// BrowserView preload for the STREAM tab's hosted views (Discord, plus
// any future siblings). Runs with contextIsolation enabled and exposes
// a single bridge: __dash3dStreamBridge.notify(payload). The injected
// page-script (sent later via webContents.executeJavaScript) monkey-
// patches window.Notification to call this bridge whenever Discord
// fires a desktop notification, so the dashboard's CHAT pane can
// mirror DM/mention notifications without DOM-scraping the embed.
//
// Notification interception is a TOS-safe channel — it reads only what
// Chromium already exposes via the standard Web Notifications API. It
// does NOT see the full chat (Discord doesn't fire a notification for
// every message — only DMs/mentions when the tab is unfocused). For
// full chat mirroring we'd need DOM scraping, which Discord treats as
// a third-party-client TOS violation.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__dash3dStreamBridge', {
  notify(payload) {
    if (!payload || typeof payload !== 'object') return;
    // Drop into main via IPC — main relays to the dashboard renderer.
    try { ipcRenderer.send('stream:notification', payload); } catch {}
  },
});
