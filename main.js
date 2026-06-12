'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');

// ─── Root path (repo root) ────────────────────────────────────────────────────
const ROOT = app.getAppPath();

// ─── Paths ────────────────────────────────────────────────────────────────────
const CONFIG_PATH  = path.join(app.getPath('userData'), 'config.json');
const LOGPOS_PATH  = path.join(app.getPath('userData'), 'logPositions.json');
const FACTION_PATH = path.join(app.getPath('userData'), 'factionState.json');

// ─── State ────────────────────────────────────────────────────────────────────
let mainWindow    = null;
let adminWindow   = null;
let setupWindow   = null;
let tray          = null;
let config        = null;
let watcherModule = null;

// ─── Config ───────────────────────────────────────────────────────────────────
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      return true;
    }
  } catch (e) {
    console.error('[Config] Failed to load:', e.message);
  }
  return false;
}

function saveConfig(data) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf8');
    config = data;
    return true;
  } catch (e) {
    console.error('[Config] Failed to save:', e.message);
    return false;
  }
}

// ─── Auto-detect EQ paths ─────────────────────────────────────────────────────
function detectEQPaths() {
  const candidates = [
    'C:\\Program Files (x86)\\Sony\\EverQuest',
    'C:\\Program Files\\Sony\\EverQuest',
    'C:\\EverQuest',
    'C:\\Games\\EverQuest',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return {
        eqDir:     p,
        logDir:    path.join(p, 'Logs'),
        notesFile: path.join(p, 'notes.txt'),
      };
    }
  }
  return { eqDir: '', logDir: '', notesFile: '' };
}

// ─── Setup Window ─────────────────────────────────────────────────────────────
function createSetupWindow() {
  setupWindow = new BrowserWindow({
    width: 620,
    height: 520,
    resizable: false,
    center: true,
    title: 'MixelParse — Setup',
    icon: path.join(ROOT, 'assets', 'icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    autoHideMenuBar: true,
  });
  setupWindow.loadFile(path.join(ROOT, 'src', 'setup.html'));
  setupWindow.on('closed', () => { setupWindow = null; });
}

// ─── Main Window ──────────────────────────────────────────────────────────────
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'MixelParse',
    icon: path.join(ROOT, 'assets', 'icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    autoHideMenuBar: true,
    show: false,
  });

  mainWindow.loadFile(path.join(ROOT, 'src', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.on('did-finish-load', () => {
    // Re-broadcast full watcher state after renderer loads — startup events may have fired before it was ready
    if (watcherModule && watcherModule.sendFullSnapshot) {
      setTimeout(() => watcherModule.sendFullSnapshot(), 500);
    }
  });

  mainWindow.on('minimize', (e) => {
    e.preventDefault();
    mainWindow.hide();
    tray && tray.displayBalloon &&
      tray.displayBalloon({ title: 'MixelParse', content: 'Running in background. Click tray icon to restore.' });
  });

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── Admin Window ─────────────────────────────────────────────────────────────
function createAdminWindow() {
  if (adminWindow) {
    adminWindow.focus();
    return;
  }
  adminWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'MixelParse — Admin',
    icon: path.join(ROOT, 'assets', 'icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    autoHideMenuBar: true,
    parent: mainWindow,
  });
  adminWindow.loadFile(path.join(ROOT, 'src', 'admin.html'));
  adminWindow.on('closed', () => { adminWindow = null; });
}

// ─── Tray ─────────────────────────────────────────────────────────────────────
function createTray() {
  const iconPath = path.join(ROOT, 'assets', 'icon.ico');
  let trayIcon;
  if (fs.existsSync(iconPath)) {
    trayIcon = iconPath;
  } else {
    trayIcon = nativeImage.createEmpty();
  }
  tray = new Tray(trayIcon);
  tray.setToolTip('MixelParse');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show MixelParse',
      click: () => { mainWindow && mainWindow.show(); }
    },
    {
      label: 'Admin Panel',
      click: () => { createAdminWindow(); }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.focus() : mainWindow.show();
    }
  });
}

