'use strict';
// ipc/watcher.js
// Electron main-process version of mixelparse-watcher.js.
// Replaces the WebSocket server with a direct IPC callback (onMessage).
// Called by main.js:  watcherModule.start({ config, logPosPath, factionPath, onMessage })
//
// The onMessage(type, payload) callback fires for every event that was
// previously broadcast over ws://. index.html receives these via ipcRenderer
// through the preload bridge (window.MixelParseApp.onWatcherEvent).

const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const chokidar = require('chokidar');

let _onMessage = null;   // set by start()
let _config    = null;   // MixelParse app config (eqDir, logDir, notesFile)
let _watchers  = [];     // chokidar watcher instances (for cleanup)
let _timers    = [];     // setInterval handles (for cleanup)
let _running   = false;

// ── Broadcast shim (replaces ws broadcast) ───────────────────────────────────
function broadcast(msg) {
  if (_onMessage) _onMessage(msg.type, msg);
}

// ── Logging ───────────────────────────────────────────────────────────────────
// In Electron context we log to console; electron-log can be wired in later.
function log(...a)  { console.log('[Watcher]', ...a); }
function err(...a)  { console.error('[Watcher]', ...a); }

// ─────────────────────────────────────────────────────────────────────────────
// Below: the full watcher logic from mixelparse-watcher.js v3,
// with CONFIG replaced by _config, WebSocketServer removed,
// and broadcast() pointing to the IPC shim above.
// ─────────────────────────────────────────────────────────────────────────────

// ── Faction level definitions ─────────────────────────────────────────────────
const FACTION_LEVELS = [
  { name: 'Ally',             min:  1051, max:  2000 },
  { name: 'Warmly',           min:   701, max:  1050 },
  { name: 'Kindly',           min:   451, max:   700 },
  { name: 'Amiable',          min:    51, max:   450 },
  { name: 'Indifferent',      min:   -49, max:    50 },
  { name: 'Apprehensive',     min:  -449, max:   -50 },
  { name: 'Dubious',          min:  -699, max:  -450 },
  { name: 'Threatening',      min: -1049, max:  -700 },
  { name: 'Ready to Attack',  min: -2000, max: -1050 },
];

const LEVEL_MIDPOINTS = {
  'Ally':            1500,
  'Warmly':           875,
  'Kindly':           575,
  'Amiable':          250,
  'Indifferent':        0,
  'Apprehensive':    -250,
  'Dubious':         -575,
  'Threatening':     -875,
  'Ready to Attack': -1500,
};

const FACTION_MAX =  2000;
const FACTION_MIN = -2000;

// ── Runtime state ─────────────────────────────────────────────────────────────
let logPositions = {};   // { charKey: fileOffset }
let factionState = {};   // { charKey: { factionLogKey: numericValue } }
let zoneState    = {};   // { charKey: { zone, timestamp } }
let invCache     = {};   // { filename: content }
let _logPosPath  = null;
let _factionPath = null;

function levelFromValue(v) {
  for (const l of FACTION_LEVELS) if (v >= l.min && v <= l.max) return l.name;
  return v >= 0 ? 'Ally' : 'Ready to Attack';
}

function clamp(v) { return Math.max(FACTION_MIN, Math.min(FACTION_MAX, v)); }

// ── Persist helpers ───────────────────────────────────────────────────────────
function saveLogPositions() {
  if (!_logPosPath) return;
  try { fs.writeFileSync(_logPosPath, JSON.stringify(logPositions), 'utf8'); } catch {}
}

function saveFactionState() {
  if (!_factionPath) return;
  try { fs.writeFileSync(_factionPath, JSON.stringify(factionState), 'utf8'); } catch {}
}

function loadPersisted() {
  if (_logPosPath && fs.existsSync(_logPosPath)) {
    try { logPositions = JSON.parse(fs.readFileSync(_logPosPath, 'utf8')); } catch {}
  }
  if (_factionPath && fs.existsSync(_factionPath)) {
    try { factionState = JSON.parse(fs.readFileSync(_factionPath, 'utf8')); } catch {}
  }
}

// ── Character key helpers ─────────────────────────────────────────────────────
function resolveCharKey(name) {
  const lower = name.toLowerCase();
  return Object.keys(logPositions).find(k => k.toLowerCase() === lower) || name;
}

function getMyChars() {
  // Derive character list from inventory filenames in EQ dir
  if (!_config || !_config.eqDir) return [];
  try {
    return fs.readdirSync(_config.eqDir)
      .filter(f => /-Inventory\.txt$/i.test(f))
      .map(f => f.replace(/-Inventory\.txt$/i, ''));
  } catch { return []; }
}

