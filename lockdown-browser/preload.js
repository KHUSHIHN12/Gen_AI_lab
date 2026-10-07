'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lockdownAPI', {
  isElectron: true,
  version: '1.0.0',
  onViolation: (cb) => ipcRenderer.on('violation', (_e, v) => cb(v)),
  allowExit: () => ipcRenderer.send('allow-exit'),
  quit: () => ipcRenderer.send('quit'),
});
contextBridge.exposeInMainWorld('launcher', { start: (url) => ipcRenderer.send('launch', url) });
