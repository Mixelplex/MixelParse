'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeImage, net } = require('electron');
const { autoUpdater } = require('electron-updater');
// Explicitly set update behaviour — download silently, install on next quit.
// This ensures users on a broken renderer still get fixes automatically.
autoUpdater.autoDownload        = true;
autoUpdater.autoInstallOnAppQuit = true;
const path = require('path');
const fs = require('fs');
const os = require('os');
const { StringDecoder } = require('string_decoder');

// Machine identity for multi-machine kill count tagging. Synchronous because
// preload exposes it as a constant at bridge setup.
ipcMain.on('app:hostname', (e) => { e.returnValue = os.hostname(); });

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
let sessionWindow = null;
let reportWindow  = null;
let mapWindow     = null;
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

  // Open external links (wiki, etc.) in the user's default browser rather than
  // an uncontrolled in-app Chromium popup.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });

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

// ─── Session Overlay Window ───────────────────────────────────────────────────
function createSessionWindow() {
  if (sessionWindow && !sessionWindow.isDestroyed()) {
    sessionWindow.show();
    // Re-assert overlay level — some full-screen apps demote it on focus change
    sessionWindow.setAlwaysOnTop(true, 'screen-saver');
    return;
  }
  sessionWindow = new BrowserWindow({
    width:     390,
    height:    600,
    minWidth:  300,
    minHeight: 260,
    resizable: true,
    frame:     false,
    alwaysOnTop: true,
    skipTaskbar: false,
    title: 'Session — MixelParse',
    icon: ICON_PATH,
    backgroundColor: '#ede6d6',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // 'screen-saver' level keeps the overlay above full-screen and borderless-
  // windowed EQ — the default alwaysOnTop level gets buried under full-screen apps.
  sessionWindow.setAlwaysOnTop(true, 'screen-saver');

  // Windows demotes alwaysOnTop level across minimize/restore — re-assert it
  sessionWindow.on('restore', () => {
    if (sessionWindow && !sessionWindow.isDestroyed()) {
      sessionWindow.setAlwaysOnTop(true, 'screen-saver');
    }
  });

  sessionWindow.loadFile(path.join(ROOT, 'src', 'session.html'));
  // When session window is ready, ask main window to push current state
  sessionWindow.webContents.once('dom-ready', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('session-window-ready');
    }
  });
  sessionWindow.on('closed', () => {
    sessionWindow = null;
    // Notify main window the session overlay closed
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('session-window-closed');
    }
  });
}

// ─── Map Window ───────────────────────────────────────────────────────────────
function createMapWindow() {
  if (mapWindow && !mapWindow.isDestroyed()) {
    mapWindow.show();
    mapWindow.setAlwaysOnTop(true, 'screen-saver');
    // Re-trigger state push so map gets current data on re-show
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('map-window-ready');
    }
    return;
  }
  mapWindow = new BrowserWindow({
    width:     560,
    height:    600,
    minWidth:  320,
    minHeight: 320,
    resizable: true,
    frame:     false,
    alwaysOnTop: true,
    skipTaskbar: false,
    title: 'Map — MixelParse',
    icon: ICON_PATH,
    backgroundColor: '#1a1a24',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  mapWindow.setAlwaysOnTop(true, 'screen-saver');
  // Windows demotes alwaysOnTop level across minimize/restore — re-assert it
  mapWindow.on('restore', () => {
    if (mapWindow && !mapWindow.isDestroyed()) {
      mapWindow.setAlwaysOnTop(true, 'screen-saver');
    }
  });
  mapWindow.loadFile(path.join(ROOT, 'src', 'map.html'));
  mapWindow.webContents.once('dom-ready', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('map-window-ready');
    }
  });
  mapWindow.on('closed', () => {
    mapWindow = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('map-window-closed');
    }
  });
}


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
        // Forward locUpdate directly to map window for real-time player position
        if (type === 'locUpdate' && mapWindow && !mapWindow.isDestroyed()) {
          mapWindow.webContents.send('map-loc-update', payload);
        }
      }
    });
    console.log('[Watcher] Started');
  } catch (e) {
    console.error('[Watcher] Failed to start:', e.message);
  }
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