// ─── Watcher ──────────────────────────────────────────────────────────────────
function startWatcher() {
  if (!config) return;
  try {
    watcherModule = require('./ipc/watcher.js');
    watcherModule.start({
      config,
      logPosPath:  LOGPOS_PATH,
      factionPath: FACTION_PATH,
      onMessage: (type, payload) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('watcher-event', { type, ...payload });
        }
      }
    });
    console.log('[Watcher] Started');
  } catch (e) {
    console.error('[Watcher] Failed to start:', e.message);
  }
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('setup:detect-paths', () => detectEQPaths());

ipcMain.handle('setup:browse-dir', async (e, defaultPath) => {
  const result = await dialog.showOpenDialog(setupWindow || mainWindow, {
    properties: ['openDirectory'],
    defaultPath: defaultPath || 'C:\\',
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('setup:browse-file', async (e, defaultPath) => {
  const result = await dialog.showOpenDialog(setupWindow || mainWindow, {
    properties: ['openFile'],
    defaultPath: defaultPath || 'C:\\',
    filters: [{ name: 'Text Files', extensions: ['txt'] }],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('setup:save', (e, data) => {
  const ok = saveConfig(data);
  if (ok) {
    createMainWindow();
    createTray();
    startWatcher();
    if (setupWindow) setupWindow.close();
  }
  return ok;
});

ipcMain.handle('config:get',    ()        => config);
ipcMain.handle('config:save',   (e, data) => saveConfig(data));
ipcMain.handle('admin:open',    ()        => { createAdminWindow(); });

ipcMain.handle('watcher:command', (e, cmd, args) => {
  if (watcherModule && watcherModule.command) {
    watcherModule.command(cmd, args);
  }
});

ipcMain.handle('ui:list', () => {
  if (!config || !config.eqDir) return [];
  try {
    const files = fs.readdirSync(config.eqDir);
    return files
      .filter(f => /^UI_.+_P1999Green\.ini$/i.test(f))
      .map(f => ({
        filename: f,
        charName: f.replace(/^UI_/i, '').replace(/_P1999Green\.ini$/i, ''),
      }));
  } catch (e) {
    return [];
  }
});

ipcMain.handle('ui:copy', (e, sourceChar, targetChar) => {
  if (!config || !config.eqDir) return { ok: false, error: 'No EQ directory configured.' };
  const src = path.join(config.eqDir, `UI_${sourceChar}_P1999Green.ini`);
  const dst = path.join(config.eqDir, `UI_${targetChar}_P1999Green.ini`);
  try {
    if (!fs.existsSync(src)) return { ok: false, error: `Source file not found: ${src}` };
    fs.copyFileSync(src, dst);
    return { ok: true, dst };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('updater:check', () => {
  autoUpdater.checkForUpdatesAndNotify();
});

// ─── Auto-updater events ──────────────────────────────────────────────────────
autoUpdater.on('update-available', () => {
  mainWindow && mainWindow.webContents.send('updater-event', { type: 'update-available' });
});
autoUpdater.on('update-downloaded', () => {
  mainWindow && mainWindow.webContents.send('updater-event', { type: 'update-downloaded' });
});
autoUpdater.on('error', (err) => {
  console.error('[Updater]', err.message);
});

// ─── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  const hasConfig = loadConfig();
  if (!hasConfig) {
    createSetupWindow();
  } else {
    createMainWindow();
    createTray();
    startWatcher();
    setTimeout(() => autoUpdater.checkForUpdatesAndNotify(), 3000);
  }
});

app.on('window-all-closed', (e) => {
  e.preventDefault(); // Keep alive in tray
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (watcherModule && watcherModule.stop) watcherModule.stop();
});

app.on('activate', () => {
  if (mainWindow) mainWindow.show();
});
