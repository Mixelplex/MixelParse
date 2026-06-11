'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Expose a safe, explicit API to renderer processes
// Nothing from Node.js leaks into the page — only these methods
contextBridge.exposeInMainWorld('MixelParseApp', {

  // ── Setup ──────────────────────────────────────────────────────────────────
  detectPaths:  ()         => ipcRenderer.invoke('setup:detect-paths'),
  browseDir:    (def)      => ipcRenderer.invoke('setup:browse-dir', def),
  browseFile:   (def)      => ipcRenderer.invoke('setup:browse-file', def),
  saveSetup:    (data)     => ipcRenderer.invoke('setup:save', data),

  // ── Config ─────────────────────────────────────────────────────────────────
  getConfig:    ()         => ipcRenderer.invoke('config:get'),
  saveConfig:   (data)     => ipcRenderer.invoke('config:save', data),

  // ── Windows ────────────────────────────────────────────────────────────────
  openAdmin:    ()         => ipcRenderer.invoke('admin:open'),

  // ── Watcher events (main → renderer) ──────────────────────────────────────
  onWatcherEvent: (cb)     => {
    ipcRenderer.on('watcher-event', (e, data) => cb(data));
  },
  offWatcherEvent: ()      => {
    ipcRenderer.removeAllListeners('watcher-event');
  },

  // ── Watcher commands (renderer → main) ────────────────────────────────────
  watcherCommand: (cmd, args) => ipcRenderer.invoke('watcher:command', cmd, args),

  // ── UI Copy Tool ───────────────────────────────────────────────────────────
  listUIFiles:  ()                     => ipcRenderer.invoke('ui:list'),
  copyUI:       (src, dst)             => ipcRenderer.invoke('ui:copy', src, dst),

  // ── Auto-updater ───────────────────────────────────────────────────────────
  checkUpdates: ()         => ipcRenderer.invoke('updater:check'),
  onUpdaterEvent: (cb)     => {
    ipcRenderer.on('updater-event', (e, data) => cb(data));
  },

  // ── Utility ────────────────────────────────────────────────────────────────
  isElectron: true,
  platform: process.platform,
});