// ── EQ log rotation (v1.3.5) ────────────────────────────────────────────────
// Agreed spec (2026-07-05): automatic + manual, and NEVER lose data.
// Guarantees: rename-only (no truncation/deletion code path exists); locked
// files skip cleanly and retry next cycle; collision-proof .old naming means
// an existing archive can never be overwritten.
// Auto: on launch (+30s) and every 6h — rotates logs ≥ 250 MB that have been
// idle ≥ 10 min (never mid-farm). Manual button uses a 50 MB threshold, no
// idle requirement (a file EQ holds open just fails the rename harmlessly).
// The kill-count scanner reads .old archives too (see watcher.js), so a full
// historic re-import still sees everything ever logged.
function rotateEqLogs(minMB, idleMinutes) {
  const threshold = (typeof minMB === 'number' && minMB >= 0) ? minMB : 250;
  const idleMs = (typeof idleMinutes === 'number' ? idleMinutes : 0) * 60000;
  const out = { rotated: [], skipped: [], errors: [], threshold };
  const dir = config && config.logDir;
  if (!dir || !fs.existsSync(dir)) { out.errors.push('EQ log directory not configured (run Setup)'); return out; }
  const now = Date.now();
  const d = new Date();
  const ym = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  for (const f of fs.readdirSync(dir)) {
    if (!/^eqlog_.+\.txt$/i.test(f)) continue;
    const fp = path.join(dir, f);
    let st; try { st = fs.statSync(fp); } catch { continue; }
    const mb = st.size / 1048576;
    if (mb < threshold) { out.skipped.push({ file: f, mb: +mb.toFixed(1), reason: 'under ' + threshold + ' MB' }); continue; }
    if (idleMs && (now - st.mtimeMs) < idleMs) { out.skipped.push({ file: f, mb: +mb.toFixed(1), reason: 'active in last ' + idleMinutes + ' min' }); continue; }
    let target = fp.replace(/\.txt$/i, '.' + ym + '.old');
    let n = 2;
    while (fs.existsSync(target)) target = fp.replace(/\.txt$/i, '.' + ym + '-' + (n++) + '.old');
    try {
      fs.renameSync(fp, target);
      out.rotated.push({ file: f, mb: +mb.toFixed(1), to: path.basename(target) });
    } catch (e) {
      out.errors.push(f + ': ' + ((e.code === 'EBUSY' || e.code === 'EPERM')
        ? 'file in use — will retry next cycle (or log out and use the manual button)'
        : (e.message || String(e))));
    }
  }
  return out;
}
ipcMain.handle('logs:rotate', (e, opts) => rotateEqLogs((opts && opts.minMB) != null ? opts.minMB : 50, 0));

function autoRotateLogs() {
  try {
    const r = rotateEqLogs(250, 10);
    for (const x of r.rotated) {
      console.log('[LOGROTATE] ' + x.file + ' (' + x.mb + ' MB) -> ' + x.to);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('watcher-event', { type: 'logRotated', file: x.file, mb: x.mb, to: x.to });
      }
    }
  } catch (e) { console.error('[LOGROTATE]', e && e.message || e); }
}
setTimeout(autoRotateLogs, 30000);
setInterval(autoRotateLogs, 6 * 3600 * 1000);

