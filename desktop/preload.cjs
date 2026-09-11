// preload.cjs - the only bridge between the page and Electron.
// contextIsolation is on, so the page sees exactly what is listed here and nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('relay', {
  isDesktop: true,
  // Fired by the File > Settings… menu item.
  onOpenSettings: (fn) => ipcRenderer.on('relay:open-settings', () => fn()),
  // Boot progress, for the splash window only. One string at a time, no payload.
  onBoot: (fn) => ipcRenderer.on('relay:boot', (_e, text) => fn(String(text || ''))),
});
