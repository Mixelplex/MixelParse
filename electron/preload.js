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
  hasBaseUI:        ()                 => ipcRenderer.invoke('ui:has-base'),
  setBaseUI:        (sourceChar)       => ipcRenderer.invoke('ui:set-base', sourceChar),
  setBaseUIFromPath:(filePath)         => ipcRenderer.invoke('ui:set-base-from-path', filePath),
  browseIniFile:    ()                 => ipcRenderer.invoke('ui:browse-ini'),
  copyFromBaseUI:   (targetChar)       => ipcRenderer.invoke('ui:copy-from-base', targetChar),
  revealPath:       (targetPath)       => ipcRenderer.invoke('ui:reveal', targetPath),

  // ── Auto-updater ───────────────────────────────────────────────────────────
  getVersion:    ()         => ipcRenderer.invoke('app:get-version'),
  checkUpdates:  ()         => ipcRenderer.invoke('updater:check'),
  installUpdate: ()         => ipcRenderer.invoke('updater:install'),
  onUpdaterEvent: (cb)     => {
    ipcRenderer.on('updater-event', (e, data) => cb(data));
  },

  // ── Utility ────────────────────────────────────────────────────────────────
  isElectron: true,
  platform: process.platform,
  bridgeVersion: 'v35-uicopy3',
});
