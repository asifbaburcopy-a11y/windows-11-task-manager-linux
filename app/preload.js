'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tm', {
  initial: () => ipcRenderer.invoke('sys:initial'),
  onSnapshot: (cb) => {
    const h = (_e, snap) => cb(snap);
    ipcRenderer.on('sys:snapshot', h);
    return () => ipcRenderer.removeListener('sys:snapshot', h);
  },
  setPaused: (p) => ipcRenderer.send('sys:paused', p),
  kill: (pid, force) => ipcRenderer.invoke('proc:kill', pid, force),
  services: () => ipcRenderer.invoke('sys:services'),
  serviceAction: (unit, action) => ipcRenderer.invoke('svc:action', unit, action),
  startup: () => ipcRenderer.invoke('sys:startup'),
  startupSet: (base, enable) => ipcRenderer.invoke('startup:set', base, enable),
  appHistory: () => ipcRenderer.invoke('sys:appHistory'),
  users: () => ipcRenderer.invoke('sys:users'),
  icon: (name) => ipcRenderer.invoke('proc:icon', name),
  runTask: (cmd) => ipcRenderer.invoke('run:task', cmd),
  minimize: () => ipcRenderer.send('win:minimize'),
  maximize: () => ipcRenderer.send('win:maximize'),
  close: () => ipcRenderer.send('win:close'),
  isMaximized: () => ipcRenderer.invoke('win:isMaximized'),
  onMaximized: (cb) => {
    const h = (_e, m) => cb(m);
    ipcRenderer.on('win:maximized', h);
    return () => ipcRenderer.removeListener('win:maximized', h);
  },
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
});
