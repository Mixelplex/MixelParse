'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
// Explicitly set update behaviour — download silently, install on next quit.
// This ensures users on a broken renderer still get fixes automatically.
autoUpdater.autoDownload        = true;
autoUpdater.autoInstallOnAppQuit = true;
const path = require('path');
const fs = require('fs');

// ─── Root path (repo root) ────────────────────────────────────────────────────
const ROOT = app.getAppPath();

// ─── Icon path ────────────────────────────────────────────────────────────────
// In packaged builds, assets live outside the asar in extraResources.
// In dev, they're relative to the repo root.
const ICON_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'assets', 'icon.ico')
  : path.join(ROOT, 'assets', 'icon.ico');

// ─── Paths ────────────────────────────────────────────────────────────────────
const CONFIG_PATH  = path.join(app.getPath('userData'), 'config.json');
const LOGPOS_PATH  = path.join(app.getPath('userData'), 'logPositions.json');
const FACTION_PATH = path.join(app.getPath('userData'), 'factionState.json');
const BASE_UI_PATH = path.join(app.getPath('userData'), 'baseUI.ini');
const BASE_CHAR_PATH = path.join(app.getPath('userData'), 'baseChar.ini');

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
    icon: ICON_PATH,
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
    icon: ICON_PATH,
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
    icon: ICON_PATH,
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
  tray = new Tray(fs.existsSync(ICON_PATH) ? ICON_PATH : nativeImage.createEmpty());
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
    {
      label: 'Check for Updates',
      click: () => {
        autoUpdater.checkForUpdatesAndNotify();
        mainWindow && mainWindow.webContents.send('updater-event', { type: 'checking' });
      }
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

// ── UI Copy Tool: base-UI workflow ───────────────────────────────────────────
// Returns { ui, char } booleans for which base files are set.
ipcMain.handle('ui:has-base', () => {
  try {
    return { ui: fs.existsSync(BASE_UI_PATH), char: fs.existsSync(BASE_CHAR_PATH) };
  } catch (e) {
    return { ui: false, char: false };
  }
});

// Set the base from a character: copies both UI_<Char>_P1999Green.ini and the
// character settings file <Char>_P1999Green.ini (friends list, hotbuttons,
// socials, combat abilities). The char file is optional — if absent we still
// set the UI base and report char:false.
ipcMain.handle('ui:set-base', (e, sourceChar) => {
  if (!config || !config.eqDir) return { ok: false, error: 'No EQ directory configured.' };
  const uiSrc   = path.join(config.eqDir, `UI_${sourceChar}_P1999Green.ini`);
  const charSrc = path.join(config.eqDir, `${sourceChar}_P1999Green.ini`);
  try {
    if (!fs.existsSync(uiSrc)) return { ok: false, error: `UI file not found: ${uiSrc}` };
    fs.copyFileSync(uiSrc, BASE_UI_PATH);
    let char = false;
    if (fs.existsSync(charSrc)) {
      fs.copyFileSync(charSrc, BASE_CHAR_PATH);
      char = true;
    } else {
      // No char file for this toon — clear any stale base so we don't ship a
      // mismatched friends/hotbutton file with the next copy.
      try { if (fs.existsSync(BASE_CHAR_PATH)) fs.unlinkSync(BASE_CHAR_PATH); } catch (_) {}
    }
    return { ok: true, char };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Set the base from an arbitrary picked UI .ini file. If the picked file is a
// UI_<Char>_P1999Green.ini, derive the sibling <Char>_P1999Green.ini from the
// same folder and store it too. If the picked file isn't a recognizable UI
// file, we still store it as the UI base and skip the char file.
ipcMain.handle('ui:set-base-from-path', (e, filePath) => {
  if (!filePath) return { ok: false, error: 'No file selected.' };
  try {
    if (!fs.existsSync(filePath)) return { ok: false, error: `File not found: ${filePath}` };
    fs.copyFileSync(filePath, BASE_UI_PATH);
    let char = false;
    const dir  = path.dirname(filePath);
    const base = path.basename(filePath);
    const m = base.match(/^UI_(.+)_P1999Green\.ini$/i);
    if (m) {
      const charSrc = path.join(dir, `${m[1]}_P1999Green.ini`);
      if (fs.existsSync(charSrc)) {
        fs.copyFileSync(charSrc, BASE_CHAR_PATH);
        char = true;
      } else {
        try { if (fs.existsSync(BASE_CHAR_PATH)) fs.unlinkSync(BASE_CHAR_PATH); } catch (_) {}
      }
    } else {
      try { if (fs.existsSync(BASE_CHAR_PATH)) fs.unlinkSync(BASE_CHAR_PATH); } catch (_) {}
    }
    return { ok: true, char };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Open a native picker for a UI .ini file; returns the chosen path or null.
ipcMain.handle('ui:browse-ini', async () => {
  const opts = {
    title: 'Select a UI .ini file',
    properties: ['openFile'],
    filters: [{ name: 'EQ UI ini', extensions: ['ini'] }],
  };
  if (config && config.eqDir) opts.defaultPath = config.eqDir;
  const parent = BrowserWindow.getFocusedWindow() || mainWindow;
  const result = await dialog.showOpenDialog(parent, opts);
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// Copy the stored base(s) to a new character name. Writes into a guaranteed-
// writable output folder (Documents/MixelParse/UIs) rather than the EQ dir,
// which is often under Program Files and blocks non-elevated writes (EPERM).
// Writes BOTH the UI layout file and, if a base char file was captured, the
// character settings file (friends list, hotbuttons, socials, abilities).
// The user then drags the generated file(s) into their EQ folder themselves.
ipcMain.handle('ui:copy-from-base', (e, targetChar) => {
  if (!fs.existsSync(BASE_UI_PATH)) return { ok: false, error: 'No base UI has been set yet.' };
  const cleanName = String(targetChar || '').trim().replace(/[<>:"/\\|?*]/g, '');
  if (!cleanName) return { ok: false, error: 'Enter a destination character name.' };
  try {
    const outDir = path.join(app.getPath('documents'), 'MixelParse', 'UIs');
    fs.mkdirSync(outDir, { recursive: true });

    const uiName  = `UI_${cleanName}_P1999Green.ini`;
    const uiDst   = path.join(outDir, uiName);
    fs.copyFileSync(BASE_UI_PATH, uiDst);

    const files = [uiName];
    let charDst = null;
    if (fs.existsSync(BASE_CHAR_PATH)) {
      const charName = `${cleanName}_P1999Green.ini`;
      charDst = path.join(outDir, charName);
      fs.copyFileSync(BASE_CHAR_PATH, charDst);
      files.push(charName);
    }

    return {
      ok: true,
      dst: uiDst,            // primary path used for "reveal"
      dir: outDir,
      files,                 // list of filenames written
      includedChar: !!charDst,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Reveal a file (or folder) in the OS file manager, highlighting it.
ipcMain.handle('ui:reveal', (e, targetPath) => {
  try {
    if (!targetPath) return { ok: false, error: 'No path provided.' };
    shell.showItemInFolder(targetPath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('updater:check', () => {
  autoUpdater.checkForUpdatesAndNotify();
});

ipcMain.handle('updater:install', () => {
  app.isQuitting = true;
  autoUpdater.quitAndInstall(false, true);
});

ipcMain.handle('app:get-version', () => app.getVersion());

// ─── Auto-updater events ──────────────────────────────────────────────────────
autoUpdater.on('update-available', (info) => {
  mainWindow && mainWindow.webContents.send('updater-event', { type: 'update-available', version: info.version });
});
autoUpdater.on('download-progress', (progress) => {
  mainWindow && mainWindow.webContents.send('updater-event', {
    type: 'download-progress',
    percent: progress.percent,
    transferred: progress.transferred,
    total: progress.total,
    bytesPerSecond: progress.bytesPerSecond
  });
});
autoUpdater.on('update-not-available', () => {
  mainWindow && mainWindow.webContents.send('updater-event', { type: 'up-to-date' });
});
autoUpdater.on('update-downloaded', (info) => {
  mainWindow && mainWindow.webContents.send('updater-event', { type: 'update-downloaded', version: info.version });
});
autoUpdater.on('error', (err) => {
  console.error('[Updater]', err.message);
  mainWindow && mainWindow.webContents.send('updater-event', { type: 'error', message: err.message });
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
