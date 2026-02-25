const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('organizerApi', {
  pickFolder: () => ipcRenderer.invoke('dialog:pick-folder'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (payload) => ipcRenderer.invoke('settings:save', payload),
  start: (payload) => ipcRenderer.invoke('organizer:start', payload),
  quickStart: () => ipcRenderer.invoke('organizer:quick-start'),
  stop: () => ipcRenderer.invoke('organizer:stop'),
  isRunning: () => ipcRenderer.invoke('organizer:is-running'),
  onLog: (handler) => {
    const fn = (_event, data) => handler(data);
    ipcRenderer.on('organizer:log', fn);
    return () => ipcRenderer.removeListener('organizer:log', fn);
  },
  onStatus: (handler) => {
    const fn = (_event, data) => handler(data);
    ipcRenderer.on('organizer:status', fn);
    return () => ipcRenderer.removeListener('organizer:status', fn);
  },
});