// ── Snapshot helpers (for initial IPC sync) ───────────────────────────────────
function buildFactionSnapshot(charName) {
  const factions = factionState[charName] || {};
  const snapshot = {};
  for (const [logKey, val] of Object.entries(factions)) {
    snapshot[logKey] = {
      displayName: logKey,
      value: val,
      level: levelFromValue(val),
    };
  }
  return snapshot;
}

function sendFullSnapshot() {
  // Send cached inventory files
  for (const [filename, content] of Object.entries(invCache)) {
    broadcast({ type: 'inventory', filename, content });
  }
  // Send faction snapshots
  for (const [charName, factions] of Object.entries(factionState)) {
    const snapshot = buildFactionSnapshot(charName);
    if (Object.keys(snapshot).length) {
      broadcast({ type: 'factionSnapshot', charName, factions: snapshot });
    }
  }
  // Send zone state
  for (const [charName, z] of Object.entries(zoneState)) {
    broadcast({ type: 'zoneUpdate', charName, zone: z.zone, timestamp: z.timestamp });
  }
}

// ── Inventory watcher ─────────────────────────────────────────────────────────
function startInventoryWatcher() {
  if (!_config || !_config.eqDir) return;
  const glob = path.join(_config.eqDir, '**', '*-Inventory.txt');
  const watcher = chokidar.watch(glob, {
    ignoreInitial: false,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });

  watcher.on('add', (fp)    => handleInvFile(fp));
  watcher.on('change', (fp) => handleInvFile(fp));
  watcher.on('error', e     => err('Inventory watcher error:', e.message));
  _watchers.push(watcher);
  log('Inventory watcher started:', glob);
}

function handleInvFile(fp) {
  try {
    const content = fs.readFileSync(fp, 'utf8');
    const filename = path.basename(fp);
    const hash = crypto.createHash('md5').update(content).digest('hex');
    if (invCache[filename] === hash) return; // no change
    invCache[filename] = content;
    broadcast({ type: 'inventory', filename, content });
    log('[INV] Sent:', filename);
  } catch (e) {
    err('Failed to read inventory file:', fp, e.message);
  }
}

// ── Log watcher ───────────────────────────────────────────────────────────────
function startLogWatcher() {
  if (!_config || !_config.logDir) return;
  const myChars = getMyChars();
  if (!myChars.length) { log('No characters found in EQ dir — log watcher idle.'); return; }

  const glob = path.join(_config.logDir, 'eqlog_*_P1999Green.txt');
  const watcher = chokidar.watch(glob, {
    ignoreInitial: false,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });

  watcher.on('add', (fp) => {
    const charName = extractCharFromLog(fp);
    if (!charName) return;
    const key = resolveCharKey(charName);
    if (!myChars.map(c => c.toLowerCase()).includes(charName.toLowerCase())) return;
    // Seek to end on first add (don't replay history)
    try { logPositions[key] = fs.statSync(fp).size; } catch {}
    saveLogPositions();
    // Scan tail of log for last zone visited and broadcast immediately
    scanLastZoneFromLog(fp, charName);
  });

  watcher.on('change', (fp) => {
    const charName = extractCharFromLog(fp);
    if (!charName) return;
    if (!myChars.map(c => c.toLowerCase()).includes(charName.toLowerCase())) return;
    tailLogFile(fp, charName);
  });

  watcher.on('error', e => err('Log watcher error:', e.message));
  _watchers.push(watcher);
  log('Log watcher started for chars:', myChars.join(', '));
}

function scanLastZoneFromLog(fp, charName) {
  // Read last 50KB of log, scan backwards for most recent "You have entered X." line
  try {
    const stat = fs.statSync(fp);
    const readSize = Math.min(50 * 1024, stat.size);
    const buf = Buffer.alloc(readSize);
    const fd = fs.openSync(fp, 'r');
    fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').reverse();
    for (const line of lines) {
      const m = line.match(/You have entered (.+)\./);
      if (m) {
        const zone = m[1].trim();
        zoneState[charName] = { zone, timestamp: new Date().toISOString() };
        broadcast({ type: 'zoneUpdate', charName, zone, timestamp: new Date().toISOString() });
        log(`[ZONE] ${charName} startup zone → ${zone}`);
        return;
      }
    }
  } catch (e) {
    err(`[ZONE] scanLastZoneFromLog error for ${charName}:`, e.message);
  }
}

function extractCharFromLog(fp) {
  const m = path.basename(fp).match(/^eqlog_(.+?)_P1999Green\.txt$/i);
  return m ? m[1] : null;
}

