'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Expose a safe, explicit API to renderer processes
// Nothing from Node.js leaks into the page — only these methods
contextBridge.exposeInMainWorld('MixelParseApp', {

  // ── Machine identity (kill count source tagging) ───────────────────────────
  // NOTE: must come from the main process — require('os') is unavailable in
  // sandboxed preloads and would kill the entire bridge.
  hostname: ipcRenderer.sendSync('app:hostname'),

  // ── Setup ──────────────────────────────────────────────────────────────────
  // Farm Targets wiki crawl (v1.3.5) — sandbox-safe, ipcRenderer only
  farmCrawl:      (pages) => ipcRenderer.invoke('farm:crawl', pages),
  rotateLogs:     (opts)  => ipcRenderer.invoke('logs:rotate', opts),
  onFarmProgress: (cb)    => ipcRenderer.on('farm:progress', (e, p) => cb(p)),

  detectPaths:  ()         => ipcRenderer.invoke('setup:detect-paths'),
  browseDir:    (def)      => ipcRenderer.invoke('setup:browse-dir', def),
  browseFile:   (def)      => ipcRenderer.invoke('setup:browse-file', def),
  saveSetup:    (data)     => ipcRenderer.invoke('setup:save', data),

  // ── Config ─────────────────────────────────────────────────────────────────
  getConfig:    ()         => ipcRenderer.invoke('config:get'),
  saveConfig:   (data)     => ipcRenderer.invoke('config:save', data),

  // ── Windows ────────────────────────────────────────────────────────────────
  openAdmin:    ()         => ipcRenderer.invoke('admin:open'),

  // ── ToD popup screen-priority (main window float-on-top while pending) ──────
  todSurface:   ()         => ipcRenderer.invoke('tod:surface'),
  todRelease:   ()         => ipcRenderer.invoke('tod:release'),

  // ── Session overlay window ─────────────────────────────────────────────────
  toggleSession:      ()        => ipcRenderer.invoke('session:toggle'),
  closeSession:       ()        => ipcRenderer.invoke('session:close'),
  minimizeSession:    ()        => ipcRenderer.invoke('session:minimize'),
  resizeSession:      (h)       => ipcRenderer.send('session:resize', h),
  pushSessionState:   (state)   => ipcRenderer.send('session:push-state', state),
  onSessionState:     (cb)      => ipcRenderer.on('session-state',      (_, d) => cb(d)),
  sendSessionCommand: (cmd)     => ipcRenderer.send('session:command', cmd),
  onSessionCommand:   (cb)      => ipcRenderer.on('session-command',   (_, d) => cb(d)),
  onSessionWindowReady: (cb)    => ipcRenderer.on('session-window-ready', () => cb()),
  onSessionWindowClosed: (cb)   => ipcRenderer.on('session-window-closed', () => cb()),

  // ── Session report window ──────────────────────────────────────────────────
  onReportData:       (cb)      => ipcRenderer.on('report-data', (_, d) => cb(d)),

  // ── Map window ─────────────────────────────────────────────────────────────
  toggleMap:          ()            => ipcRenderer.invoke('map:toggle'),
  closeMap:           ()            => ipcRenderer.invoke('map:close'),
  minimizeMap:        ()            => ipcRenderer.invoke('map:minimize'),
  listMapFiles:       ()            => ipcRenderer.invoke('map:list-files'),
  readMapFile:        (filename)    => ipcRenderer.invoke('map:read-file', filename),
  onMapState:         (cb)          => ipcRenderer.on('map-state',        (_, d) => cb(d)),
  onMapLocUpdate:     (cb)          => ipcRenderer.on('map-loc-update',   (_, d) => cb(d)),
  onMapWindowReady:   (cb)          => ipcRenderer.on('map-window-ready', () => cb()),
  onMapWindowClosed:  (cb)          => ipcRenderer.on('map-window-closed', () => cb()),
  sendMapCommand:     (cmd)         => ipcRenderer.send('map:command', cmd),
  onMapCommand:       (cb)          => ipcRenderer.on('map-command', (_, d) => cb(d)),

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