// ── Farm Targets wiki crawler (v1.3.5) ──────────────────────────────────────
// Fetches P99 wiki pages from the main process (no CORS). Parsing happens in
// the renderer; this only downloads and trims. Polite: sequential, 1 req/sec.
// Uses Electron's net module (Chromium network stack) instead of Node's https.
// The P99 wiki serves an incomplete cert chain (leaf without the intermediate);
// Node https rejects it with UNABLE_TO_VERIFY_LEAF_SIGNATURE ("unable to verify
// the first certificate"), while Chromium fetches the missing intermediate via
// AIA the same way a browser does. net.request also follows redirects natively
// (redirect:'follow'), so the manual hop loop is gone. StringDecoder keeps
// multibyte UTF-8 intact across chunk boundaries (parity with setEncoding).
function ftFetchPage(pageName){
  return new Promise((resolve) => {
    const url = 'https://wiki.project1999.com/' + encodeURI(pageName.replace(/ /g, '_'));
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; resolve(v); };

    let req;
    try {
      req = net.request({ method: 'GET', url, redirect: 'follow' });
    } catch (err) {
      return done({ page: pageName, ok: false, error: String(err && err.message || err) });
    }
    req.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
    req.setHeader('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
    req.setHeader('Accept-Language', 'en-US,en;q=0.9');

    const timer = setTimeout(() => { try { req.abort(); } catch {} done({ page: pageName, ok: false, error: 'timeout' }); }, 15000);

    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        clearTimeout(timer);
        try { req.abort(); } catch {}
        return done({ page: pageName, ok: false, error: 'HTTP ' + res.statusCode });
      }
      const decoder = new StringDecoder('utf8');
      let body = '';
      res.on('data', (c) => {
        body += decoder.write(c);
        if (body.length > 800000) {
          clearTimeout(timer);
          try { req.abort(); } catch {}
          done({ page: pageName, ok: true, html: body.slice(0, 800000) });
        }
      });
      res.on('end', () => { body += decoder.end(); clearTimeout(timer); done({ page: pageName, ok: true, html: body.slice(0, 800000) }); });
      res.on('error', (err) => { clearTimeout(timer); done({ page: pageName, ok: false, error: String(err && err.message || err) }); });
    });
    req.on('error', (err) => { clearTimeout(timer); done({ page: pageName, ok: false, error: String(err && err.message || err) }); });
    req.on('abort', () => { clearTimeout(timer); done({ page: pageName, ok: false, error: 'aborted' }); });
    req.end();
  });
}

ipcMain.handle('farm:crawl', async (e, pages) => {
  const results = [];
  const list = Array.isArray(pages) ? pages.slice(0, 205) : [];  // 200 targets + Removed Items + 3 skill pages
  for (let i = 0; i < list.length; i++) {
    const r = await ftFetchPage(list[i]);
    results.push(r);
    try { e.sender.send('farm:progress', { done: i + 1, total: list.length, page: list[i], ok: r.ok }); } catch {}
    if (i < list.length - 1) await new Promise((res) => setTimeout(res, 1000)); // 1 req/sec
  }
  return results;
});

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

// ToD popup screen-priority: float the main window above full-screen EQ while a
// /note ToD prompt is pending, without stealing keyboard focus. Released on handle.
ipcMain.handle('tod:surface', () => {
  if(!mainWindow) return;
  if(mainWindow.isMinimized()) mainWindow.restore();
  if(!mainWindow.isVisible()) mainWindow.showInactive();
  mainWindow.setAlwaysOnTop(true, 'screen-saver');   // same level sessionWindow/mapWindow use
  try { mainWindow.flashFrame(true); } catch(e){}
});
ipcMain.handle('tod:release', () => {
  if(!mainWindow) return;
  mainWindow.setAlwaysOnTop(false);
  try { mainWindow.flashFrame(false); } catch(e){}
});

// ── Session overlay ──────────────────────────────────────────────────────────
ipcMain.handle('session:toggle', () => {
  if (sessionWindow && !sessionWindow.isDestroyed()) {
    if (sessionWindow.isVisible()) {
      sessionWindow.hide();
    } else {
      sessionWindow.show();
      sessionWindow.setAlwaysOnTop(true, 'screen-saver');
      // dom-ready won't fire again on re-show — signal main window to push fresh state
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('session-window-ready');
      }
    }
  } else {
    createSessionWindow();
  }
});
ipcMain.handle('session:close', () => {
  if (sessionWindow && !sessionWindow.isDestroyed()) sessionWindow.close();
});
ipcMain.handle('session:minimize', () => {
  if (sessionWindow && !sessionWindow.isDestroyed()) sessionWindow.minimize();
});
// Main window pushes session state → session window renders it
ipcMain.on('session:push-state', (event, state) => {
  if (sessionWindow && !sessionWindow.isDestroyed()) {
    sessionWindow.webContents.send('session-state', state);
  }
  // Map window gets the same state (uses spawnPins, spawnTimers, zoneShortname)
  if (mapWindow && !mapWindow.isDestroyed()) {
    mapWindow.webContents.send('map-state', state);
  }
});

// ── Map window IPC ───────────────────────────────────────────────────────────
// Map window → main window (save/select/delete camp views; main window owns Supabase auth)
ipcMain.on('map:command', (event, cmd) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('map-command', cmd);
  }
});

