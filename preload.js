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
