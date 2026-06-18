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
let invCache     = {};   // { filename: hash } for dedup
let invContent   = {};   // { filename: content } for sendFullSnapshot
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
  for (const [filename, content] of Object.entries(invContent)) {
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

  // Startup: scan all existing inventory files immediately
  try {
    const files = fs.readdirSync(_config.eqDir);
    log('[INV] Startup scan found', files.filter(f => f.endsWith('-Inventory.txt')).length, 'inventory files');
    for (const f of files) {
      if (!f.endsWith('-Inventory.txt')) continue;
      handleInvFile(path.join(_config.eqDir, f));
    }
  } catch (e) {
    err('Startup inventory scan error:', e.message);
  }

  // Watch directory for inventory file changes via mtime polling
  const invMtimes = {};
  const t = setInterval(() => {
    try {
      const files = fs.readdirSync(_config.eqDir);
      for (const f of files) {
        if (!f.endsWith('-Inventory.txt')) continue;
        const fp = path.join(_config.eqDir, f);
        try {
          const mtime = fs.statSync(fp).mtimeMs;
          if (invMtimes[f] !== mtime) {
            invMtimes[f] = mtime;
            handleInvFile(fp);
          }
        } catch {}
      }
    } catch (e) {
      err('[INV] Poll error:', e.message);
    }
  }, 2000);
  _timers.push(t);
  log('Inventory watcher started (mtime polling every 2s):', _config.eqDir);
}