ipcMain.handle('map:toggle', () => {
  if (mapWindow && !mapWindow.isDestroyed()) {
    if (mapWindow.isVisible()) {
      mapWindow.hide();
    } else {
      mapWindow.show();
      mapWindow.setAlwaysOnTop(true, 'screen-saver');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('map-window-ready');
      }
    }
  } else {
    createMapWindow();
  }
});

ipcMain.handle('map:close', () => {
  if (mapWindow && !mapWindow.isDestroyed()) mapWindow.close();
});
ipcMain.handle('map:minimize', () => {
  if (mapWindow && !mapWindow.isDestroyed()) mapWindow.minimize();
});

ipcMain.handle('map:list-files', () => {
  if (!config || !config.eqDir) return { error: 'No EQ directory configured.' };
  try {
    const mapsDir = path.join(config.eqDir, 'maps');
    if (!fs.existsSync(mapsDir)) {
      return { error: `maps folder not found at: ${mapsDir}`, dir: mapsDir };
    }
    const files = fs.readdirSync(mapsDir)
      .filter(f => f.toLowerCase().endsWith('.txt'))
      .filter(f => {
        // Skip empty placeholder files (EQ client creates 0-byte _1/_2/_3 on zone entry)
        try { return fs.statSync(path.join(mapsDir, f)).size > 0; } catch { return false; }
      })
      .sort();
    return { files, dir: mapsDir };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('map:read-file', (e, filename) => {
  if (!config || !config.eqDir) return { error: 'No EQ directory configured.' };
  try {
    const mapsDir = path.join(config.eqDir, 'maps');
    // Security: only allow plain filenames (no path separators)
    const safeName = path.basename(String(filename || ''));
    if (!safeName.toLowerCase().endsWith('.txt')) return { error: 'Invalid file type.' };
    const filePath = path.join(mapsDir, safeName);
    if (!fs.existsSync(filePath)) return { error: `File not found: ${safeName}` };
    return { content: fs.readFileSync(filePath, 'utf8'), filename: safeName };
  } catch (e) {
    return { error: e.message };
  }
});
// Session window sends commands → main window, except openEndReport which opens a new window
ipcMain.on('session:command', (event, cmd) => {
  const sender = BrowserWindow.fromWebContents(event.sender);
  // ── Report-window commands close the window then forward to main ──
  if (sender && reportWindow && !reportWindow.isDestroyed() && sender.id === reportWindow.id) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('session-command', cmd);
    }
    reportWindow.close();
    reportWindow = null;
    return;
  }
  // ── openEndReport: spawn the SESSION COMPLETE window ──
  if (cmd && typeof cmd === 'object' && cmd.type === 'openEndReport') {
    openReportWindow(cmd.data);
    return;
  }
  // ── All other commands forward to main window ──
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('session-command', cmd);
  }
});

function openReportWindow(data) {
  // Focus existing window instead of opening a second one
  if (reportWindow && !reportWindow.isDestroyed()) {
    reportWindow.focus();
    return;
  }
  // Match the current session overlay size
  let width = 300, height = 400;
  if (sessionWindow && !sessionWindow.isDestroyed()) {
    [width, height] = sessionWindow.getSize();
  }
  reportWindow = new BrowserWindow({
    width,
    height,
    minWidth: 260,
    minHeight: 300,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: true,
    title: 'Session Report',
    webPreferences: {
      preload: path.join(ROOT, 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  reportWindow.loadFile(path.join(ROOT, 'src', 'session-report.html'));
  reportWindow.setAlwaysOnTop(true, 'screen-saver');
  reportWindow.webContents.once('did-finish-load', () => {
    if (reportWindow && !reportWindow.isDestroyed()) {
      reportWindow.webContents.send('report-data', data || {});
    }
  });
  reportWindow.on('closed', () => { reportWindow = null; });
}
// Collapse button resizes session window to title-bar height (or restores)
ipcMain.on('session:resize', (event, height) => {
  if (sessionWindow && !sessionWindow.isDestroyed()) {
    const [w] = sessionWindow.getSize();
    sessionWindow.setSize(w, Math.max(36, Math.round(height)));
    // Re-assert overlay level after resize — Windows can demote it
    sessionWindow.setAlwaysOnTop(true, 'screen-saver');
  }
});

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
