const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Preferences
  getPrefs: () => ipcRenderer.invoke('prefs:get'),
  setPrefs: (updates) => ipcRenderer.invoke('prefs:set', updates),

  // Devices
  listDevices: () => ipcRenderer.invoke('devices:list'),

  // Dialogs
  chooseFolder: (initialPath) => ipcRenderer.invoke('dialog:choose-folder', initialPath),

  // Recording
  startRecording: (payload) => ipcRenderer.invoke('recording:start', payload),
  stopRecording: () => ipcRenderer.invoke('recording:stop'),

  // Files
  renameFile: (oldPath, newName) => ipcRenderer.invoke('file:rename', { oldPath, newName }),
  revealFile: (filePath) => ipcRenderer.invoke('file:reveal', filePath),
});

// Secure bridge for system audio recorder
contextBridge.exposeInMainWorld('recorderAPI', {
  start: () => ipcRenderer.invoke('recorder:start'),
  stop: () => ipcRenderer.invoke('recorder:stop'),
  loopback: {
    start: () => ipcRenderer.invoke('loopback:start'),
    stop: () => ipcRenderer.invoke('loopback:stop'),
  },
  mic: {
    start: () => ipcRenderer.invoke('mic:start'),
    stop: () => ipcRenderer.invoke('mic:stop'),
  },
});
