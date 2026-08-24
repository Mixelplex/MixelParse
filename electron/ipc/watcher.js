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
let sbCache      = {};   // { filename: hash } for dedup (spellbook)
let sbContent    = {};   // { filename: content } for sendFullSnapshot (spellbook)
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

// Corpse inventory dumps ("Mixelmedic's corpse1652-Inventory.txt") are not
// characters — /outputfile inventory with a corpse window open creates these.
const RE_CORPSE_INV = /'s corpse\d*-Inventory\.txt$/i;

function getMyChars() {
  // Derive character list from inventory filenames in EQ dir
  if (!_config || !_config.eqDir) return [];
  try {
    return fs.readdirSync(_config.eqDir)
      .filter(f => /-Inventory\.txt$/i.test(f) && !RE_CORPSE_INV.test(f))
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
  for (const [filename, content] of Object.entries(sbContent)) {
    broadcast({ type: 'spellbook', filename, content });
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
  // Send notes baseline — renderer uses this to mark existing notes as already-seen
  // so they don't fire TOD modals on watcher connect. Sent here (not at startup) to
  // guarantee the renderer's IPC listener is registered before this arrives.
  if (_config && _config.notesFile) {
    try {
      if (fs.existsSync(_config.notesFile)) {
        const text = fs.readFileSync(_config.notesFile, 'utf8');
        broadcast({ type: 'notesBaseline', text, timestamp: Date.now() });
        log('[NOTES] Sent notesBaseline —', text.split('\n').filter(Boolean).length, 'existing lines marked as seen');
      }
    } catch (e) {
      err('[NOTES] notesBaseline read error:', e.message);
    }
  }
}

// ── Inventory watcher ─────────────────────────────────────────────────────────
function startInventoryWatcher() {
  if (!_config || !_config.eqDir) return;

  // Startup: scan all existing inventory files immediately
  try {
    const files = fs.readdirSync(_config.eqDir);
    log('[INV] Startup scan found', files.filter(f => f.endsWith('-Inventory.txt') && !RE_CORPSE_INV.test(f)).length, 'inventory files');
    for (const f of files) {
      if (!f.endsWith('-Inventory.txt')) continue;
      if (RE_CORPSE_INV.test(f)) continue;
      handleInvFile(path.join(_config.eqDir, f));
    }
    for (const f of files) {
      if (!/-Spellbook\.txt$/i.test(f)) continue;
      handleSpellbookFile(path.join(_config.eqDir, f));
    }
  } catch (e) {
    err('Startup inventory scan error:', e.message);
  }

  // Watch directory for inventory file changes via mtime polling
  const invMtimes = {};
  const sbMtimes = {};
  const t = setInterval(() => {
    try {
      const files = fs.readdirSync(_config.eqDir);
      for (const f of files) {
        if (!f.endsWith('-Inventory.txt')) continue;
        if (RE_CORPSE_INV.test(f)) continue;
        const fp = path.join(_config.eqDir, f);
        try {
          const mtime = fs.statSync(fp).mtimeMs;
          if (invMtimes[f] !== mtime) {
            invMtimes[f] = mtime;
            handleInvFile(fp);
          }
        } catch {}
      }
      for (const f of files) {
        if (!/-Spellbook\.txt$/i.test(f)) continue;
        const fp = path.join(_config.eqDir, f);
        try {
          const mtime = fs.statSync(fp).mtimeMs;
          if (sbMtimes[f] !== mtime) {
            sbMtimes[f] = mtime;
            handleSpellbookFile(fp);
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

function handleSpellbookFile(fp) {
  try {
    const content = fs.readFileSync(fp, 'utf8');
    const filename = path.basename(fp);
    const hash = crypto.createHash('md5').update(content).digest('hex');
    if (sbCache[filename] === hash) return; // no change
    sbCache[filename] = hash;
    sbContent[filename] = content;
    broadcast({ type: 'spellbook', filename, content });
    log('[SPELLBOOK] Sent:', filename);
  } catch (e) {
    err('Failed to read spellbook file:', fp, e.message);
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
          const stat = fs.statSync(fp);
          const key  = resolveCharKey(charName);
          const pos  = logPositions[key] || 0;
          if (stat.size > pos) tailLogFile(fp, charName);
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
  const m = path.basename(fp).match(/^eqlog_(.+?)_P1999Green(?:\.\d{4}-\d{2}(?:-\d+)?)?\.(?:txt|old)$/i);
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

// ── Concealment state (hide / sneak / invis) ─────────────────────────────────
// A CON that lands while the character is concealed reads Indifferent whenever
// the mob can't see through it — a FALSE reading, not a degraded one. So when
// any concealment flag is set we SUPPRESS the con faction write entirely and
// leave the last trustworthy value in place (stale-but-true beats fresh-false).
// All strings confirmed against a real Mixelshank P1999Green log + P99 wiki.
// Invis is source-agnostic on P99: "You vanish."/"You appear." fire regardless
// of spell/potion/clicky and even for group-cast invis, so no spell list is
// needed. "You feel yourself starting to appear." is only a fade WARNING (invis
// usually ticks back), so it is deliberately NOT treated as an off event.
let _concealByChar = {};   // charName → { hidden:bool, sneaking:bool, invis:bool }
function _conceal(charName) {
  return _concealByChar[charName] || (_concealByChar[charName] = { hidden: false, sneaking: false, invis: false });
}
function _isConcealed(charName) {
  const c = _concealByChar[charName];
  return !!(c && (c.hidden || c.sneaking || c.invis));
}
// success = ON, everything else in each group = OFF
const RE_HIDE_ON    = /^\[.+?\] You have hidden yourself from view\./;
const RE_HIDE_OFF   = /^\[.+?\] You (?:have moved and are no longer hidden!!|are no longer hidden\.|stop hiding\.)/;
const RE_SNEAK_ON   = /^\[.+?\] You are as quiet as a cat stalking its prey\./;
const RE_SNEAK_OFF  = /^\[.+?\] You stop sneaking\./;
const RE_INVIS_ON   = /^\[.+?\] You vanish\./;
const RE_INVIS_OFF  = /^\[.+?\] You appear\./;

// ── Con-based faction detection ──────────────────────────────────────────────
// Matches: "A frost giant regards you as an ally."
//          "Nanzata the Warder regards you warmly."
//          "A frost giant scowls at you, ready to attack!"
const RE_CON = /^\[.+?\] (.+?) (?:(?:(?:regards|considers|judges) you|glares at you) (?:as an? )?\w*?\b(ally|warmly|kindly|amiably?|indifferently?|apprehensively?|dubiously?|threateningly?)|(ally|warmly|kindly|amiably?|indifferently?|apprehensively?|dubiously?|threateningly?) (?:regards|considers|judges) you|(scowls) at you)/i;

// ── Session tracker regexes ──────────────────────────────────────────────────
const RE_YOU_SLAIN      = /^\[.+?\] You have slain (.+?)!/i;
const RE_SESSION_LOGIN  = /Welcome to EverQuest!/;
const RE_SESSION_XP     = /You gain (?:party )?experience!!/;
const RE_SESSION_LOOT   = /--You have looted (?:a |an )?(.+?)\.--/i;
const RE_SESSION_VENDOR = /\] You receive (.+?) from .+? for the .+?\(s\)\./;
const RE_SESSION_COIN   = /\] You receive (.+?) from the corpse\./;
const RE_SESSION_CAMP   = /It will take you about 30 seconds to prepare your camp\./;

// ── Charm-kill tracking (Enchanter charmed-pet kills) ────────────────────────
//
// Core rule (Alex's insight): XP tick = 1 kill, always.
//   - EQ's slain-by log message has a SHORT visual range.
//   - EQ's XP message has a MUCH WIDER range.
//   - "Attacking X Master" pet-chat also has wide range.
//
// Strategy:
//   1. "a hill giant says, 'Attacking a cave bear Master.'" fires whenever the
//      charmed pet acquires a target. Store the TARGET as _petLastTarget.
//   2. If "X has been slain by Y" IS seen (in range) and Y is a known pet →
//      credit kill immediately + set _killCredited so the XP tick skips it.
//   3. XP tick fires → if _killCredited: clear it (direct or in-range charm).
//      Otherwise: use _petLastTarget (pet announced it) or _pendingSlainMob
//      (slain-by seen but pet identity unknown) as mob name.  Fall back to
//      "unknown" so the kill count is always exact.
//
const CHARM_SPELL_NAMES = new Set([
  'Charm', 'Beguile', 'Cajoling Whispers', 'Allure',
  "Boltran's Agacerie", 'Dictate',
]);
const RE_CHARM_CAST     = /^\[.+?\] You begin casting (.+?)\./;
const RE_SLAIN_BY_FULL  = /^\[.+?\] (.+?) has been slain by (.+?)!/i;
// EQ capitalizes sentence-leading articles ("A mistwolf has been slain...") while
// direct-kill lines keep the true name ("You have slain a mistwolf!"). Normalize the
// leading article so one mob doesn't split into two kill-count rows. Named mobs
// (no leading article) are untouched.
function normMobName(n){return String(n||'').replace(/^(A|An|The) /,(m)=>m.toLowerCase());}
// Pet attack announce. Two formats: charmed pets (Enchanter) use "<mob> says, ..." while OWNED summoned pets (Mag/Nec/Bst) use "<petname> tells you, ...". Match both so summoner kills attribute (Gargemel
// bug: pet Gobann uses 'tells you', 837 attacks were silently dropped).
const RE_PET_ATTACK     = /^\[.+?\] (.+?) (?:says?|tells you),? '?Attacking (.+?) Master\.?'?/i;
const RE_LOC            = /Your Location is ([\d.-]+),\s*([\d.-]+),\s*([\d.-]+)/;
const RE_CHARM_BROKE    = /Your charm spell has worn off\./;
const CHARM_CONFIRM_MS  = 8 * 1000;
const _charmLastCast    = {};    // { [charName]: timestamp }
const _charmedPets      = {};    // { [charName]: Set<lowerPetName> } — known pet names
const _prevFactionSaysByChar = {};   // v1.4.18 was prev line a faction/says line? (turn-in detection)
const _lastDeathByChar  = {};    // v1.4.18 last death-message ts per char (turn-in guard)
const _petLastTarget    = {};    // { [charName]: mobName } — most recent attack target
const _pendingSlainMob  = {};    // { [charName]: { mob, ts } } — in-range slain-by
const _killCredited     = {};    // { [charName]: timestamp } — kill already credited, skip XP
const _lastLocByChar    = {};    // { [charName]: { x, y, z } } — most recent /loc
const _activePetByChar  = {};    // { [charName]: { petType, loc } } — current charm pet
const _charmBrokeByChar = {};    // { [charName]: boolean } — charm worn off, mob hostile

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

// ── Coin parser ───────────────────────────────────────────────────────────────
function parsePlatAmount(str) {
  let total = 0;
  const pp = str.match(/(\d+)\s+platinum/i); if (pp) total += parseInt(pp[1]);
  const gp = str.match(/(\d+)\s+gold/i);     if (gp) total += parseInt(gp[1]) * 0.1;
  const sp = str.match(/(\d+)\s+silver/i);   if (sp) total += parseInt(sp[1]) * 0.01;
  const cp = str.match(/(\d+)\s+copper/i);   if (cp) total += parseInt(cp[1]) * 0.001;
  return Math.round(total * 100) / 100;
}



// ── Log line processor ────────────────────────────────────────────────────────
// Handles faction/zone/con AND all session tracking events.
function processLogLine(line, charName) {

  // Concealment transitions (hide / sneak / invis) — tracked for CON suppression.
  // Cheap tests first; these lines carry nothing else we track, so return early.
  if (RE_HIDE_ON.test(line))   { _conceal(charName).hidden = true;    return; }
  if (RE_HIDE_OFF.test(line))  { _conceal(charName).hidden = false;   return; }
  if (RE_SNEAK_ON.test(line))  { _conceal(charName).sneaking = true;  return; }
  if (RE_SNEAK_OFF.test(line)) { _conceal(charName).sneaking = false; return; }
  if (RE_INVIS_ON.test(line))  { _conceal(charName).invis = true;     return; }
  if (RE_INVIS_OFF.test(line)) { _conceal(charName).invis = false;    return; }

  // Zone change
  const zoneMatch = line.match(/You have entered (.+)\./);
  if (zoneMatch) {
    const zone = zoneMatch[1].trim();
    zoneState[charName] = { zone, timestamp: Date.now() };
    broadcast({ type: 'zoneUpdate', charName, zone, timestamp: Date.now() });
    // Clear charm state on zone change
    delete _activePetByChar[charName];
    delete _charmBrokeByChar[charName];
    delete _concealByChar[charName];   // zoning drops hide/sneak/invis
    log(`[ZONE] ${charName} → ${zone}`);
    return;
  }

  // Bind point. Two live signals, forward-looking only (no historical backfill —
  // a bind that happened before the watcher was running leaves nothing to read):
  //   1) /charinfo readout — names the zone directly, works from anywhere.
  //   2) Bind Affinity landing — doesn't name the zone, so resolve it from the
  //      character's current zone (you bind where you stand).
  const boundInMatch = line.match(/You are currently bound in:\s*(.+)/);
  if (boundInMatch) {
    const zone = boundInMatch[1].replace(/[\r\s]+$/, '').trim();
    if (zone) {
      broadcast({ type: 'bindUpdate', charName, zone, src: 'charinfo', timestamp: Date.now() });
      log(`[BIND] ${charName} /charinfo -> ${zone}`);
    }
    return;
  }
  if (/You feel yourself bind to the area\./.test(line)) {
    const z = zoneState[charName] && zoneState[charName].zone;
    if (z) {
      broadcast({ type: 'bindUpdate', charName, zone: z, src: 'affinity', timestamp: Date.now() });
      log(`[BIND] ${charName} bind affinity -> ${z} (current zone)`);
    } else {
      log(`[BIND] ${charName} bind affinity but current zone unknown — skipped`);
    }
    return;
  }

  // Location tracking — update _lastLocByChar for charm + pin attribution
  const locM = line.match(RE_LOC);
  if (locM) {
    const loc = { x: parseFloat(locM[1]), y: parseFloat(locM[2]), z: parseFloat(locM[3]) };
    _lastLocByChar[charName] = loc;
    broadcast({ type: 'locUpdate', charName, x: loc.x, y: loc.y, z: loc.z });
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
    const conWord     = (conMatch[2] || conMatch[3] || conMatch[4]).trim().toLowerCase();
    const displayName = CON_TARGET_MAP[npcName];
    if (displayName) {
      // Suppress while concealed: a con under hide/sneak/invis reads Indifferent
      // against any mob that can't see through it — false, not trustworthy.
      if (_isConcealed(charName)) {
        const c = _conceal(charName);
        const why = [c.hidden && 'hidden', c.sneaking && 'sneaking', c.invis && 'invis'].filter(Boolean).join('+');
        log(`[CON] ${charName} → ${displayName}: SUPPRESSED (${why}) — con unreliable while concealed`);
        return;
      }
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

  // ── Session tracking ──────────────────────────────────────────────────────
  // All calls to processLogLine in this IPC watcher are live (startup sets
  // positions to EOF before polling begins), so no isLive guard is needed.

  if (RE_SESSION_LOGIN.test(line)) {
    broadcast({ type: 'sessionLogin', charName });
    delete _charmLastCast[charName];
    delete _pendingSlainMob[charName];
    delete _petLastTarget[charName];
    delete _killCredited[charName];
    delete _activePetByChar[charName];
    delete _charmBrokeByChar[charName];
    delete _prevFactionSaysByChar[charName];
    delete _lastDeathByChar[charName];
    if (_charmedPets[charName]) _charmedPets[charName].clear();
    delete _concealByChar[charName];   // fresh login → no concealment
    log(`[SESSION] ${charName} login detected`);
  }

  // Prev-line turn-in classification (v1.4.18)
  const _wasTurnin = _prevFactionSaysByChar[charName] === true;
  _prevFactionSaysByChar[charName] = (/^\[.+?\] Your faction standing/.test(line) || /^\[.+?\] [A-Z][a-zA-Z`' ]+ says,/.test(line));
  if (RE_SESSION_XP.test(line)) {
    broadcast({ type: 'sessionXP', charName });
    if (_killCredited[charName]) {
      // Kill was already credited (direct kill or in-range charm with known pet).
      // XP is just confirmation — don't double-count.
      delete _killCredited[charName];
    } else {
      // Kill happened but wasn't credited yet (out-of-range charm, or in-range
      // slain-by with unknown slayer).  XP = kill, so credit it now.
      const pending = _pendingSlainMob[charName];
      let mobName;
      if (_wasTurnin) {
        // FIX #1 (v1.4.18): prev line was faction/says → turn-in, NOT a kill. Suppress.
        // BEFORE pendingSlain so a stale kill can't absorb the turn-in tick.
        delete _pendingSlainMob[charName]; delete _petLastTarget[charName];
        return;
      } else if (pending && (Date.now() - pending.ts) < CHARM_CONFIRM_MS) {
        mobName = pending.mob;                       // in-range slain-by → real kill
      } else {
        mobName = _petLastTarget[charName] || 'unknown';
      }
      broadcast({ type: 'sessionKill', charName, mob: normMobName(mobName), loc: _lastLocByChar[charName] || null });
      log(`[SESSION] ${charName} kill via XP: "${mobName}"`);
      delete _pendingSlainMob[charName];
      delete _petLastTarget[charName];
    }
  }

  // Direct kill by the player — credit immediately and mark so XP doesn't double-count
  const killM = line.match(RE_YOU_SLAIN);
  if (killM) {
    const mob = normMobName(killM[1].trim());
    const loc  = _lastLocByChar[charName] || null;
    broadcast({ type: 'sessionKill', charName, mob, loc });
    _killCredited[charName] = Date.now();
    _lastDeathByChar[charName] = Date.now();
    // Spawn: detect pet death — player killed the formerly charmed mob after charm broke
    const activePet = _activePetByChar[charName];
    if (activePet && mob.toLowerCase() === activePet.petType && _charmBrokeByChar[charName]) {
      broadcast({ type: 'charmPetDied', charName, petType: activePet.petType, killedByUser: true });
      delete _activePetByChar[charName];
      delete _charmBrokeByChar[charName];
      log(`[SESSION] ${charName} killed former pet "${activePet.petType}"`);
    }
  }

  // "a hill giant says, 'Attacking a cave bear Master.'"
  // Records: (a) the pet's name for in-range slain-by matching,
  //          (b) the target mob name for out-of-range XP attribution,
  //          (c) charm acquisition signal for spawn tracking.
  const petAtkM = line.match(RE_PET_ATTACK);
  if (petAtkM) {
    const petName   = petAtkM[1].trim().toLowerCase();
    const targetMob = petAtkM[2].trim();
    if (!_charmedPets[charName]) _charmedPets[charName] = new Set();
    _charmedPets[charName].add(petName);
    _petLastTarget[charName] = targetMob;
    // QM hunt: "/pet attack Quillmane" only gets an answer if he exists in-zone.
    if (targetMob.trim().toLowerCase() === 'quillmane') {
      broadcast({ type: 'qmUp', charName });
      log(`[QM] ${charName} pet answered /pet attack Quillmane — QUILLMANE IS UP`);
    }
    log(`[SESSION] ${charName} pet "${petName}" → attacking "${targetMob}"`);
    // Spawn: new pet acquired (first message from this mob type, or after charm broke)
    const prev = _activePetByChar[charName];
    if (!prev || prev.petType !== petName) {
      const loc = _lastLocByChar[charName] || null;
      _activePetByChar[charName] = { petType: petName, loc };
      _charmBrokeByChar[charName] = false;
      broadcast({ type: 'charmAcquired', charName, petType: petName, loc });
      log(`[SESSION] ${charName} charm acquired: "${petName}"`);
    }
  }

  // Charm broke
  if (RE_CHARM_BROKE.test(line)) {
    _charmBrokeByChar[charName] = true;
    broadcast({ type: 'charmBroke', charName });
    log(`[SESSION] ${charName} charm broke`);
  }

  // Charm-cast: note timestamp (not used for kill detection, but useful for debug)
  const charmCastM = line.match(RE_CHARM_CAST);
  if (charmCastM && CHARM_SPELL_NAMES.has(charmCastM[1])) {
    _charmLastCast[charName] = Date.now();
    log(`[SESSION] ${charName} charm cast: ${charmCastM[1]}`);
  }

  // "X has been slain by Y" (in visual range)
  // If Y is a known charmed pet: credit immediately + flag so XP doesn't double.
  // Otherwise: store pending — if XP arrives within CHARM_CONFIRM_MS it uses this mob name.
  const slainByM = line.match(RE_SLAIN_BY_FULL);
  if (slainByM) {
    const slainMob  = slainByM[1].trim();
    const slayerRaw = slainByM[2].trim().toLowerCase();
    // QM hunt: a sniped Quillmane still restarts the 78s cycle. Fires for ANY
    // slayer; index.html dedups against the own/pet sessionKill within 5s.
    if (slainMob.toLowerCase() === 'quillmane') {
      broadcast({ type: 'qmSlain', charName, slayer: slainByM[2].trim() });
      log(`[QM] Quillmane slain by ${slainByM[2].trim()} (in visual range)`);
    }
    const knownPets = _charmedPets[charName];
    const loc = _lastLocByChar[charName] || null;
    const activePet = _activePetByChar[charName];
    const isOwnPet  = !!(activePet && slainMob.toLowerCase() === activePet.petType);
    _lastDeathByChar[charName] = Date.now();
    if ((knownPets && knownPets.has(slayerRaw)) || (activePet && !isOwnPet)) {
      // FIX #2 (v1.4.18): known pet OR charmed animal (named mob, never announces) — name is here
      broadcast({ type: 'sessionKill', charName, mob: normMobName(slainMob), loc });
      _killCredited[charName] = Date.now();
      delete _petLastTarget[charName];
      delete _pendingSlainMob[charName];
      log(`[SESSION] ${charName} charm-kill (in range, pet ID): ${slainMob}`);
    } else if (!isOwnPet) {
      // Slayer unknown — stash for XP confirmation.
      // Own pet's death is not a session kill — don't stash it, or a nearby
      // XP tick within the confirm window would credit it as a kill.
      _pendingSlainMob[charName] = { mob: slainMob, ts: Date.now() };
    }
    // Spawn: detect pet death — the slain mob IS the active pet, killed by something else
    if (isOwnPet && !(knownPets && knownPets.has(slayerRaw))) {
      // The pet's own death IS a kill for the counts — the charmed mob died, whoever
      // landed it (charm dragged to the group for murder, or its target finishing it).
      // Credit it and mark credited so the group-kill XP that follows doesn't
      // mis-attribute the pet's stale last-target (or 'unknown') via the XP fallback.
      broadcast({ type: 'sessionKill', charName, mob: normMobName(slainMob), loc });
      _killCredited[charName] = Date.now();
      delete _petLastTarget[charName];
      delete _pendingSlainMob[charName];
      broadcast({ type: 'charmPetDied', charName, petType: activePet.petType, killedByUser: false });
      delete _activePetByChar[charName];
      delete _charmBrokeByChar[charName];
      log(`[SESSION] ${charName} pet "${activePet.petType}" died (killed by ${slainByM[2].trim()}) — counted as kill`);
    }
  }

  const lootM = line.match(RE_SESSION_LOOT);
  if (lootM) {
    broadcast({ type: 'sessionLoot', charName, item: lootM[1].trim() });
  }

  const vendorM = line.match(RE_SESSION_VENDOR);
  if (vendorM) {
    const plat = parsePlatAmount(vendorM[1]);
    if (plat > 0) { broadcast({ type: 'sessionPlat', charName, plat, source: 'vendor' }); }
  }

  const coinM = line.match(RE_SESSION_COIN);
  if (coinM) {
    const plat = parsePlatAmount(coinM[1]);
    if (plat > 0) { broadcast({ type: 'sessionPlat', charName, plat, source: 'coin' }); }
  }

  if (RE_SESSION_CAMP.test(line)) {
    broadcast({ type: 'sessionCamp', charName });
    delete _charmLastCast[charName];
    delete _pendingCharmKill[charName];
    delete _activePetByChar[charName];
    delete _charmBrokeByChar[charName];
    log(`[SESSION] ${charName} camp-out detected`);
  }
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
// Uses setInterval mtime polling (chokidar non-functional in Electron main process on Windows)
// and byte-position tail-reading so only NEW bytes are sent — never the full file.
function startNotesWatcher() {
  if (!_config || !_config.notesFile) return;
  const fp = _config.notesFile;
  let _notesPos  = 0;
  let _notesMtime = 0;

  // Seek to end-of-file on startup so pre-existing notes are never re-fired.
  try {
    if (fs.existsSync(fp)) {
      const stat = fs.statSync(fp);
      _notesPos  = stat.size;
      _notesMtime = stat.mtimeMs;
      log(`[NOTES] notes.txt found — seeked to end (${_notesPos} bytes), watching for new entries`);
    } else {
      log(`[NOTES] notes.txt not found at ${fp} — will detect when created`);
    }
  } catch (e) {
    err('[NOTES] Startup stat error:', e.message);
  }

  const t = setInterval(() => {
    try {
      if (!fs.existsSync(fp)) return;
      const stat = fs.statSync(fp);
      // File unchanged
      if (stat.mtimeMs === _notesMtime) return;
      _notesMtime = stat.mtimeMs;
      // File was truncated/recreated — reset position
      if (stat.size < _notesPos) {
        _notesPos = 0;
        log('[NOTES] notes.txt truncated — resetting position');
      }
      if (stat.size === _notesPos) return; // mtime changed but no new bytes
      // Read only the new bytes since last position
      const fd  = fs.openSync(fp, 'r');
      const buf = Buffer.alloc(stat.size - _notesPos);
      const read = fs.readSync(fd, buf, 0, buf.length, _notesPos);
      fs.closeSync(fd);
      _notesPos += read;
      const text = buf.slice(0, read).toString('utf8');
      if (!text.trim()) return;
      // Attach most recent loc so index.html can use it for /note set pin placement
      const locVals = Object.values(_lastLocByChar);
      const locSnap = locVals.length > 0 ? locVals[locVals.length - 1] : null;
      broadcast({ type: 'notesUpdate', text, timestamp: Date.now(), loc: locSnap });
      log('[NOTES] Updated — sent', read, 'new bytes to renderer');
    } catch (e) {
      err('[NOTES] Poll error:', e.message);
    }
  }, 500);

  _timers.push(t);
  log('Notes watcher started (mtime polling every 500ms):', fp);
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
  // Clear per-character session state
  for (const k of Object.keys(_charmLastCast))   delete _charmLastCast[k];
  for (const k of Object.keys(_pendingSlainMob)) delete _pendingSlainMob[k];
  for (const k of Object.keys(_petLastTarget))   delete _petLastTarget[k];
  for (const k of Object.keys(_killCredited))    delete _killCredited[k];
  for (const k of Object.keys(_charmedPets))     delete _charmedPets[k];
  for (const k of Object.keys(_lastLocByChar))   delete _lastLocByChar[k];
  for (const k of Object.keys(_activePetByChar)) delete _activePetByChar[k];
  for (const k of Object.keys(_charmBrokeByChar))delete _charmBrokeByChar[k];
  log('Watcher stopped.');
}

// ── Historic kill count scan ──────────────────────────────────────────────────
// Replays the SAME kill-detection rules as the live tail (direct kills,
// in-range charm kills via pet identity, XP-confirmed out-of-range kills,
// login state resets) over entire log files from line one. TTL windows use
// LOG timestamps instead of wall clock. Broadcasts progress + a final result
// set; index.html owns persistence (wipe & rebuild in Supabase).
// Keep the rule blocks below in lockstep with the live handlers above.
let _killScanRunning = false;

const _KS_MONTHS = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };
const RE_LOG_TS = /^\[\w{3} (\w{3}) ([ \d]?\d) (\d{2}):(\d{2}):(\d{2}) (\d{4})\]/;
function _ksParseTs(line) {
  const m = line.match(RE_LOG_TS);
  if (!m) return 0;
  const mon = _KS_MONTHS[m[1]];
  if (mon === undefined) return 0;
  return new Date(+m[6], mon, +m[2], +m[3], +m[4], +m[5]).getTime();
}

function _ksCharFromPath(fp) {
  const m = path.basename(fp).match(/^eqlog_(.+?)_P1999Green(?:\.\d{4}-\d{2}(?:-\d+)?)?\.(?:txt|old)$/i);
  return m ? m[1] : null;
}

function scanOneLogForKills(fp, fileIdx, totalFiles) {
  return new Promise((resolve) => {
    const charName = _ksCharFromPath(fp) || path.basename(fp);
    let fileSize = 1;
    try { fileSize = Math.max(1, fs.statSync(fp).size); } catch(e) {}
    const counts = {};          // zoneLongName → mob → { count, firstTs, lastTs }
    let currentZone  = '';
    let killCredited = false;   // mirrors _killCredited
    let pendingSlain = null;    // mirrors _pendingSlainMob { mob, t }
    let petLastTarget = null;   // mirrors _petLastTarget
    const charmedPets = new Set();
    let activePet   = null;     // mirrors _activePetByChar { petType }
    let charmBroke  = false;    // mirrors _charmBrokeByChar
    let lineTs = 0, lineCount = 0, totalKills = 0;

    const credit = (mobRaw) => {
      const mob = normMobName(mobRaw);
      const z = currentZone || '';
      if (!counts[z]) counts[z] = {};
      let c = counts[z][mob];
      if (!c) c = counts[z][mob] = { count: 0, firstTs: lineTs, lastTs: lineTs };
      c.count++;
      if (lineTs) { c.lastTs = lineTs; if (!c.firstTs) c.firstTs = lineTs; }
      totalKills++;
    };

    const stream = fs.createReadStream(fp, { encoding: 'utf8' });
    const rl = require('readline').createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      lineCount++;
      const ts = _ksParseTs(line);
      if (ts) lineTs = ts;
      if (lineCount % 250000 === 0) {
        broadcast({ type: 'killScanProgress', charName, fileIdx, totalFiles,
                    pct: Math.min(99, Math.round(stream.bytesRead / fileSize * 100)) });
      }

      // Zone tracking
      const zm = line.match(/You have entered (.+)\./);
      if (zm) { currentZone = zm[1].trim(); return; }

      // Login → state reset (mirrors live sessionLogin block)
      if (RE_SESSION_LOGIN.test(line)) {
        killCredited = false; pendingSlain = null; petLastTarget = null;
        charmedPets.clear(); activePet = null; charmBroke = false;
        return;
      }

      // XP tick (mirrors live: credited flag suppresses double-count;
      // otherwise pending slain-by within TTL, else pet's last target)
      if (RE_SESSION_XP.test(line)) {
        if (killCredited) {
          killCredited = false;
        } else {
          const mobName = (pendingSlain && (lineTs - pendingSlain.t) < CHARM_CONFIRM_MS)
            ? pendingSlain.mob
            : (petLastTarget || 'unknown');
          credit(mobName);
          pendingSlain = null; petLastTarget = null;
        }
      }

      // Direct kill
      const killM = line.match(RE_YOU_SLAIN);
      if (killM) {
        const mob = killM[1].trim();
        credit(mob);
        killCredited = true;
        if (activePet && mob.toLowerCase() === activePet.petType && charmBroke) {
          activePet = null; charmBroke = false;
        }
      }

      // Pet attack tell
      const petAtkM = line.match(RE_PET_ATTACK);
      if (petAtkM) {
        const petName = petAtkM[1].trim().toLowerCase();
        charmedPets.add(petName);
        petLastTarget = petAtkM[2].trim();
        if (!activePet || activePet.petType !== petName) {
          activePet = { petType: petName };
          charmBroke = false;
        }
      }

      // Charm broke
      if (RE_CHARM_BROKE.test(line)) charmBroke = true;

      // Slain-by (mirrors live: known pet → credit; unknown slayer → pending
      // unless it's our own pet dying; own pet death clears charm state)
      const slainByM = line.match(RE_SLAIN_BY_FULL);
      if (slainByM) {
        const slainMob  = slainByM[1].trim();
        const slayerRaw = slainByM[2].trim().toLowerCase();
        const isOwnPet  = !!(activePet && slainMob.toLowerCase() === activePet.petType);
        if (charmedPets.has(slayerRaw)) {
          credit(slainMob);
          killCredited = true;
          petLastTarget = null; pendingSlain = null;
        } else if (!isOwnPet) {
          pendingSlain = { mob: slainMob, t: lineTs };
        }
        if (isOwnPet && !charmedPets.has(slayerRaw)) {
          // Pet's own death counts as a kill (mirrors live watcher)
          credit(slainMob);
          killCredited = true;
          petLastTarget = null; pendingSlain = null;
          activePet = null; charmBroke = false;
        }
      }
    });

    rl.on('close', () => resolve({ charName, counts, totalKills, lines: lineCount }));
    stream.on('error', (e) => resolve({ charName, counts, totalKills, lines: lineCount, error: e.message }));
  });
}

async function scanKillCountsAllLogs(charFilter) {
  if (_killScanRunning) {
    broadcast({ type: 'killScanResult', error: 'A scan is already running' });
    return;
  }
  // Only scan logs for roster characters (Characters tab), when provided
  const wanted = Array.isArray(charFilter) && charFilter.length
    ? new Set(charFilter.map(c => String(c).toLowerCase()))
    : null;
  if (!_config || !_config.logDir) {
    broadcast({ type: 'killScanResult', error: 'No log directory configured' });
    return;
  }
  _killScanRunning = true;
  try {
    const files = fs.readdirSync(_config.logDir)
      .filter(f => /^eqlog_.+_P1999Green(?:\.\d{4}-\d{2}(?:-\d+)?)?\.(?:txt|old)$/i.test(f)) // .old = rotated archives (v1.3.5) — full history preserved
      .filter(f => { if (!wanted) return true; const c = _ksCharFromPath(f); return !!(c && wanted.has(c.toLowerCase())); })
      .map(f => path.join(_config.logDir, f));
    if (!files.length) {
      broadcast({ type: 'killScanResult', error: 'No P1999Green log files found' });
      return;
    }
    log(`[KILLSCAN] Scanning ${files.length} log file(s)…`);
    const results = [];
    for (let i = 0; i < files.length; i++) {
      broadcast({ type: 'killScanProgress', charName: _ksCharFromPath(files[i]), fileIdx: i + 1, totalFiles: files.length, pct: 0 });
      const r = await scanOneLogForKills(files[i], i + 1, files.length);
      log(`[KILLSCAN] ${r.charName}: ${r.totalKills} kill(s) across ${r.lines} line(s)${r.error ? ' (ERROR: ' + r.error + ')' : ''}`);
      results.push(r);
    }
    broadcast({ type: 'killScanResult', results });
  } catch(e) {
    err('[KILLSCAN]', e.message);
    broadcast({ type: 'killScanResult', error: e.message });
  } finally {
    _killScanRunning = false;
  }
}

// ── Historic session backfill scan ────────────────────────────────────────────
// Replays entire log files and slices them into play sessions. Boundaries:
// login line, camp line, or a gap of idleGapMin minutes with no log lines
// (ANY timestamped line counts as activity — the log is chatty during play).
// Kill attribution MIRRORS the live handlers and scanOneLogForKills — keep all
// THREE sites in lockstep. Rotated (.old) archives are scanned in chronological
// order per character with state carried across files, so a mid-play 250MB
// rotation cannot split a session. Backfilled sessions carry src:'backfill'
// and null XP% fields (a log replay counts ticks, never percent).
// index.html owns loot pricing, char-day dedup, and persistence.
let _sessScanRunning = false;

function _ssFileSortKey(fp) {
  // eqlog_Char_P1999Green.YYYY-MM(-n).(txt|old) → chronological; live (unsuffixed) file last
  const m = path.basename(fp).match(/\.(\d{4})-(\d{2})(?:-(\d+))?\.(?:txt|old)$/i);
  if (m) return (+m[1]) * 100000 + (+m[2]) * 1000 + (+(m[3] || 0));
  return Number.MAX_SAFE_INTEGER;
}

function _ssNewCharState() {
  return {
    // charm/kill attribution — mirrors live handlers & scanOneLogForKills
    killCredited: false, pendingSlain: null, petLastTarget: null,
    charmedPets: new Set(), activePet: null, charmBroke: false,
    // session slicing
    sess: null,        // open session accumulator or null
    lastLineTs: 0,     // ts of previous timestamped line (any line = activity)
    currentZone: '',
  };
}

function _ssOpen(st, ts) {
  st.sess = { start: ts, lastActivity: ts, xp: 0, kills: {}, killTotal: 0,
              loot: [], platV: 0, platC: 0, zoneMs: {},
              killEvents: [] };   // {t, mob} per credited kill — lets the importer reattribute
                                  // kills to stored sessions by exact timestamp (v1.4.17)
}

function _ssCloseSession(charName, st, out) {
  const s = st.sess;
  st.sess = null;
  if (!s) return;
  // Mirror the live empty-session filter (savePlaySession): no xp, kills, or loot → discard
  if (s.xp === 0 && s.killTotal === 0 && s.loot.length === 0) return;
  // Primary zone = where the most active time was spent
  let zone = null, best = -1;
  for (const z of Object.keys(s.zoneMs)) {
    if (s.zoneMs[z] > best) { best = s.zoneMs[z]; zone = z; }
  }
  out.push({
    id: s.start, char: charName, start: s.start, end: s.lastActivity,
    zone: zone || st.currentZone || null,
    xp: s.xp, xpPct: null,
    kills: s.kills, killTotal: s.killTotal,
    killEvents: s.killEvents || [],   // consumed by the importer's repair pass, stripped before persist
    loot: s.loot,
    plat:  Math.round((s.platV + s.platC) * 100) / 100,
    platV: Math.round(s.platV * 100) / 100,
    platC: Math.round(s.platC * 100) / 100,
    startXpPct: null, endXpPct: null, xpGained: null,
    src: 'backfill',
  });
}

function _ssLine(charName, st, line, gapMs, out) {
  const ts = _ksParseTs(line);
  if (!ts) return;   // untimestamped continuation lines carry nothing we track

  const isLogin = RE_SESSION_LOGIN.test(line);
  const isCamp  = RE_SESSION_CAMP.test(line);

  // Boundary: idle gap — close at the session's last activity, before this line
  if (st.sess && ts - st.lastLineTs > gapMs) _ssCloseSession(charName, st, out);

  // Boundary: login — close prior session + charm-state reset (mirrors live sessionLogin)
  if (isLogin) {
    _ssCloseSession(charName, st, out);
    st.killCredited = false; st.pendingSlain = null; st.petLastTarget = null;
    st.charmedPets.clear(); st.activePet = null; st.charmBroke = false;
  }

  // Zone-time accrual for the still-open session (delta > gap already closed above)
  if (st.sess && st.currentZone && st.lastLineTs) {
    const delta = ts - st.lastLineTs;
    if (delta > 0 && delta <= gapMs) {
      st.sess.zoneMs[st.currentZone] = (st.sess.zoneMs[st.currentZone] || 0) + delta;
    }
  }
  st.lastLineTs = ts;

  if (!st.sess) _ssOpen(st, ts);
  st.sess.lastActivity = ts;

  const sess = st.sess;
  const credit = (mobRaw) => {
    const mob = normMobName(mobRaw);
    sess.kills[mob] = (sess.kills[mob] || 0) + 1;
    sess.killTotal++;
    sess.killEvents.push({ t: ts, mob });   // timestamped for importer reattribution
  };

  // Zone tracking
  const zm = line.match(/You have entered (.+)\./);
  if (zm) { st.currentZone = zm[1].trim(); return; }

  // Turn-in / faction-XP context (v1.4.18): quest hand-ins and faction grants emit
  // 'You gain experience!!' with NO death message — only faction-standing and/or an NPC
  // 'says' line. Flag those so the XP handler doesn't mint a phantom 'unknown' kill.
  // Prev-line classification for turn-in detection (v1.4.18): a turn-in / faction-XP tick is
  // immediately preceded by a faction-standing or NPC-'says' line (and NOT a death line).
  const _wasTurninCtx = st.prevFactionSays === true;
  st.prevFactionSays = (/^\[.+?\] Your faction standing/.test(line) || /^\[.+?\] [A-Z][a-zA-Z`' ]+ says,/.test(line));

  // XP tick (mirrors live: credited flag suppresses double-count;
  // otherwise pending slain-by within TTL, else pet's last target)
  if (RE_SESSION_XP.test(line)) {
    sess.xp++;
    if (st.killCredited) {
      st.killCredited = false;
    } else if (_wasTurninCtx) {
      // FIX #1: prev line was faction/says → turn-in / faction XP, NOT a kill. Suppress.
      // Checked BEFORE pendingSlain so a stale kill's mob name can't absorb turn-in ticks.
      st.pendingSlain = null; st.petLastTarget = null;
    } else if (st.pendingSlain && (ts - st.pendingSlain.t) < CHARM_CONFIRM_MS) {
      credit(st.pendingSlain.mob);
      st.pendingSlain = null; st.petLastTarget = null;
    } else {
      credit(st.petLastTarget || 'unknown');
      st.pendingSlain = null; st.petLastTarget = null;
    }
  }

  // Direct kill
  const killM = line.match(RE_YOU_SLAIN);
  if (killM) {
    const mob = killM[1].trim();
    credit(mob);
    st.killCredited = true;
    st.lastDeathTs = ts;
    if (st.activePet && mob.toLowerCase() === st.activePet.petType && st.charmBroke) {
      st.activePet = null; st.charmBroke = false;
    }
  }

  // Pet attack tell
  const petAtkM = line.match(RE_PET_ATTACK);
  if (petAtkM) {
    const petName = petAtkM[1].trim().toLowerCase();
    st.charmedPets.add(petName);
    st.petLastTarget = petAtkM[2].trim();
    if (!st.activePet || st.activePet.petType !== petName) {
      st.activePet = { petType: petName };
      st.charmBroke = false;
    }
  }

  // Charm broke
  if (RE_CHARM_BROKE.test(line)) st.charmBroke = true;

  // Slain-by (mirrors live: known pet → credit; unknown slayer → pending
  // unless it's our own pet dying; own pet death counts as a kill + clears charm state)
  const slainByM = line.match(RE_SLAIN_BY_FULL);
  if (slainByM) {
    const slainMob  = slainByM[1].trim();
    const slayerRaw = slainByM[2].trim().toLowerCase();
    const isOwnPet  = !!(st.activePet && slainMob.toLowerCase() === st.activePet.petType);
    st.lastDeathTs = ts;
    // FIX #2 (v1.4.18): a charmed ANIMAL is a named mob that never says 'Attacking Master',
    // so it's absent from charmedPets. When a charm is/was active and the slain thing isn't
    // our own pet, the slayer is that charmed animal — the mob name is right here, credit it.
    if (st.charmedPets.has(slayerRaw) || (st.activePet && !isOwnPet)) {
      credit(slainMob);
      st.killCredited = true;
      st.petLastTarget = null; st.pendingSlain = null;
    } else if (!isOwnPet) {
      st.pendingSlain = { mob: slainMob, t: ts };
    }
    if (isOwnPet && !st.charmedPets.has(slayerRaw)) {
      credit(slainMob);
      st.killCredited = true;
      st.petLastTarget = null; st.pendingSlain = null;
      st.activePet = null; st.charmBroke = false;
    }
  }

  // Loot / vendor / coin (prices resolved renderer-side — watcher has no price data)
  const lootM = line.match(RE_SESSION_LOOT);
  if (lootM) sess.loot.push({ item: lootM[1].trim(), price: null });

  const vendorM = line.match(RE_SESSION_VENDOR);
  if (vendorM) {
    const p = parsePlatAmount(vendorM[1]);
    if (p > 0) sess.platV += p;
  }

  const coinM = line.match(RE_SESSION_COIN);
  if (coinM) {
    const p = parsePlatAmount(coinM[1]);
    if (p > 0) sess.platC += p;
  }

  // Boundary: camp — close INCLUDING this line as the end; mirror live camp reset
  if (isCamp) {
    _ssCloseSession(charName, st, out);
    st.activePet = null; st.charmBroke = false;
  }
}

function _ssScanOneFile(fp, charName, st, gapMs, out, fileIdx, totalFiles) {
  return new Promise((resolve) => {
    let fileSize = 1;
    try { fileSize = Math.max(1, fs.statSync(fp).size); } catch(e) {}
    let lineCount = 0;
    const stream = fs.createReadStream(fp, { encoding: 'utf8' });
    const rl = require('readline').createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      lineCount++;
      if (lineCount % 250000 === 0) {
        broadcast({ type: 'sessScanProgress', charName, fileIdx, totalFiles,
                    pct: Math.min(99, Math.round(stream.bytesRead / fileSize * 100)) });
      }
      _ssLine(charName, st, line, gapMs, out);
    });
    rl.on('close', () => resolve());
    stream.on('error', (e) => { err('[SESSSCAN]', fp, e.message); resolve(); });
  });
}

async function scanLogsForSessions(charFilter, idleGapMin) {
  if (_sessScanRunning) {
    broadcast({ type: 'sessScanResult', error: 'A session scan is already running' });
    return;
  }
  if (!_config || !_config.logDir) {
    broadcast({ type: 'sessScanResult', error: 'No log directory configured' });
    return;
  }
  const gapMs = Math.max(5, Number(idleGapMin) || 30) * 60 * 1000;
  const wanted = Array.isArray(charFilter) && charFilter.length
    ? new Set(charFilter.map(c => String(c).toLowerCase()))
    : null;
  _sessScanRunning = true;
  try {
    const all = fs.readdirSync(_config.logDir)
      .filter(f => /^eqlog_.+_P1999Green(?:\.\d{4}-\d{2}(?:-\d+)?)?\.(?:txt|old)$/i.test(f))
      .filter(f => { if (!wanted) return true; const c = _ksCharFromPath(f); return !!(c && wanted.has(c.toLowerCase())); })
      .map(f => path.join(_config.logDir, f));
    if (!all.length) {
      broadcast({ type: 'sessScanResult', error: 'No P1999Green log files found' });
      return;
    }
    // Group per character; chronological within each so state spans rotations
    const byChar = {};
    for (const fp of all) {
      const c = _ksCharFromPath(fp);
      if (!c) continue;
      (byChar[c] = byChar[c] || []).push(fp);
    }
    for (const c of Object.keys(byChar)) byChar[c].sort((a, b) => _ssFileSortKey(a) - _ssFileSortKey(b));
    const totalFiles = all.length;
    log(`[SESSSCAN] Scanning ${totalFiles} log file(s) for play sessions (gap ${gapMs / 60000}m)…`);
    const sessions = [];
    let fileIdx = 0;
    for (const charName of Object.keys(byChar)) {
      const st = _ssNewCharState();
      for (const fp of byChar[charName]) {
        fileIdx++;
        broadcast({ type: 'sessScanProgress', charName, fileIdx, totalFiles, pct: 0 });
        await _ssScanOneFile(fp, charName, st, gapMs, sessions, fileIdx, totalFiles);
      }
      _ssCloseSession(charName, st, sessions);   // flush trailing open session
    }
    sessions.sort((a, b) => b.start - a.start);
    log(`[SESSSCAN] Done — ${sessions.length} session(s) reconstructed`);
    broadcast({ type: 'sessScanResult', sessions, filesScanned: totalFiles });
  } catch(e) {
    err('[SESSSCAN]', e.message);
    broadcast({ type: 'sessScanResult', error: e.message });
  } finally {
    _sessScanRunning = false;
  }
}

function command(cmd, args) {
  if (cmd === 'requestAll') {
    sendFullSnapshot();
  } else if (cmd === 'reload') {
    stop();
    start({ config: _config, logPosPath: _logPosPath, factionPath: _factionPath, onMessage: _onMessage });
  } else if (cmd === 'scanKillCounts') {
    scanKillCountsAllLogs(args && args.chars);
  } else if (cmd === 'scanSessions') {
    scanLogsForSessions(args && args.chars, args && args.idleGapMin);
  }
}

module.exports = { start, stop, command, sendFullSnapshot };