function handleInvFile(fp) {
  try {
    const content = fs.readFileSync(fp, 'utf8');
    const filename = path.basename(fp);
    const hash = crypto.createHash('md5').update(content).digest('hex');
    if (invCache[filename] === hash) return; // no change
    invCache[filename] = hash;
    invContent[filename] = content;
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

  log('Log watcher started for chars:', myChars.join(', '));

  // Poll log files for changes via mtime — chokidar unreliable in Electron main process
  const logMtimes = {};
  const t = setInterval(() => {
    try {
      const files = fs.readdirSync(_config.logDir);
      for (const f of files) {
        if (!/^eqlog_.+_P1999Green\.txt$/i.test(f)) continue;
        const charName = extractCharFromLog(f);
        if (!charName) continue;
        if (!myChars.map(c => c.toLowerCase()).includes(charName.toLowerCase())) continue;
        const fp = path.join(_config.logDir, f);
        try {
          const mtime = fs.statSync(fp).mtimeMs;
          if (logMtimes[f] !== mtime) {
            logMtimes[f] = mtime;
            tailLogFile(fp, charName);
          }
        } catch {}
      }
    } catch (e) {
      err('[LOG] Poll error:', e.message);
    }
  }, 2000);
  _timers.push(t);

  // Startup zone scan — don't rely on chokidar 'add' events (may be delayed with large dirs)
  try {
    const files = fs.readdirSync(_config.logDir);
    for (const f of files) {
      if (!/^eqlog_.+_P1999Green\.txt$/i.test(f)) continue;
      const charName = extractCharFromLog(f);
      if (!charName) continue;
      if (!myChars.map(c => c.toLowerCase()).includes(charName.toLowerCase())) continue;
      const fp = path.join(_config.logDir, f);
      const key = resolveCharKey(charName);
      try { logPositions[key] = fs.statSync(fp).size; } catch {}
      scanLastZoneFromLog(fp, charName);
    }
    saveLogPositions();
  } catch (e) {
    err('Startup zone scan error:', e.message);
  }
}

function scanLastZoneFromLog(fp, charName) {
  // Read last 50KB of log, scan backwards for most recent "You have entered X." line
  log(`[ZONE] Scanning ${charName} log for last zone...`);
  try {
    const stat = fs.statSync(fp);
    const readSize = Math.min(100 * 1024, stat.size);
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
    log(`[ZONE] ${charName} — no zone line found in last 50KB`);
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

// ── Con-based faction detection ──────────────────────────────────────────────
// Matches: "A frost giant regards you as an ally."
//          "Nanzata the Warder regards you warmly."
//          "A frost giant scowls at you, ready to attack!"
const RE_CON = /^\[.+?\] (.+?) (?:(?:(?:regards|considers|judges) you|glares at you) (?:as an? )?\w*?\b(ally|warmly|kindly|amiably?|indifferently?|apprehensively?|dubiously?|threateningly?|scowls)|(ally|warmly|kindly|amiably?|indifferently?|apprehensively?|dubiously?|threateningly?|scowls) (?:regards|considers|judges) you)/i;

const CON_TARGET_MAP = {
  // ── Claws of Veeshan ──────────────────────────────────────────────────────
  'a wyvern':                    'Claws of Veeshan',
  'a velium wyvern':             'Claws of Veeshan',
  'nanzata the warder':          'Claws of Veeshan',
  'a tov warder':                'Claws of Veeshan',
  'a fiery watcher':             'Claws of Veeshan',
  'a glimmering drake':             'Claws of Veeshan',
  'a wyvern huntress':             'Claws of Veeshan',
  'korakaz':             'Kromzek',
  'priest grenk':             'Kromzek',
  'a storm giant escort':             'Kromzek',
  'esorpa of the ring':             'Ring of Scale',
  'a cerulean sky gazer':             'Claws of Veeshan',
  'a cragwyrm':             'Claws of Veeshan',
  'a dalgortha':             'Claws of Veeshan',
  'a fiery temple guardian':             'Claws of Veeshan',
  'a gargoyle guardian':             'Claws of Veeshan',
  'a glimmer drake':             'Claws of Veeshan',
  'a gravid drake':             'Claws of Veeshan',
  'a hungry cube':             'Claws of Veeshan',
  'a large velium statue':             'Claws of Veeshan',
  'a lava dancer':             'Claws of Veeshan',
  'a shambling cube':             'Claws of Veeshan',
  'a shimmering green drake':             'Claws of Veeshan',
  'a velious drake':             'Claws of Veeshan',
  'aaryonar':             'Claws of Veeshan',
  'abudan fe`dhar':             'Claws of Veeshan',
  'adwetram fe`dhar':             'Claws of Veeshan',
  'ahcaz':             'Claws of Veeshan',
  'an ancient ice wurm defender':             'Claws of Veeshan',
  'an ancient sky drake':             'Claws of Veeshan',
  'an elder onyx drake':             'Claws of Veeshan',
  'an onyx sky drake':             'Claws of Veeshan',
  'arreken skyward':             'Claws of Veeshan',
  'asteinnon fe`dhar':             'Claws of Veeshan',
  'ayillish':             'Claws of Veeshan',
  'azureake':             'Claws of Veeshan',
  'belijor the emerald eye':             'Claws of Veeshan',
  'bezeb':             'Claws of Veeshan',
  'bouncer boulder':             'Claws of Veeshan',
  'bratavar':             'Claws of Veeshan',
  'bufa':             'Claws of Veeshan',
  'cargalia':             'Claws of Veeshan',
  'cekenar':             'Claws of Veeshan',
  'chymot':             'Claws of Veeshan',
  'commander leuz':             'Claws of Veeshan',
  'crendatha fe`dhar':             'Claws of Veeshan',
  'dagarn the destroyer':             'Claws of Veeshan',
  'dalshim fe`dhar':             'Claws of Veeshan',
  'del sapara':             'Claws of Veeshan',
  'deoryn fe`dhar':             'Claws of Veeshan',
  'derasinal':             'Claws of Veeshan',
  'draazak':             'Claws of Veeshan',
  'dygwyn fe`dhar':             'Claws of Veeshan',
  'dyr fe`dhar':             'Claws of Veeshan',
  'eashen of the sky':             'Claws of Veeshan',
  'elaend fe`dhar':             'Claws of Veeshan',
  'elder hajnix':             'Claws of Veeshan',
  'elder kajind':             'Claws of Veeshan',
  'elder kalur':             'Claws of Veeshan',
  'eldriaks fe`dhar':             'Claws of Veeshan',
  'elyshum fe`dhar':             'Claws of Veeshan',
  'entariz':             'Claws of Veeshan',
  'fardonad fe`dhar':             'Claws of Veeshan',
  'gafala':             'Claws of Veeshan',
  'gangel':             'Claws of Veeshan',
  'glati':             'Claws of Veeshan',
  'glydoc fe`dhar':             'Claws of Veeshan',
  'gozzrem':             'Claws of Veeshan',
  'grudash the baker':             'Claws of Veeshan',
  'honvar':             'Claws of Veeshan',
  'hytloc':             'Claws of Veeshan',
  'ionat':             'Claws of Veeshan',
  'jaelk':             'Claws of Veeshan',
  'jaled dar`s shade':             'Claws of Veeshan',
  'jaylorx':             'Claws of Veeshan',
  'jen sapara':             'Claws of Veeshan',
  'jendavudd fe`dhar':             'Claws of Veeshan',
  'jorlleag':             'Claws of Veeshan',
  'jualicn':             'Claws of Veeshan',
  'kalacs fe`dhar':             'Claws of Veeshan',
  'kardakor':             'Claws of Veeshan',
  'karkona':             'Claws of Veeshan',
  'kelorek`dar':             'Claws of Veeshan',
  'komawin fe`dhar':             'Claws of Veeshan',
  'lady mirenilla':             'Claws of Veeshan',
  'lady nevederia':             'Claws of Veeshan',
  'laegdric fe`dhar':             'Claws of Veeshan',
  'lararith':             'Claws of Veeshan',
  'lawyla':             'Claws of Veeshan',
  'lendiniara the keeper':             'Claws of Veeshan',
  'lignark':             'Claws of Veeshan',
  'linbrak':             'Claws of Veeshan',
  'lord feshlak':             'Claws of Veeshan',
  'lord koi`doken':             'Claws of Veeshan',
  'lord kreizenn':             'Claws of Veeshan',
  'lord yelinak':             'Claws of Veeshan',
  'lothieder fe`dhar':             'Claws of Veeshan',
  'makala':             'Claws of Veeshan',
  'mazi':             'Claws of Veeshan',
  'medry fe`dhar':             'Claws of Veeshan',
  'morachii fe`dhar':             'Claws of Veeshan',
  'mraaka':             'Claws of Veeshan',
  'myga':             'Claws of Veeshan',
  'nalelin fe`dhar':             'Claws of Veeshan',
  'nalginor fe`dhar':             'Claws of Veeshan',
  'neordla':             'Claws of Veeshan',
  'norsirx':             'Claws of Veeshan',
  'ocoenydd fe`dhar':             'Claws of Veeshan',
  'oct velic':             'Claws of Veeshan',
  'oglard':             'Claws of Veeshan',
  'onava':             'Claws of Veeshan',
  'onerind fe`dhar':             'Claws of Veeshan',
  'orthor velic':             'Claws of Veeshan',
  'pantrilla':             'Claws of Veeshan',
  'placlis':             'Claws of Veeshan',
  'poalgin fe`dhar':             'Claws of Veeshan',
  'qalcnic fe`dhar':             'Claws of Veeshan',
  'quadrix velic':             'Claws of Veeshan',
  'quoza':             'Claws of Veeshan',
  'qynydd fe`dhar':             'Claws of Veeshan',
  'ralgyn':             'Claws of Veeshan',
  'riran fe`dhar':             'Claws of Veeshan',
  'rolandal':             'Claws of Veeshan',
  'salginor':             'Claws of Veeshan',
  'scout charisa':             'Claws of Veeshan',
  'sentry kale':             'Claws of Veeshan',
  'sevalak':             'Claws of Veeshan',
  'suez':             'Claws of Veeshan',
  'taegria fe`dhar':             'Claws of Veeshan',
  'talgixn fe`dhar':             'Claws of Veeshan',
  'talnifs':             'Claws of Veeshan',
  'talon velic':             'Claws of Veeshan',
  'telkorenar':             'Claws of Veeshan',
  'telnaq':             'Claws of Veeshan',
  'tetragon velic':             'Claws of Veeshan',
  'the seer':             'Claws of Veeshan',
  'theldek the stinger':             'Claws of Veeshan',
  'tonvan fe`dhar':             'Claws of Veeshan',
  'tranala':             'Claws of Veeshan',
  'tri velic':             'Claws of Veeshan',
  'tsiraka':             'Claws of Veeshan',
  'tyddyn fe`dhar':             'Claws of Veeshan',
  'ualkic fe`dhar':             'Claws of Veeshan',
  'uiliak':             'Claws of Veeshan',
  'umykith fe`dhar':             'Claws of Veeshan',
  'vellyn fe`dhar':             'Claws of Veeshan',
  'vitaela':             'Claws of Veeshan',
  'vobryn fe`dhar':             'Claws of Veeshan',
  'von':             'Claws of Veeshan',
  'vulak`aerr':             'Claws of Veeshan',
  'yaced':             'Claws of Veeshan',
  'yal':             'Claws of Veeshan',
  'yeldema':             'Claws of Veeshan',
  'yendilor the cerulean wing':             'Claws of Veeshan',
  'yvolcarn':             'Claws of Veeshan',
  'zaldin fe`dhar':             'Claws of Veeshan',
  'zalerez':             'Claws of Veeshan',
  'zemm':             'Claws of Veeshan',
  'ziglark whisperwing':             'Claws of Veeshan',
  'zil sapara':             'Claws of Veeshan',
  'zildainez':             'Claws of Veeshan',
  'zlexak':             'Claws of Veeshan',
  'zynil':             'Claws of Veeshan',
  'an emerald sky defender':     'Claws of Veeshan',
  'a guardian of the temple':    'Claws of Veeshan',
  'sontalak':                    'Claws of Veeshan',
  'klandicar':                   'Claws of Veeshan',
  'harla dar':                   'Claws of Veeshan',
  "kelorek'dar":                 'Claws of Veeshan',
  'wuoshi':                      'Claws of Veeshan',
  'a crag spider':               'Claws of Veeshan',
  'a cobalt drake':              'Claws of Veeshan',
  'a velium drake':              'Claws of Veeshan',
  'a western wastes dragon':     'Claws of Veeshan',
  'a dragon':                    'Claws of Veeshan',
  // ── Guardians of Veeshan ──────────────────────────────────────────────────
  'a guardian of veeshan':       'Guardians of Veeshan',
  // ── Ring of Scale ─────────────────────────────────────────────────────────
  'a dragonkin':                 'Ring of Scale',
  'a ring of scale':             'Ring of Scale',
  'a blackscale':                'Ring of Scale',
  'a silvered dragon':           'Ring of Scale',
  // ── Yelinak ───────────────────────────────────────────────────────────────
  'a skyshrine guard':           'Yelinak',
  'a drachnid':                  'Yelinak',
  'a drachnid soldier':          'Yelinak',
  'a drachnid silkweaver':       'Yelinak',
  'a drachnid worker':           'Yelinak',
  'a drolvarg':                  'Yelinak',
  // ── Kromzek ───────────────────────────────────────────────────────────────
  'a frost giant':               'Kromzek',
  'a frost giant berserker':     'Kromzek',
  'a frost giant elite':         'Kromzek',
  'a frost giant scout':         'Kromzek',
  'a frost giant commoner':      'Kromzek',
  'a frost giant gladiator':     'Kromzek',
  'a frost giant trainer':       'Kromzek',
  'a frost giant laborer':       'Kromzek',
  'a frost giant sentinel':      'Kromzek',
  'a frost giant sentry':        'Kromzek',
  'a frost giant wolf tamer':    'Kromzek',
  'a frost giant lord':          'Kromzek',
  'a storm giant commoner':      'Kromzek',
  'a storm giant berserker':     'Kromzek',
  'a storm giant gladiator':     'Kromzek',
  'a storm giant surveyor':      'Kromzek',
  'a storm giant foreman':       'Kromzek',
  'a wounded storm giant':       'Kromzek',
  'a lesser storm giant noble':  'Kromzek',
  'a visiting noble':            'Kromzek',
  'an angry commoner':           'Kromzek',
  'a domesticated direwolf':     'Kromzek',
  'a guardian of zek':           'Kromzek',
  'a protector of zek':          'Kromzek',
  'protector of zek':            'Kromzek',
  'a temple guardian':           'Kromzek',
  'armor of zek':                'Kromzek',
  'a kromzek guard':             'Kromzek',
  'a giant warrior':             'Kromzek',
  'a cleric of vallon zek':      'Kromzek',
  'a priest of tallon zek':      'Kromzek',
  'gkrean prophet of tallon':    'Kromzek',
  'semkak prophet of vallon':    'Kromzek',
  'a kromrif recruiter':         'Kromzek',
  'legionnaire byltor':          'Kromzek',
  'legionnaire icebender':       'Kromzek',
  'legionnaire renarn':          'Kromzek',
  'legionnaire sjeldor':         'Kromzek',
  'legionnaire yvedrn':          'Kromzek',
  'watcher thrensheld':          'Kromzek',
  'watcher zedlek':              'Kromzek',
  'watchman bexlend':            'Kromzek',
  'watchman erendor':            'Kromzek',
  'watchman gardal':             'Kromzek',
  'watchman njella':             'Kromzek',
  'watchman reglekar':           'Kromzek',
  'watchman sunderthorn':        'Kromzek',
  'watchman thyek':              'Kromzek',
  'watchman vedravik':           'Kromzek',
  'watchman weyaen':             'Kromzek',
  'guard blaesek':               'Kromzek',
  'guard fjleed':                'Kromzek',
  'guard fjorlek':               'Kromzek',
  'guard fleshflayer':           'Kromzek',
  'guard greybeard':             'Kromzek',
  'guard hallenban':             'Kromzek',
  'guard khyosr':                'Kromzek',
  'guard kkrean':                'Kromzek',
  'guard ragern':                'Kromzek',
  'guard rolkin':                'Kromzek',
  'guard sjior':                 'Kromzek',
  'guard stonebender':           'Kromzek',
  'guard ulfhedinn':             'Kromzek',
  'guard vydel':                 'Kromzek',
  'senior guard akurr':          'Kromzek',
  'senior guard dhryell':        'Kromzek',
  'senior guard eihorn':         'Kromzek',
  'senior guard grelden':        'Kromzek',
  'senior guard icemead':        'Kromzek',
  'senior guard randeil':        'Kromzek',
  'senior guard tymul':          'Kromzek',
  'senior guard whiteaxe':       'Kromzek',
  'sergeant blestrom':           'Kromzek',
  'sergeant brunfel':            'Kromzek',
  'sergeant fjrak':              'Kromzek',
  'sergeant miidenaer':          'Kromzek',
  'sergeant tellsren':           'Kromzek',
  'sergeant yggrellnik':         'Kromzek',
  'trooper derheim':             'Kromzek',
  'trooper dlemdimor':           'Kromzek',
  'trooper ebonblade':           'Kromzek',
  'trooper gyarll':              'Kromzek',
  'trooper jhonev':              'Kromzek',
  'trooper khyren':              'Kromzek',
  'trooper mjflean':             'Kromzek',
  'trooper nyorll':              'Kromzek',
  'trooper relhjorn':            'Kromzek',
  'trooper sardek':              'Kromzek',
  'veteran icecaller':           'Kromzek',
  'veteran skeldek':             'Kromzek',
  'veteran surlren':             'Kromzek',
  'veteran yllhaydm':            'Kromzek',
  'adjutant cryyrn':             'Kromzek',
  'adjutant derkan':             'Kromzek',
  'adjutant droggren':           'Kromzek',
  'adjutant frinevrn':           'Kromzek',
  'adjutant hekrandor':          'Kromzek',
  'adjutant hoggren':            'Kromzek',
  'adjutant jharll':             'Kromzek',
  'adjutant skjell':             'Kromzek',
  'adjutant stormkeeper':        'Kromzek',
  'adjutant thyek':              'Kromzek',
  'sentinel sunderdrake':        'Kromzek',
  'lieutenant stormeye':         'Kromzek',
  'klaggan iceshard':            'Kromzek',
  'vealok the angry':            'Kromzek',
  'clrakk blackfist':            'Kromzek',
  'bjrakor the cold':            'Kromzek',
  'frostgiant overseer':         'Kromzek',
  'lieutenant krofer':           'Kromzek',
  'derakor the vindicator':      'Kromzek',
  // ── Kromrif ───────────────────────────────────────────────────────────────
  'a frost giant warrior':       'Kromrif',
  'a kromrif':                   'Kromrif',
  'a frost giant savage':        'Kromrif',
  'a frost giant captain':       'Kromrif',
  'fergul frostsky':             'Kromrif',
  'fjloaren icebane':            'Kromrif',
  'gorul longshanks':            'Kromrif',
  'kromriff guardsman':          'Kromrif',
  'a drakkel dire wolf':         'Kromrif',
  // ── Coldain ───────────────────────────────────────────────────────────────
  'a coldain guard':             'Coldain',
  'a coldain':                   'Coldain',
  'a coldain warrior':           'Coldain',
  'a coldain soldier':           'Coldain',
  'a coldain miner':             'Coldain',
  'a coldain scout':             'Coldain',
  'a coldain citizen':           'Coldain',
  'a coldain defender':          'Coldain',
  'a coldain champion':          'Coldain',
  'tain hammerfrost':            'Coldain',
  // ── Dain Frostreaver IV ───────────────────────────────────────────────────
  'dain frostreaver iv':         'Dain Frostreaver IV',
  // ── King Tormax ───────────────────────────────────────────────────────────
  'king tormax':                 'King Tormax',
  'dlammaz stormslayer':         'King Tormax',
  'drendar blackblade':          'King Tormax',
  "keldor dek'torek":            'King Tormax',
  'velden dragonbane':           'King Tormax',
  // ── Storm Guards (Thurgadin) ──────────────────────────────────────────────
  'a storm guard':               'Storm Guards',
  'a storm guard captain':       'Storm Guards',
  'a storm guard lieutenant':    'Storm Guards',
  'a storm guard officer':       'Storm Guards',
  'a storm guard sergeant':      'Storm Guards',
  // ── Emerald Warriors (Skyshrine) ──────────────────────────────────────────
  'an emerald warrior':          'Emerald Warriors',
  'an emerald warrior guard':    'Emerald Warriors',
  // ── Kael Drakkel ──────────────────────────────────────────────────────────
  'a kael guard':                'Kael Drakkel',
  'a kael gladiator':            'Kael Drakkel',
  'a kael warrior':              'Kael Drakkel',
  'a kael citizen':              'Kael Drakkel',
  'a kael berserker':            'Kael Drakkel',
  'a kael champion':             'Kael Drakkel',
  'a kael dragoon':              'Kael Drakkel',
  'a kael soldier':              'Kael Drakkel',
  'a kael noble':                'Kael Drakkel',
  'a kael priest':               'Kael Drakkel',
  'a kael shaman':               'Kael Drakkel',
  'a kael wizard':               'Kael Drakkel',
  'a frost giant elder':         'Kael Drakkel',
  'a frost giant cleric':        'Kael Drakkel',
  'a frost giant paladin':       'Kael Drakkel',
  'a frost giant necromancer':   'Kael Drakkel',
  'an avatar of war':            'Kael Drakkel',
  // ── Thurgadin ─────────────────────────────────────────────────────────────
  'a thurgadin guard':           'Thurgadin',
  'a thurgadin citizen':         'Thurgadin',
  'a thurgadin soldier':         'Thurgadin',
  'a thurgadin champion':        'Thurgadin',
  'a thurgadin champion guard':  'Thurgadin',
  'a coldain blacksmith':        'Thurgadin',
  'a coldain jeweler':           'Thurgadin',
  'a coldain merchant':          'Thurgadin',
  'a coldain brewer':            'Thurgadin',
  // ── Legion of Cabilis ─────────────────────────────────────────────────────
  'an iksar guard':              'Legion of Cabilis',
  'a scaled wolf':               'Legion of Cabilis',
  'an iksar warrior':            'Legion of Cabilis',
  'an iksar citizen':            'Legion of Cabilis',
  'a cabilis guard':             'Legion of Cabilis',
  // ── Brood of Di'Zok ───────────────────────────────────────────────────────
  "a di'zok guard":              "Brood of Di'Zok",
  "a di'zok crusader":           "Brood of Di'Zok",
  "a di'zok duelist":            "Brood of Di'Zok",
  "a di'zok soldier":            "Brood of Di'Zok",
  "a di'zok knight":             "Brood of Di'Zok",
  "a di'zok advisor":            "Brood of Di'Zok",
  "di'zok crusader":             "Brood of Di'Zok",
  'an off duty slavemaster':     "Brood of Di'Zok",
  "a di`zok underling":          "Brood of Di'Zok",
  // ── Sarnak Collective ─────────────────────────────────────────────────────
  'a sarnak':                    'Sarnak Collective',
  'a sarnak warrior':            'Sarnak Collective',
  'a sarnak berserker':          'Sarnak Collective',
  'a sarnak soldier':            'Sarnak Collective',
  // ── Brood of Kotiz ────────────────────────────────────────────────────────
  'a skeleton':                  'Brood of Kotiz',
  'a greater skeleton':          'Brood of Kotiz',
  'an undead iksar':             'Brood of Kotiz',
  // ── Venril Sathir ─────────────────────────────────────────────────────────
  'venril sathir':               'Venril Sathir',
  'venril sathir remains':       'Venril Sathir',
  // ── Minions of Scale ──────────────────────────────────────────────────────
  'a dragonscale':               'Minions of Scale',
  // ── Vox / Nagafen ─────────────────────────────────────────────────────────
  'lady vox':                    'Vox',
  'a vox guardian':              'Vox',
  'a vox servant':               'Vox',
  'lord nagafen':                'Nagafen',
  'a nagafen guardian':          'Nagafen',
  // ── Denizens of Fear ──────────────────────────────────────────────────────
  'a shiverback':                'Denizens of Fear',
  'a terror':                    'Denizens of Fear',
  'a dread':                     'Denizens of Fear',
  'a fright':                    'Denizens of Fear',
  'a horror':                    'Denizens of Fear',
  'an enraged dread':            'Denizens of Fear',
  'a cazicite':                  'Denizens of Fear',
  // ── Inhabitants of Hate ───────────────────────────────────────────────────
  'an erudite':                  'Inhabitants of Hate',
  'a cleric of innoruuk':        'Inhabitants of Hate',
  'a heretic':                   'Inhabitants of Hate',
  'a shadow knight':             'Inhabitants of Hate',
  'a paladin of innoruuk':       'Inhabitants of Hate',
  'innoruuk':                    'Inhabitants of Hate',
  // ── Guards of Qeynos ──────────────────────────────────────────────────────
  'a qeynos guard':              'Guards of Qeynos',
  'a guard':                     'Guards of Qeynos',
  // ── The Dead (Neriak) ─────────────────────────────────────────────────────
  'a crusader of greenmist':     'The Dead',
  'a dark elf crusader':         'The Dead',
  'a dark elf guard':            'The Dead',
  'a necromancer':               'The Dead',
};

const CON_WORD_TO_LEVEL = {
  'ally':           'Ally',
  'warmly':         'Warmly',
  'kindly':         'Kindly',
  'amiable':        'Amiable',
  'amiably':        'Amiable',
  'indifferent':    'Indifferent',
  'indifferently':  'Indifferent',
  'apprehensive':   'Apprehensive',
  'apprehensively': 'Apprehensive',
  'dubious':        'Dubious',
  'dubiously':      'Dubious',
  'threatening':    'Threatening',
  'threateningly':  'Threatening',
  'scowls':         'Ready to Attack',
};

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

  // Con-based faction: "/con NPC" → "NPC regards you as..." or "scowls at you, ready to attack"
  const conMatch = line.match(RE_CON);
  if (conMatch) {
    const npcName     = conMatch[1].trim().toLowerCase();
    const conWord     = (conMatch[2] || conMatch[3]).trim().toLowerCase();
    const displayName = CON_TARGET_MAP[npcName];
    if (displayName) {
      const levelName = CON_WORD_TO_LEVEL[conWord];
      if (levelName) {
        const newVal = LEVEL_MIDPOINTS[levelName];
        if (!factionState[charName]) factionState[charName] = {};
        factionState[charName][displayName] = newVal;
        saveFactionState();
        const updates = [{ logKey: displayName, displayName, value: newVal, level: levelName, source: 'con' }];
        broadcast({ type: 'factionUpdate', charName, updates });
        log(`[CON] ${charName} → ${displayName}: ${levelName} (${newVal})`);
      }
    }
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
  let lastNotesHash = '';

  // Read current file at startup and send as baseline so the renderer knows
  // which lines already existed — prevents the first real /note from being eaten
  // by the renderer's baseline-detection logic.
  if (fs.existsSync(_config.notesFile)) {
    try {
      const text = fs.readFileSync(_config.notesFile, 'utf8');
      const hash = crypto.createHash('md5').update(text).digest('hex');
      lastNotesHash = hash;
      broadcast({ type: 'notesBaseline', text, timestamp: Date.now() });
      log('[NOTES] Baseline sent —', text.split('\n').filter(Boolean).length, 'existing lines');
    } catch (e) { err('[NOTES] Error reading baseline:', e.message); }
  } else {
    // File doesn't exist yet — baseline is zero lines, send empty baseline
    broadcast({ type: 'notesBaseline', text: '', timestamp: Date.now() });
    log('[NOTES] notes.txt not found — baseline set to zero lines');
  }

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
      const hash = crypto.createHash('md5').update(text).digest('hex');
      if (hash === lastNotesHash) return;
      lastNotesHash = hash;
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