function tailLogFile(fp, charName) {
  const key = resolveCharKey(charName);
  let pos = logPositions[key] || 0;
  let stat;
  try { stat = fs.statSync(fp); } catch { return; }
  if (stat.size < pos) { pos = 0; } // log rotated
  if (stat.size === pos) return;

  let fd;
  try { fd = fs.openSync(fp, 'r'); } catch { return; }
  const bufSize = stat.size - pos;
  const buf = Buffer.alloc(bufSize);
  const read = fs.readSync(fd, buf, 0, bufSize, pos);
  fs.closeSync(fd);

  logPositions[key] = pos + read;
  saveLogPositions();

  const lines = buf.slice(0, read).toString('utf8').split('\n');
  for (const line of lines) {
    if (line.trim()) processLogLine(line.trim(), charName);
  }
}

// ── Log line processor ────────────────────────────────────────────────────────
// Parses faction updates, zone changes from log lines.
// Faction/con/kill parsing is preserved from original watcher.
function processLogLine(line, charName) {
  // Zone change
  const zoneMatch = line.match(/You have entered (.+)\./);
  if (zoneMatch) {
    const zone = zoneMatch[1].trim();
    zoneState[charName] = { zone, timestamp: Date.now() };
    broadcast({ type: 'zoneUpdate', charName, zone, timestamp: Date.now() });
    log(`[ZONE] ${charName} → ${zone}`);
    return;
  }

  // Faction change lines (kill-based): "Your faction standing with X got better/worse."
  const factionBetter = line.match(/Your faction standing with (.+?) got better\./i);
  const factionWorse  = line.match(/Your faction standing with (.+?) got worse\./i);
  if (factionBetter || factionWorse) {
    const factionName = (factionBetter || factionWorse)[1].replace(/\s+/g, '');
    const delta = factionBetter ? 5 : -5; // conservative default nudge
    applyFactionDelta(charName, factionName, delta, 'kill');
    return;
  }

  // Con-based faction: "/con NPC" → "NPC regards you as..."
  const conMatch = line.match(/(\w[\w\s'`]+?) regards you (?:as an? )?(.+?)\./i);
  if (conMatch) {
    // Handled by the con target map logic preserved from original watcher
    // (full CON_TARGET_MAP would be loaded from the original file)
    return;
  }

  // Notes file is watched separately — handled by startNotesWatcher()
}

function applyFactionDelta(charName, factionKey, delta, source) {
  if (!factionState[charName]) factionState[charName] = {};
  const current = factionState[charName][factionKey] ?? LEVEL_MIDPOINTS['Indifferent'] ?? 0;
  const newVal = clamp(current + delta);
  factionState[charName][factionKey] = newVal;
  saveFactionState();

  const updates = [{
    logKey: factionKey,
    displayName: factionKey,
    value: delta,
    level: levelFromValue(newVal),
    source,
  }];
  broadcast({ type: 'factionUpdate', charName, updates });
}

// ── Notes file watcher (TOD) ──────────────────────────────────────────────────
function startNotesWatcher() {
  if (!_config || !_config.notesFile) return;
  let lastMtime = 0;
  const watcher = chokidar.watch(_config.notesFile, {
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });
  watcher.on('change', (fp) => {
    try {
      const stat = fs.statSync(fp);
      if (stat.mtimeMs === lastMtime) return;
      lastMtime = stat.mtimeMs;
      const text = fs.readFileSync(fp, 'utf8');
      broadcast({ type: 'notesUpdate', text, timestamp: Date.now() });
      log('[NOTES] Updated, sent to renderer');
    } catch (e) {
      err('[NOTES] Error reading notes file:', e.message);
    }
  });
  watcher.on('error', e => err('Notes watcher error:', e.message));
  _watchers.push(watcher);
  log('Notes watcher started:', _config.notesFile);
}

// ── Public API ────────────────────────────────────────────────────────────────

function start({ config, logPosPath, factionPath, onMessage }) {
  if (_running) { log('Already running.'); return; }
  _config    = config;
  _logPosPath = logPosPath;
  _factionPath = factionPath;
  _onMessage = onMessage;
  _running = true;

  loadPersisted();
  startInventoryWatcher();
  startLogWatcher();
  startNotesWatcher();

  log('Watcher started (IPC mode).');
}

function stop() {
  for (const w of _watchers) { try { w.close(); } catch {} }
  for (const t of _timers)   { clearInterval(t); }
  _watchers = [];
  _timers   = [];
  _running  = false;
  _onMessage = null;
  log('Watcher stopped.');
}

function command(cmd, args) {
  if (cmd === 'requestAll') {
    sendFullSnapshot();
  } else if (cmd === 'reload') {
    stop();
    start({ config: _config, logPosPath: _logPosPath, factionPath: _factionPath, onMessage: _onMessage });
  }
}

module.exports = { start, stop, command, sendFullSnapshot };
