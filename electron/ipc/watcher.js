'use strict';
// ipc/watcher.js
// Log / notes / inventory watcher (Electron main process).
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
const resistWatch = require('./resistwatch');   // silent resist data recorder (watch-only)
const skyCorpse   = require('./skycorpse');     // Plane of Sky corpses + the keys on them
const capTrack    = require('./captrack');
const fightParse  = require('./fightparse');    // one raid kill's damage / CH / boss-hit parse
let _fpWorker = null, _fpNoWorker = false;        // fight parses run in a worker thread (direct if it can't start)
const _fpPending = new Map();
function _fpDirect(job) { let result; try { result = fightParse.parseFight(job); } catch (e) { result = { ok: false, error: e.message }; } broadcast({ type: 'fightParse', id: job.id, result }); }
function _fpFail(why) { if (why) err('[PARSE] worker', why); _fpWorker = null; _fpNoWorker = true; const jobs = [..._fpPending.values()]; _fpPending.clear(); for (const j of jobs) _fpDirect(j); }      // Leatherfoot Raider Skullcap: used / recharged

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
// Below: the watcher logic (originally the standalone WebSocket watcher,
// retired in v1.3.5), with CONFIG replaced by _config and broadcast()
// pointing to the IPC shim above.
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
let _activeSent = null, _activeSentAt = 0;
const _hotLogs = new Map();   // log file → character, for the 250 ms read
let _logPosT = null;
function saveLogPositionsNow() { clearTimeout(_logPosT); _logPosT = null; if (!_logPosPath) return; try { fs.writeFileSync(_logPosPath, JSON.stringify(logPositions), 'utf8'); } catch {} }
function saveLogPositions() {   // at most every 2 s — the logs are read every 250 ms now
  if (!_logPosPath || _logPosT) return;
  _logPosT = setTimeout(saveLogPositionsNow, 2000);
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
        if (RE_CORPSE_INV.test(f)) {   // "<Name>'s corpse123-Inventory.txt" -> keys on a Sky corpse
          const cp = path.join(_config.eqDir, f);
          try { const mt = fs.statSync(cp).mtimeMs; if (invMtimes[f] !== mt) { invMtimes[f] = mt; skyCorpse.corpseInventory(f, fs.readFileSync(cp, 'utf8'), mt); } } catch {}
          continue;
        }
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
    try { skyCorpse.inventory(filename.replace(/-Inventory\.txt$/i, ''), content, fs.statSync(fp).mtimeMs); } catch {}
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
  // Inventory-file chars only scope the startup zone scan (keeps the zone bar to
  // real characters). Live tailing covers EVERY log that grows: a log only grows
  // while that character is being played, and gating on *-Inventory.txt meant a
  // fresh PC (or a toon that never ran /output inventory there) got no login/XP/
  // kill/loot events at all — so sessions never auto-started. The list was also
  // frozen at startup, missing inventory files created mid-run.
  const myChars = getMyChars().map(c => c.toLowerCase());
  log('Log watcher started; startup zone scan for:', myChars.join(', ') || '(none)');

  // Poll log files for changes via size — chokidar unreliable in Electron main process
  const t = setInterval(() => {
    try {
      const files = fs.readdirSync(_config.logDir);
      for (const f of files) {
        if (!/^eqlog_.+_P1999Green\.txt$/i.test(f)) continue;
        const charName = extractCharFromLog(f);
        if (!charName) continue;
        const fp = path.join(_config.logDir, f);
        try {
          const stat = fs.statSync(fp);
          const key  = resolveCharKey(charName);
          // Every log present at startup was seeded to EOF below, so an unknown key
          // here is a log created after startup (new toon) — read it from the top.
          const pos  = logPositions[key] || 0;
          if (Date.now() - stat.mtimeMs < 10 * 60e3) _hotLogs.set(fp, charName); else _hotLogs.delete(fp);   // being written: read it fast
          if (stat.size > pos) tailLogFile(fp, charName);
        } catch {}
      }
      // the characters being played (log written in the last 10 min) — CH chain's Auto
      const act = [...new Set(_hotLogs.values())].sort().join('|');
      if (act !== _activeSent || Date.now() - _activeSentAt > 60e3) { _activeSent = act; _activeSentAt = Date.now(); broadcast({ type: 'activeChars', chars: act ? act.split('|') : [] }); }
    } catch (e) {
      err('[LOG] Poll error:', e.message);
    }
  }, 2000);
  _timers.push(t);
  // the logs being written right now: every 250 ms, so spell timers / tells / chain calls show up at once
  const tHot = setInterval(() => {
    for (const [fp, charName] of _hotLogs) { try { const pos = logPositions[resolveCharKey(charName)] || 0; if (fs.statSync(fp).size > pos) tailLogFile(fp, charName); } catch {} }
  }, 250);
  _timers.push(tHot);

  // Startup: seed EVERY live log to EOF (live-only — no backlog replay), then
  // zone-scan just the inventory-file characters.
  try {
    const files = fs.readdirSync(_config.logDir);
    for (const f of files) {
      if (!/^eqlog_.+_P1999Green\.txt$/i.test(f)) continue;
      const charName = extractCharFromLog(f);
      if (!charName) continue;
      const fp = path.join(_config.logDir, f);
      const key = resolveCharKey(charName);
      try { logPositions[key] = fs.statSync(fp).size; } catch {}
      if (myChars.includes(charName.toLowerCase())) scanLastZoneFromLog(fp, charName);
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

  // Only complete lines: EQ can flush part-way through a line, and the two halves of a split line
  // never match anything (a RAIDTICK cut in two was simply lost). The tail waits for the next poll.
  const lastNl = buf.lastIndexOf(10, read - 1);
  if (lastNl < 0) return;
  logPositions[key] = pos + lastNl + 1;
  saveLogPositions();

  const lines = buf.slice(0, lastNl + 1).toString('utf8').split('\n');
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
const TURNIN_KILL_MS    = 3 * 1000;   // a slain-by this fresh before a faction line + XP is a kill, not a turn-in (2026-10-25: ToFS group kills)
const _charmLastCast    = {};    // { [charName]: timestamp }
const _charmedPets      = {};    // { [charName]: Set<lowerPetName> } — known pet names
const _prevFactionSaysByChar = {};   // v1.4.18 was prev line a faction/says line? (turn-in detection)
const RE_WHO_SELF = /^\[[^\]]+\] \[(\d+) ([A-Za-z ]+)\] ([A-Za-z]+) \(([A-Za-z ]+)\)/;   // "[60 Hierophant] Mixelplex (Wood Elf) <Castle>"
const RE_SELF_DEATH = /^\[[^\]]+\] (?:You have been slain by (.+?)!|You died\.)\s*$/;
const _lastDeathByChar  = {};    // v1.4.18 last death-message ts per char (turn-in guard)
const _petLastTarget    = {};    // { [charName]: mobName } — most recent attack target
// ── Faction data from the P99 wiki's NPC pages (2026-10-08; regenerate with session-data gen-faction-data.js) ──
// FACTION_HITS: npc name (lower case) → [[wiki zone, [[faction key, amount], …]], …] — the exact hits for killing it.
// Faction keys are lower-case letters/digits ("ClawsofVeeshan" in the log → "clawsofveeshan").
let FACTION_HITS = {};
try { FACTION_HITS = require('./faction-hits.json'); } catch (e) { console.error('[Watcher] faction-hits.json not loaded:', e.message); }
const _facKey = s => String(s || '').toLowerCase().replace(/\(faction\)/g, '').replace(/[^a-z0-9]/g, '');
const _zoneKey = s => String(s || '').toLowerCase().replace(/^the /, '').replace(/[^a-z0-9]/g, '').replace(/s$/, '');
const _lastKillFac = {};   // { [charName]: { mob, ts } } — the kill whose faction lines follow it (same second)
// The exact hit for this mob and faction: the page in the character's zone if the mob has several, else the one
// amount every page agrees on. null = not on the wiki → the old ±5 nudge.
function factionHitFor(mob, factionLogKey, zone) {
  const pages = FACTION_HITS[String(mob || '').toLowerCase()]; if (!pages) return null;
  const fk = _facKey(factionLogKey), zk = _zoneKey(zone);
  const found = pages.map(([z, h]) => [z, (h.find(x => x[0] === fk) || [])[1]]).filter(x => x[1] != null);
  if (!found.length) return null;
  const here = found.find(x => zk && (_zoneKey(x[0]) === zk || _zoneKey(x[0]).includes(zk) || zk.includes(_zoneKey(x[0]))));
  if (here) return here[1];
  return found.every(x => x[1] === found[0][1]) ? found[0][1] : null;
}
const _pendingSlainMob  = {};    // { [charName]: { mob, ts } } — in-range slain-by
// the last mob anyone in range hit (melee or a damage shield) and the last NPC speech — for kills that print no slain line
const _lastGroupHit = {}, _lastSaysTs = {};
const RE_GROUP_HIT = /^\[[^\]]+\] (?:[A-Z][a-z]+|You) (?:hits?|slash(?:es)?|pierces?|crush(?:es)?|kicks?|bash(?:es)?|punch(?:es)?|backstabs?|bites?|claws?|strikes?|stings?|mauls?|gores?|smash(?:es)?|rends?) (.+?) for \d+ points? of damage\.$/;
const RE_DS_HIT = /^\[[^\]]+\] (.+?) was (?:pierced by thorns|burned|tormented by frost|stung)\.$/;
function _groupHitMob(line) { let m;   // a mob name, never a player (a single capitalised word) or YOU
  if (line.indexOf(' points') > 0 && (m = RE_GROUP_HIT.exec(line))) return /^(?:[A-Z][a-z]+|YOU)$/.test(m[1]) ? null : m[1];
  if (line.indexOf(' was ') > 0 && (m = RE_DS_HIT.exec(line))) return /^[A-Z][a-z]+$/.test(m[1]) ? null : m[1];
  return null; }
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
// Con table additions from the wiki: 659 NPCs whose own faction (their biggest kill hit) is one MixelParse tracks,
// plus corrections where the wiki clearly differs (frost giants are Kromrif, not Kromzek).
try { Object.assign(CON_TARGET_MAP, require('./con-wiki.json')); } catch (e) { console.error('[Watcher] con-wiki.json not loaded:', e.message); }

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
// ── Raid kill auto-detect evidence (WATCH-ONLY) ──────────────────────────────
// Forwards raw raid signals; the renderer owns the kill-tracker roster and does
// the attribution (RAIDTICK anchor + boss evidence). Nothing is recorded here.
// Landing text per P99 spell pages: Tashanian/Wind of Tishanian "glances nervously
// about", Malo/Malosini "looks very uncomfortable", Turgur's "yawns", Forlorn "slows down".
// Prefix: a short tag ("CA RAIDTICK") or the guild name — "Castle & Co. RAIDTICK", "Castle and Co:
// Raidtick", "CASTLE RAIDTICK", "<X> <Y> Department: Raid Tick!". "RAID TICK" and the RAIDTICKK typo
// count. Questions ("who took raidtick?") and chat words as a prefix ("need raidtick") don't.
// (Before 2026-09-29 only the short tag was allowed: 935 of ~2,700 ticks in the owner's logs were
// never seen — Zlandicar 2026-09-28, "Castle & Co. RAIDTICK", had no anchor.)
const RE_RT_TICK     = /^\[.+?\] (\w+) (tells the guild|says out of character|tells the raid|shouts), '\s*(?:(?:<?castle>?(?: alliance)?|\w+ (?:&|and|n) co\.?|\w+ \w+ department|(?!(?:need|who|was|did|the|and|any|took|is|a)\b)\S{1,4})(?:\s*(?:&|and|n)\s*co\.?)?[\s:.\-*]*)?RAID ?TICK+\b(?![^']*\?)(.*)'$/i;
// The kill itself: a named mob with its own faction (the Velious dragons) — "Your faction
// standing with Zlandicar could not possibly get any worse." lands the second it dies.
const RE_RT_FACTION  = /^\[.+?\] Your faction standing with (.+?) (?:could not possibly get any worse|got worse)\.$/;
// Boss specials in melee range: rampage / flurry. Low volume, and only roster bosses count, so a
// long fight with the tick mid-fight (Avatar of War 2026-09-29) still has evidence.
const RE_RT_FIGHT    = /^\[.+?\] (.+?) (?:goes on a RAMPAGE|executes a FLURRY of attacks on (.+))!$/;   // [2] = who the flurry is on
const RE_RT_ENRAGE   = /^\[.+?\] (.+?) has become ENRAGED\.$/;
const RE_RT_SLAIN    = /^\[.+?\] (.+?) has been slain by .+!$/;
const RE_RT_YOUSLAIN = /^\[.+?\] You have slain (.+)!$/;
const RE_RT_LAND     = /^\[.+?\] (.+?) (glances nervously about|looks very uncomfortable|yawns|slows down)\.$/;
const RE_RT_CALL     = /^\[.+?\] (\w+) (tells the guild|says out of character|tells the raid|shouts|says), '(.*)'$/;
// Ring War (2026-10-10): Narandi's "Form up" = start, the Coldain captains' shouts = waves, Narandi's death = end
const RE_RT_RW       = /^\[.+?\] (?:(Narandi the Wretched) shouts, 'Kromrif! Form up!|(Zrelik the Scout|Corbin Blackwell|Dobbin Crossaxe|Garadain Glacierbane|Churn the Axeman) shouts '|(Narandi the Wretched) has been slain)/;
const RE_RT_RW2      = /^\[.+?\] (?:Narandi the Wretched shouts, '(?:(Interlopers!|Warriors! Charge)|(Silence fool!|Veterans!))|(Seneschal Aldikar) shouts, 'Outlander! You've done it!)/;
// A boss talking: NPC speech has no comma ("Fright says 'JAEJEE'", "Cazic Thule says 'You will not evade me …'",
// "Derakor the Vindicator says 'Only the strong will survive'"); players' /say has one. Only roster bosses count.
const RE_RT_SAY      = /^\[.+?\] (.+?) says '(.*)'$/;
// Zone-wide lines a boss repeats on a timer while it is UP and idle — proof it's alive, not a fight (owner, 2026-10-09:
// Cazic Thule's 10-minute "Beware all infidels…" was the only boss line before a Fear tick at 2:17 → a CT kill prompt).
const RE_RT_AMBIENT  = /Beware all infidels who dare to taint my plane/i;
const RE_RT_CALLKIND = /<\s*(tash|malo|slow|brd slow)\s*>|\b(tashed|malo|slowed)\b/i;
const RT_LAND_KIND   = { 'glances nervously about':'tash', 'looks very uncomfortable':'malo', 'yawns':'slow', 'slows down':'slow' };
const _rtGeneric     = name => /^(a|an) /i.test(name);   // "a fiery watcher" — never a roster boss
const RT_MON = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };
// The log line's own timestamp — ToD and the evidence window stay exact even when a
// burst of lines is read late. Falls back to now if the line has no stamp.
function _rtLineTs(line) {
  const m = /^\[\w{3} (\w{3}) +(\d+) (\d\d):(\d\d):(\d\d) (\d{4})\]/.exec(line);
  return m ? new Date(+m[6], RT_MON[m[1]], +m[2], +m[3], +m[4], +m[5]).getTime() : Date.now();
}
// Parse one log line into a raid signal message (raidTick / raidEvidence), or null.
function raidSignal(line, charName) {
  if (!/RAID ?TICK|ENRAGED|slain|nervously|uncomfortable|yawns\.|slows down\.|tash|malo|slow|faction standing|RAMPAGE|FLURRY| says '|Narandi|Zrelik|Corbin Blackwell|Dobbin Crossaxe|Glacierbane|Churn the Axeman|Seneschal Aldikar/i.test(line)) return null;   // cheap pre-filter
  let m; const ts = _rtLineTs(line);
  if ((m = RE_RT_RW.exec(line)))     return { type:'raidEvidence', charName, kind:'rw', sub: m[1] ? 'start' : m[3] ? 'end' : 'wave', mob: m[1] || m[2] || m[3], ts };
  if ((m = RE_RT_RW2.exec(line)))    return { type:'raidEvidence', charName, kind:'rw', sub: m[1] ? 'r2' : m[2] ? 'r3' : 'won', mob: m[3] || 'Narandi the Wretched', ts };
  if ((m = RE_RT_TICK.exec(line)))   return { type:'raidTick', charName, poster:m[1], channel:m[2], text:m[3].trim(), ts };
  // Enrage + landing lines are low-volume, so generic names pass too — some bosses are
  // "a dracoliche" / "an undead bard" in-game. Kill lines stay filtered (every trash kill).
  if ((m = RE_RT_ENRAGE.exec(line))) return { type:'raidEvidence', charName, kind:'enrage', mob:m[1], ts };
  if ((m = RE_RT_SLAIN.exec(line)) || (m = RE_RT_YOUSLAIN.exec(line))) return _rtGeneric(m[1]) ? null : { type:'raidEvidence', charName, kind:'slain', mob:m[1], ts };
  if ((m = RE_RT_LAND.exec(line)))   return { type:'raidEvidence', charName, kind:'land', sub:RT_LAND_KIND[m[2]], verb:m[2], mob:m[1], ts };
  if ((m = RE_RT_FACTION.exec(line))) return { type:'raidEvidence', charName, kind:'faction', mob:m[1], ts };
  if ((m = RE_RT_FIGHT.exec(line)))  return _rtGeneric(m[1]) ? null : { type:'raidEvidence', charName, kind:'fight', mob:m[1], target: m[2] || null, ts };
  if ((m = RE_RT_SAY.exec(line)))   return _rtGeneric(m[1]) || RE_RT_AMBIENT.test(m[2]) ? null : { type:'raidEvidence', charName, kind:'say', mob:m[1], ts };
  if ((m = RE_RT_CALL.exec(line)) && RE_RT_CALLKIND.test(m[3])) return { type:'raidEvidence', charName, kind:'call', text:m[3], poster:m[1], channel:m[2], ts };
  return null;
}
// Zone each character was in, from the lines the raid path itself sees (live tail + 6 h backfill), so a
// RAIDTICK carries the zone it was heard in — the renderer uses it with the spawn timers when a tick
// has no boss evidence in the log.
const _rtZone = {};
// A character that hasn't zoned since the app started (and has no inventory file, so no startup
// zone scan): read its last "You have entered" from the live log. No zoneUpdate broadcast.
function _lastZoneInLog(charName) {
  try {
    const fp = path.join(_config.logDir, 'eqlog_' + charName + '_P1999Green.txt');
    const st = fs.statSync(fp), n = Math.min(512 * 1024, st.size), buf = Buffer.alloc(n);
    const fd = fs.openSync(fp, 'r'); fs.readSync(fd, buf, 0, n, st.size - n); fs.closeSync(fd);
    const re = /^\[[^\]]+\] You have entered (.+)\.\r?$/gm; let m, last = null;
    const text = buf.toString('latin1'); while ((m = re.exec(text))) last = m[1];
    return last;
  } catch { return null; }
}
// Every raid signal — boss evidence too, not just ticks — carries the zone its character was in, so a
// tick only counts boss lines from its own zone (owner, 2026-10-02). A port, a /q to another character
// or a crash + relog all start a new zone: the King Tormax rampage in Kael at 7:58 must not explain
// the 8:07 Dread tick in Fear (5/7 and 7/30 in the replay did exactly that).
// "Welcome to EverQuest!" (/q swap, relog after a crash) = zone unknown until its "You have entered".
let _rtBackfilling = false;
const _rtLookedUp = new Set();   // characters whose log was already searched for a zone line
function _rtNoteZone(line, charName) {
  if (line.indexOf('You have entered ') >= 0) { const zm = /^\[[^\]]+\] You have entered (.+)\.$/.exec(line); if (zm) _rtZone[charName] = zm[1]; }
  else if (RE_SESSION_LOGIN.test(line)) _rtZone[charName] = '';
}
function _rtZoneOf(charName) {
  if (charName in _rtZone) return _rtZone[charName] || null;
  if (_rtBackfilling) return null;   // an old line before the first zone line — not today's zone
  if (zoneState[charName] && zoneState[charName].zone) return zoneState[charName].zone;
  if (!_rtLookedUp.has(charName)) { _rtLookedUp.add(charName); const z = _lastZoneInLog(charName); if (z) { _rtZone[charName] = z; return z; } }
  return null;
}
// Castle DKP auctions in /auction (owner, 2026-10-05): an officer opens one with
//   "<officer> auctions, '~[Item] - BID IN /AUC, MIN 1 DKP. You MUST include the item name in your bid! Closing in 2m30s.'"
// and bids follow as "<bidder> auctions, 'Item 5'" (also "Item5", "5 Item", "Item 3 toon"). Only lines within 15 min
// of an opening are forwarded, so trade chatter (EC tunnel) never reaches the app. "You auction" = this character.
const RE_AUC_LINE = /^\[.+?\] (\w+) auctions?, '(.*)'$/;
const RE_AUC_OPEN = /~\[([^\]]+)\]\s*-\s*BID IN \/AUC/i;
const RE_AUC_GRATS = /~\s*grat+[sz]*\s+\S+\s+on\s+\[/i;   // the officer's close — always forwarded
// an officer relaying the close in guild chat: "Bahbin tells the guild, '/AUC ~Gratss Mixelmedic on [Claw of Lightning] (285 DKP)!'"
// — the only copy a character out of the zone (or one you swapped to) sees. Only the grats is taken from a relay.
const RE_AUC_RELAY = /^\[.+?\] (\w+) tells the guild, '\s*\/auc\s+(.*)'$/i;
let _aucLastOpen = 0;
function auctionSignal(line, charName) {
  if (line.indexOf(' auction') < 0 && line.indexOf('/AUC') < 0 && line.indexOf('/auc') < 0) return;
  let m = RE_AUC_LINE.exec(line);
  if (!m) { const r = RE_AUC_RELAY.exec(line); if (!r || !RE_AUC_GRATS.test(r[2])) return; m = r; }
  const ts = _rtLineTs(line), open = RE_AUC_OPEN.test(m[2]);
  if (open) _aucLastOpen = Math.max(_aucLastOpen, ts);
  else if (!RE_AUC_GRATS.test(m[2]) && Math.abs(ts - _aucLastOpen) > 45 * 60e3) return;   // auctions stay open until grats (owner, 2026-10-05)
  broadcast({ type: 'auctionLine', charName, who: m[1] === 'You' ? charName : m[1], text: m[2], ts, open });
}
// guild / raid chat for loot mentions ("what did Fright drop?" → "Claw of Lightning") — not OOC (EC tunnel spam)
const RE_CHAT_LOOT = /^\[.+?\] (?:(\w+) (tells the guild|tells the raid|says out of character|shouts)|You (say to your guild|tell your raid|say out of character|shout)), '(.*)'$/;
function chatSignal(line, charName) {
  if (line.indexOf(' guild') < 0 && line.indexOf(' raid') < 0) return;   // guild + raid only: OOC loot calls are often another guild's kill
  const m = RE_CHAT_LOOT.exec(line); if (!m || /out of character|shout/.test(m[2] || m[3] || '')) return;
  broadcast({ type: 'chatLine', charName, who: m[1] || charName, channel: m[2] || m[3], text: m[4], ts: _rtLineTs(line), zone: _rtZoneOf(charName) });
}
function raidEvidence(line, charName) {
  _rtNoteZone(line, charName);
  auctionSignal(line, charName);
  chatSignal(line, charName);
  // a login (/q to another character, relog after a crash): the renderer marks a tick just before it "logged out before the kill"
  if (line.indexOf('Welcome to EverQuest!') >= 0 && RE_SESSION_LOGIN.test(line)) { broadcast({ type:'raidLogin', charName, ts:_rtLineTs(line) }); return; }
  const msg = raidSignal(line, charName);
  if (msg) { msg.zone = _rtZoneOf(charName); broadcast(msg); }
}

// ── Raid tick history scan (Auto-Detect → Scan logs) ─────────────────────────
// Replays every RAIDTICK in the logs (live, rotated .old, Logs\archive) plus the boss
// evidence around each one, so past raid nights can be attributed and checked against
// ODKP. Sent to the renderer as ONE batch (raidScanResult): the live path finalizes
// each tick on a timer and prunes evidence by time, which a months-long replay across
// several files would break. Evidence is trimmed to the window around some tick.
let _raidScanRunning = false;
async function scanRaidHistory(sinceMs) {
  if (_raidScanRunning) { broadcast({ type:'raidScanResult', error:'A scan is already running' }); return; }
  if (!_config || !_config.logDir) { broadcast({ type:'raidScanResult', error:'No log directory configured' }); return; }
  _raidScanRunning = true;
  const since = sinceMs || 0;
  const ticks = [], evidence = [], logins = [], seen = new Set();
  try {
    const dirs = [_config.logDir, path.join(_config.logDir, 'archive')].filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
    const files = [];
    for (const d of dirs) for (const f of fs.readdirSync(d)) if (/^eqlog_.+?_P1999Green.*\.(txt|old)$/i.test(f)) files.push(path.join(d, f));
    for (let i = 0; i < files.length; i++) {
      const charName = (path.basename(files[i]).match(/^eqlog_(.+?)_P1999Green/i) || [])[1];
      if (!charName) continue;
      broadcast({ type:'raidScanProgress', charName, fileIdx:i + 1, totalFiles:files.length });
      let zone = null;
      await new Promise((resolve) => {
        const rl = require('readline').createInterface({ input: fs.createReadStream(files[i], { encoding:'latin1' }), crlfDelay: Infinity });
        rl.on('line', (line) => {
          if (line.indexOf('You have entered ') >= 0) { const zm = /^\[[^\]]+\] You have entered (.+)\.$/.exec(line); if (zm) zone = zm[1]; }
          else if (RE_SESSION_LOGIN.test(line)) { zone = null; const ts = _rtLineTs(line); if (ts >= since) logins.push({ charName, ts }); return; }
          let msg = raidSignal(line, charName);
          if (!msg) { const c = RE_CHAT_LOOT.exec(line); if (c && /ring ?war|\bRW\b/i.test(c[4])) msg = { type:'raidEvidence', kind:'chat', charName, who: c[1] || charName, channel: c[2] || c[3], text: c[4], ts: _rtLineTs(line) }; }   // Ring War chatter
          if (!msg || msg.ts < since) return;
          msg.zone = zone;
          const key = charName + '|' + line;          // archive copies repeat live-log lines
          if (seen.has(key)) return; seen.add(key);
          (msg.type === 'raidTick' ? ticks : evidence).push(msg);
        });
        rl.on('close', resolve); rl.on('error', resolve);
      });
    }
    ticks.sort((a, b) => a.ts - b.ts);
    // keep evidence from 10 min before to 2 min after some tick (the attribution window)
    const tt = ticks.map(t => t.ts);
    const nearTick = ts => { let lo = 0, hi = tt.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (tt[mid] < ts - 2 * 60e3) lo = mid + 1; else hi = mid; } return lo < tt.length && tt[lo] <= ts + 10 * 60e3; };
    const ev = evidence.filter(e => e.kind === 'rw' || e.kind === 'chat' || nearTick(e.ts)).sort((a, b) => a.ts - b.ts);   // Ring War shouts / chat: kept whole (Form up can be 40 min before the Wave 1 tick)
    log(`[RAIDSCAN] ${files.length} file(s): ${ticks.length} RAIDTICK(s), ${ev.length} evidence line(s)`);
    const lg = logins.filter(l => nearTick(l.ts)).sort((a, b) => a.ts - b.ts);   // only logins near some tick matter
    broadcast({ type:'raidScanResult', ticks, evidence: ev, logins: lg, files: files.length });
  } catch (e) {
    err('[RAIDSCAN]', e.message);
    broadcast({ type:'raidScanResult', error: e.message });
  } finally { _raidScanRunning = false; }
}

// Startup backfill (raid signals ONLY): the watcher seeks every log to EOF on start,
// so a restart mid-raid lost the evidence for the next tick (Trakanon, 9/24: app
// restarted 90s after the kill). Replays the last 6 hours (a whole raid night) of recently written logs
// through raidEvidence alone — no other handlers — when the renderer asks for its
// snapshot (requestAll), so the renderer is listening. The renderer dedupes ticks.
const RT_BACKFILL_MS = 6 * 3600e3;   // whole raid night — ticks already logged are skipped by the renderer
function raidBackfill() {
  if (!_config || !_config.logDir) return;
  const since = Date.now() - RT_BACKFILL_MS;
  let files = [];
  try { files = fs.readdirSync(_config.logDir).filter(f => /^eqlog_.+_P1999Green\.txt$/i.test(f)); } catch { return; }
  // All logs in ONE time-ordered pass (owner, 2026-10-09): file by file, a grats relayed in Mixelshank's log replayed before
  // the auction in Mixelmedic's and was lost. Zone changes before the window are applied per character first.
  const lines = [], saved = {};
  for (const f of files) {
    const fp = path.join(_config.logDir, f);
    try {
      const stat = fs.statSync(fp);
      if (stat.mtimeMs < since) continue;
      const charName = extractCharFromLog(f);
      const readSize = Math.min(24 * 1024 * 1024, stat.size);   // ~6h of raid spam
      const buf = Buffer.alloc(readSize);
      const fd = fs.openSync(fp, 'r');
      fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
      fs.closeSync(fd);
      // Replay the zone changes too, so each backfilled line carries the zone it was logged in (the
      // character's zone right now is wrong for anything before a port or a /q). Synchronous, so the
      // live tail can't interleave; ends on the log's last zone line = where the character is now.
      saved[charName] = { keep: _rtZone[charName], had: charName in _rtZone }; delete _rtZone[charName];
      let i = 0;
      for (const raw of buf.toString('utf8').split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const ts = _rtLineTs(line);
        if (ts < since) { _rtNoteZone(line, charName); continue; }
        lines.push({ ts, i: i++, line, charName });
      }
    } catch (e) { err('[RAID] backfill error:', f, e.message); }
  }
  lines.sort((a, b) => a.ts - b.ts || (a.charName < b.charName ? -1 : a.charName > b.charName ? 1 : a.i - b.i));
  _rtBackfilling = true;
  try { for (const x of lines) raidEvidence(x.line, x.charName); }
  catch (e) { err('[RAID] backfill error:', e.message); }
  finally {
    _rtBackfilling = false;
    for (const [c, v] of Object.entries(saved)) if (!_rtZone[c]) { if (v.had) _rtZone[c] = v.keep; else delete _rtZone[c]; }
  }
  log(`[RAID] backfilled ${Object.keys(saved).length} log(s): ${lines.length} lines from the last 6 hours, in time order`);
}

// Bind look-back (owner, 2026-10-04: Mixelboom rebound in Western Wastes on 9/22 while MixelParse was closed; the app
// kept a 9/20 /charinfo "The Feerrott" and parking showed him bound at Plane of Fear — a Dread call was missed).
// Once per run, read each live log BACKWARDS to its last bind signal — a /charinfo readout, or a Bind Affinity plus
// the zone it was cast in — and send it with that line's time; the renderer keeps the newest bind it knows.
// Async, 4 MB chunks from the end, stops at the first hit (the logs total ~340 MB).
let _bindBackfilled = false;
const BIND_CI = 'You are currently bound in:', BIND_AF = 'You feel yourself bind to the area.', BIND_ZN = '] You have entered ';
async function lastBindSignal(fp) {
  const fh = await fs.promises.open(fp, 'r');
  try {
    const size = (await fh.stat()).size, CH = 4 * 1024 * 1024;
    let pos = size, tail = '', aff = null;
    while (pos > 0) {
      const start = Math.max(0, pos - CH), buf = Buffer.alloc(pos - start);
      await fh.read(buf, 0, buf.length, start);
      const text = buf.toString('latin1') + tail;
      const nl = start > 0 ? text.indexOf('\n') : -1;          // the first line may be cut by the chunk edge
      tail = nl >= 0 ? text.slice(0, nl) : '';
      const body = nl >= 0 ? text.slice(nl + 1) : text;
      const lineAt = i => { const a = body.lastIndexOf('\n', i) + 1, b = body.indexOf('\n', i); return body.slice(a, b < 0 ? undefined : b).replace(/\r$/, ''); };
      if (!aff) {
        const ic = body.lastIndexOf(BIND_CI), ia = body.lastIndexOf(BIND_AF);
        if (ic >= 0 && ic > ia) {
          const line = lineAt(ic), zone = line.slice(line.indexOf(BIND_CI) + BIND_CI.length).trim();
          if (zone) return { zone, ts: _rtLineTs(line), src: 'charinfo' };
        }
        if (ia >= 0) {
          aff = { ts: _rtLineTs(lineAt(ia)) };
          const iz = body.lastIndexOf(BIND_ZN, ia);
          if (iz >= 0) { const zl = lineAt(iz); return { zone: zl.slice(zl.indexOf(BIND_ZN) + BIND_ZN.length).replace(/\.$/, '').trim(), ts: aff.ts, src: 'affinity' }; }
        }
      } else {
        const iz = body.lastIndexOf(BIND_ZN);
        if (iz >= 0) { const zl = lineAt(iz); return { zone: zl.slice(zl.indexOf(BIND_ZN) + BIND_ZN.length).replace(/\.$/, '').trim(), ts: aff.ts, src: 'affinity' }; }
      }
      pos = start;
    }
    return null;
  } finally { await fh.close(); }
}
async function bindBackfill() {
  if (_bindBackfilled || !_config || !_config.logDir) return;
  _bindBackfilled = true;
  let files = [], older = [];
  try { files = fs.readdirSync(_config.logDir).filter(f => /^eqlog_.+_P1999Green\.txt$/i.test(f)); } catch { return; }
  // rotated copies (.old next to the logs, Logs\archive) — searched newest first when the live log has no bind line
  for (const d of [_config.logDir, path.join(_config.logDir, 'archive')]) {
    try { for (const f of fs.readdirSync(d)) if (/^eqlog_.+?_P1999Green.+\.(txt|old)$/i.test(f)) { const fp = path.join(d, f); older.push({ fp, f, m: fs.statSync(fp).mtimeMs }); } } catch {}
  }
  older.sort((x, y) => y.m - x.m);
  let n = 0;
  for (const f of files) {
    const charName = extractCharFromLog(f); if (!charName) continue;
    try {
      let b = await lastBindSignal(path.join(_config.logDir, f));
      if (!b) for (const o of older) {
        if ((o.f.match(/^eqlog_(.+?)_P1999Green/i) || [])[1] !== charName) continue;
        if ((b = await lastBindSignal(o.fp))) break;
      }
      if (b && b.zone) { broadcast({ type: 'bindUpdate', charName, zone: b.zone, src: b.src, timestamp: b.ts }); n++; }
    } catch (e) { err('[BIND] look-back', f, e.message); }
  }
  log(`[BIND] look-back: ${n} bind(s) read from ${files.length} log(s)`);
}

function processLogLine(line, charName) {
  raidEvidence(line, charName);
  try { resistWatch.line(line, charName, _rtLineTs(line), zoneState[charName] && zoneState[charName].zone); } catch (e) { err('[RESIST]', e.message); }
  try { if (skyCorpse.line(line, charName, _rtLineTs(line))) skyCorpse.emit(); } catch (e) { err('[SKY]', e.message); }
  const cl = coinLine(line);
  if (cl) broadcast({ type: 'coinLine', charName, ...cl });
  if (line.indexOf('become better at') >= 0) {
    const sm = RE_SKILLUP.exec(line);
    if (sm) broadcast({ type: 'skillUp', charName, skill: sm[1], value: +sm[2] });
  }

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

  // Bind point. Two live signals (a bind made while the app was closed is picked up by bindBackfill at startup):
  //   1) /charinfo readout — names the zone directly, works from anywhere.
  //   2) Bind Affinity landing — doesn't name the zone, so resolve it from the
  //      character's current zone (you bind where you stand).
  // Stamped with the LOG LINE's time, so the renderer's newest-wins compares real bind times.
  const boundInMatch = line.match(/You are currently bound in:\s*(.+)/);
  if (boundInMatch) {
    const zone = boundInMatch[1].replace(/[\r\s]+$/, '').trim();
    if (zone) {
      broadcast({ type: 'bindUpdate', charName, zone, src: 'charinfo', timestamp: _rtLineTs(line) });
      log(`[BIND] ${charName} /charinfo -> ${zone}`);
    }
    return;
  }
  if (/You feel yourself bind to the area\./.test(line)) {
    const z = (zoneState[charName] && zoneState[charName].zone) || _rtZoneOf(charName);
    if (z) {
      broadcast({ type: 'bindUpdate', charName, zone: z, src: 'affinity', timestamp: _rtLineTs(line) });
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

  // A kill — its faction lines come right after it, in the same second
  const _ks = /^\[.+?\] (?:You have slain (.+?)|(.+?) has been slain by .+?)!$/.exec(line);
  if (_ks) { const mob = (_ks[1] || _ks[2]).trim(); _lastKillFac[charName] = { mob, ts: _rtLineTs(line) };
    const k = Math.floor(Date.now() / 1000) + '|k|' + mob.toLowerCase(); if (!_chSeen.has(k)) { _chSeen.set(k, Date.now()); if (_chSeen.size > 400) for (const [kk, t] of _chSeen) if (Date.now() - t > 30e3) _chSeen.delete(kk); broadcast({ type: 'timerKill', charName, mob, ts: Date.now() }); } }   // spell timers on that mob end

  // Faction change lines (kill-based): "Your faction standing with X got better/worse."
  const factionBetter = line.match(/Your faction standing with (.+?) got better\./i);
  const factionWorse  = line.match(/Your faction standing with (.+?) got worse\./i);
  if (factionBetter || factionWorse) {
    const factionName = (factionBetter || factionWorse)[1].replace(/\s+/g, '');
    // the exact amount for the mob just killed (P99 wiki); otherwise — quest turn-ins, mobs not on the wiki — the old ±5 nudge
    let delta = factionBetter ? 5 : -5;
    const k = _lastKillFac[charName];
    if (k && Math.abs(_rtLineTs(line) - k.ts) <= 2000) {
      const exact = factionHitFor(k.mob, factionName, zoneState[charName] && zoneState[charName].zone);
      if (exact != null && Math.sign(exact) === Math.sign(delta)) delta = exact;
    }
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

  { const _gm = _groupHitMob(line); if (_gm) _lastGroupHit[charName] = { mob: _gm, ts: Date.now() };
    if (line.indexOf(' says, ') > 0 && /^\[.+?\] [A-Z][a-zA-Z`' ]+ says,/.test(line)) _lastSaysTs[charName] = Date.now(); }
  // Prev-line turn-in classification (v1.4.18)
  const _wasTurnin = _prevFactionSaysByChar[charName] === true;
  _prevFactionSaysByChar[charName] = (/^\[.+?\] Your faction standing/.test(line) || /^\[.+?\] [A-Z][a-zA-Z`' ]+ says,/.test(line));
  // Level-up ding: "You have gained a level! Welcome to level N!"
  const _lvlUp = line.match(/Welcome to level (\d+)!/);
  if (_lvlUp) {
    broadcast({ type: 'levelUp', charName, level: parseInt(_lvlUp[1], 10) });
  }
  // /who of yourself → class (from the title) + race for the character sheet; your own death → the sheet reminder
  { const _t = line.indexOf(' -> ') > 0 ? RE_TELL_ARROW.exec(line) : null;
    if (_t && (_t[2] === charName || _t[1] === charName)) broadcast({ type: 'tell', charName, dir: _t[2] === charName ? 'in' : 'out', who: _t[2] === charName ? _t[1] : _t[2], text: _t[3], ts: Date.now() }); }
  { let _m;
    if ((_m = RE_CAST_YOU.exec(line))) { const sp = _m[1]; _castNow[charName] = { spell: sp, ts: Date.now() }; if (RE_CHARM_NAME.test(sp)) _lastCharm[charName] = sp; if (RE_FEAR_NAME.test(sp)) _lastFear[charName] = sp;
      const d = _spellDur[sp], w = _wikiDur[sp.toLowerCase()];
      if (w || (d && d.n >= 2)) { broadcast({ type: 'timerStart', charName, spell: sp, dur: d ? d.med : 0, ts: Date.now() });
        if (w && w[4]) (_landWait[charName] = (_landWait[charName] || []).filter(x => x.until > Date.now())).push({ spell: sp, suffix: w[4], until: Date.now() + 12e3 }); } }
    else if (RE_CAST_FAIL.test(line)) { const c = _castNow[charName], rs = /Your target resisted the (.+?) spell\./.exec(line);
      if (rs) { broadcast({ type: 'timerResist', charName, spell: rs[1], ts: Date.now() }); if (c && c.spell === rs[1]) _castNow[charName] = null; }   // a resist names the spell
      else if (c && Date.now() - c.ts < 20e3) { broadcast({ type: 'timerCancel', charName, spell: c.spell }); _castNow[charName] = null; } }
    else if ((_m = RE_WORN_OFF.exec(line))) { const charm = _m[1] === 'charm', fear = _m[1] === 'fear', sp = charm ? (_lastCharm[charName] || 'Charm') : fear ? (_lastFear[charName] || 'Fear') : _m[1];
      broadcast({ type: 'timerEnd', charName, spell: sp, charm, ts: Date.now() }); } }
  if (line.indexOf(' CH ') > 0 || line.indexOf(' CH-') > 0) { const _c = RE_CH_CALL.exec(line);
    if (_c && _c[3] !== 'Target') { const by = _c[1] || charName, k = Math.floor(Date.now() / 1000) + '|' + by + '|' + _c[2];   /* "CA 006 CH -- Target": an unfilled macro */ if (!_chSeen.has(k)) { _chSeen.set(k, Date.now()); if (_chSeen.size > 400) for (const [kk, t] of _chSeen) if (Date.now() - t > 30e3) _chSeen.delete(kk);
      broadcast({ type: 'chCall', charName, by, slot: +_c[2], target: _c[3], ts: Date.now() }); } } }
  if (line.indexOf(", '") > 0 && (line.indexOf(' say') > 0 || line.indexOf(' tell') > 0)) { const _mn = RE_CH_MANA_LINE.exec(line);
    if (_mn) { const pct = _chManaParse(_mn[2]); if (pct != null) { const by = _mn[1] || charName, k = Math.floor(Date.now() / 1000) + '|m|' + by;
      if (!_chSeen.has(k)) { _chSeen.set(k, Date.now()); broadcast({ type: 'chMana', charName, by, pct, ts: Date.now() }); } } } }
  if ((line.indexOf('SLOW') > 0 || /[Ss]haman slowed|<slow(?:ed)?>/i.test(line)) && line.indexOf(", '") > 0) { const _sc = RE_CH_SLOWCALL.exec(line);
    if (_sc && (/\bSLOW(?:ED)?\b/.test(_sc[2]) || /shaman slowed|<slow(?:ed)?>/i.test(_sc[2]))) {   /* also "<Slowed> Keeper of Souls" (10-25) */ const k = Math.floor(Date.now() / 1000) + '|sc|' + _sc[2]; if (!_chSeen.has(k)) { _chSeen.set(k, Date.now()); broadcast({ type: 'chSlowCall', charName, by: _sc[1] || charName, text: _sc[2], ts: Date.now() }); } } }
  if (line.endsWith('defensive fighting style.')) { const _d = RE_CH_DISC.exec(line); if (_d) { const k = Math.floor(Date.now() / 1000) + '|d|' + _d[1]; if (!_chSeen.has(k)) { _chSeen.set(k, Date.now()); broadcast({ type: 'chDisc', charName, who: _d[1], ts: Date.now() }); } } }
  else if (line.charCodeAt(27) >= 65 && line.charCodeAt(27) <= 90 && (line.indexOf(' points of damage') > 0 || line.indexOf(' tries to ') > 0)) { const _s = RE_CH_SWING.exec(line);   // a named mob (capitalised, no "a"/"an") on a player
    if (_s && !/^(You|Your)/.test(_s[1])) { const k = _s[1] + '|' + _s[2], t = _chSwSeen.get(k) || 0, now = Date.now(); if (now - t > 5000) { _chSwSeen.set(k, now); if (_chSwSeen.size > 300) for (const [kk, tt] of _chSwSeen) if (now - tt > 60e3) _chSwSeen.delete(kk); broadcast({ type: 'chSwing', charName, mob: _s[1], target: _s[2], ts: now }); } } }
  if (line.indexOf('You try to ') > 0 || line.indexOf('too far away') > 0 || line.indexOf('dark vines') > 0 || line.indexOf('snared') > 0 || line.indexOf('entwined') > 0 || line.indexOf('slain by') > 0 || line.indexOf('experience') > 0 || line.indexOf(' points of damage') > 0 || line.indexOf(' point of damage') > 0 || line.indexOf(' was ') > 0 || line.indexOf(' tries to ') > 0) _plLine(line, charName);
  { const _lw = _landWait[charName];
    if (_lw && _lw.length) { const txt = line.slice(line.indexOf('] ') + 2), now = Date.now();
      for (let i = 0; i < _lw.length; i++) { const w = _lw[i]; if (w.until < now) continue;
        if (txt.endsWith(w.suffix) && txt.length > w.suffix.length) { const tg = txt.slice(0, txt.length - w.suffix.length).trim(); if (tg && tg.length < 60 && !/^You$/.test(tg)) broadcast({ type: 'timerTarget', charName, spell: w.spell, target: tg, ts: now }); _lw.splice(i, 1); break; } }
      if (_lw.length && _lw.every(x => x.until < now)) _landWait[charName] = []; } }
  if (line.indexOf(' tells the guild, ') > 0) { const _g = RE_GUILD_SPEAKER.exec(line); if (_g) ((_guildSpeakers[charName] = _guildSpeakers[charName] || {})[_g[1]] = Date.now()); }
  const _who = RE_WHO_SELF.exec(line);
  if (_who && (_who[3].toLowerCase() === String(charName).toLowerCase() || ownNames().has(_who[3].toLowerCase()))) broadcast({ type: 'whoSelf', charName: _who[3], level: +_who[1], title: _who[2].trim(), race: _who[4].trim() });   // you, or another of your characters seen from this one
  const _died = RE_SELF_DEATH.exec(line);
  if (_died) broadcast({ type: 'selfDeath', charName, by: _died[1] || null });
  // Leatherfoot Raider Skullcap — a use (instant trip to West Commonlands) or a recharge (sold + bought back)
  const _capEv = (_capTrack[charName] || (_capTrack[charName] = capTrack.createTracker())).feed(line);
  if (_capEv) broadcast({ type: 'capEvent', charName, live: true, ..._capEv });
  // a merchant's offer for something you're selling — "is it worth looting?" prices
  if (line.indexOf("tells you, 'I'll give you ") > 0) { const _vq = capTrack.vendorQuote(line); if (_vq) broadcast({ type: 'vendorPrice', charName, ..._vq }); }
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
      const _gh = _lastGroupHit[charName], _ghKill = !!(_gh && Date.now() - _gh.ts < 20e3 && Date.now() - (_lastSaysTs[charName] || 0) > 5000);   // fighting, no NPC speech: a kill with no slain line (10-26)
      let mobName;
      if (_wasTurnin && !(pending && (Date.now() - pending.ts) < TURNIN_KILL_MS) && !_ghKill) {
        // FIX #1 (v1.4.18): prev line was faction/says → turn-in, NOT a kill. Suppress — unless a slain-by came just
        // before: faction zones print slain → faction → XP for every group kill (10-25: 49 of 78 ToFS kills were lost).
        // BEFORE pendingSlain so a stale kill can't absorb the turn-in tick.
        delete _pendingSlainMob[charName]; delete _petLastTarget[charName];
        return;
      } else if (pending && (Date.now() - pending.ts) < CHARM_CONFIRM_MS) {
        mobName = pending.mob;                       // in-range slain-by → real kill
      } else {
        mobName = _petLastTarget[charName] || (_gh && Date.now() - _gh.ts < 20e3 ? _gh.mob : 'unknown');   // no slain line: the mob the group was just hitting
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
  resistWatch.init({ eqDir: config && config.eqDir, dataDir: factionPath ? path.dirname(factionPath) : null, log, err });
  skyCorpse.init({ dataDir: factionPath ? path.dirname(factionPath) : null, log, err, broadcast });
  if (config && config.logDir && config.eqDir) setTimeout(() => { skyCorpse.backfill(config.logDir, config.eqDir).catch(e => err('[SKY] backfill', e.message)); }, 3000);

  loadPersisted();
  startInventoryWatcher();
  startLogWatcher();
  startNotesWatcher();

  log('Watcher started (IPC mode).');
}

function stop() {
  if (_logPosT) saveLogPositionsNow();
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

// ── Skill scan (AC/ATK formulas) ─────────────────────────────────────────────
// Skills only ever rise and every rise is logged ("You have become better at
// Defense! (165)"), so the highest value in a character's full log history is the
// current skill. Verified against in-game Skills windows (Mixelshank, Mixelboom,
// Mixelflop). Reads live logs, rotated .old files and the Logs\archive folder.
const RE_SKILLUP = /You have become better at (.+?)! \((\d+)\)/;
// ── Coins from the log ────────────────────────────────────────────────────────
// P99 logs every coin you gain or spend EXCEPT banking and destroying coins:
//   You receive 3 gold, 7 silver and 2 copper from the corpse.          (loot)
//   You receive 50 platinum, 0 gold, 0 silver, 0 copper as your split.  (group split)
//   You receive 2 gold 3 silver 6 copper from Hanga Wiskin for the …    (merchant sale / trade)
//   You give 12 platinum 6 gold 6 silver 8 copper to Altha Shadowjumper. (purchase / trainer / trade)
// The renderer replays these, in order, through a purse that starts at the coin count the user typed (coinsFor in
// index.html): silver / copper you receive are assumed destroyed, purchases are paid from your smallest coins up.
const RE_COIN_LINE = /^\[.+?\] You (receive|give) (.+?) (?:from (.+?)|to (.+?)|as your split)\.?$/;
const RE_COIN_AMT  = /(\d+) (platinum|gold|silver|copper)\b/g;
const COIN_KEY = { platinum:'pp', gold:'gp', silver:'sp', copper:'cp' };
function coinLine(line) {
  if (line.indexOf('] You ') < 0 || !/platinum|gold|silver|copper/.test(line)) return null;
  const m = RE_COIN_LINE.exec(line); if (!m) return null;
  const amt = { pp:0, gp:0, sp:0, cp:0 }; let any = false, am;
  RE_COIN_AMT.lastIndex = 0;
  while ((am = RE_COIN_AMT.exec(m[2]))) { amt[COIN_KEY[am[2]]] += +am[1]; any = true; }
  if (!any || m[2].replace(RE_COIN_AMT, '').replace(/[\s,]|and/g, '') !== '') return null;   // amounts only
  const sign = m[1] === 'give' ? -1 : 1;
  const kind = m[1] === 'give' ? 'give' : /as your split/.test(line) ? 'split' : m[3] === 'the corpse' ? 'loot' : 'receive';
  return { kind, pp: sign * amt.pp, gp: sign * amt.gp, sp: sign * amt.sp, cp: sign * amt.cp, ts: _rtLineTs(line) };
}
// A character's coin lines after `since` across live / .old / archived logs, in time order.
// args.chars: { charName: sinceMs }. One result per call: coinScanResult { totals: {name: {events, lines, lastTs}}, scannedAt }.
let _coinScanRunning = false, _coinScanQueue = null;   // requests during a scan run right after it
async function scanCoins(want) {
  if (!want || !_config || !_config.logDir) return;
  if (_coinScanRunning) { _coinScanQueue = Object.assign(_coinScanQueue || {}, want); return; }
  _coinScanRunning = true;
  const scannedAt = Date.now();
  const totals = {};
  try {
    const lower = {}; for (const [n, t] of Object.entries(want)) lower[n.toLowerCase()] = { name: n, since: +t || 0 };
    const dirs = [_config.logDir, path.join(_config.logDir, 'archive')].filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
    const files = [];
    for (const d of dirs) for (const f of fs.readdirSync(d)) {
      const c = (f.match(/^eqlog_(.+?)_P1999Green.*\.(txt|old)$/i) || [])[1];
      if (c && lower[c.toLowerCase()]) files.push({ file: path.join(d, f), w: lower[c.toLowerCase()] });
    }
    const seen = new Set();
    for (const { file, w } of files) {
      const t = totals[w.name] || (totals[w.name] = { events: [], lines: 0, lastTs: 0 });
      await new Promise((resolve) => {
        const rl = require('readline').createInterface({ input: fs.createReadStream(file, { encoding: 'latin1' }), crlfDelay: Infinity });
        rl.on('line', (line) => {
          const c = coinLine(line); if (!c || c.ts <= w.since || c.ts > scannedAt) return;
          const key = w.name + '|' + line; if (seen.has(key)) return; seen.add(key);   // archive copies repeat lines
          t.events.push({ k: c.kind, pp: Math.abs(c.pp), gp: Math.abs(c.gp), sp: Math.abs(c.sp), cp: Math.abs(c.cp), ts: c.ts });
          t.lines++; if (c.ts > t.lastTs) t.lastTs = c.ts;
        });
        rl.on('close', resolve); rl.on('error', resolve);
      });
    }
    for (const w of Object.values(lower)) if (!totals[w.name]) totals[w.name] = { events: [], lines: 0, lastTs: 0 };
    for (const t of Object.values(totals)) t.events.sort((a, b) => a.ts - b.ts);   // files are read one at a time — put them in order
    broadcast({ type: 'coinScanResult', totals, scannedAt });
  } catch (e) {
    err('[COINS]', e.message);
    broadcast({ type: 'coinScanResult', error: e.message, scannedAt });
  } finally {
    _coinScanRunning = false;
    if (_coinScanQueue) { const q = _coinScanQueue; _coinScanQueue = null; scanCoins(q); }
  }
}

let _skillScanRunning = false;
async function scanSkillsAllLogs() {
  if (_skillScanRunning || !_config || !_config.logDir) return;
  _skillScanRunning = true;
  const skills = {};   // char -> { skill: max }
  try {
    const dirs = [_config.logDir, path.join(_config.logDir, 'archive')].filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
    const files = [];
    for (const d of dirs) for (const f of fs.readdirSync(d)) if (/^eqlog_.+?_P1999Green.*\.(txt|old)$/i.test(f)) files.push(path.join(d, f));
    for (let i = 0; i < files.length; i++) {
      const charName = (path.basename(files[i]).match(/^eqlog_(.+?)_P1999Green/i) || [])[1];
      if (!charName) continue;
      broadcast({ type: 'skillsScanProgress', charName, fileIdx: i + 1, totalFiles: files.length });
      await new Promise((resolve) => {
        const rl = require('readline').createInterface({ input: fs.createReadStream(files[i], { encoding: 'latin1' }), crlfDelay: Infinity });
        rl.on('line', (line) => {
          if (line.indexOf('become better at') < 0) return;
          const m = RE_SKILLUP.exec(line); if (!m) return;
          const s = skills[charName] || (skills[charName] = {}); const v = +m[2];
          if (!(s[m[1]] >= v)) s[m[1]] = v;
        });
        rl.on('close', resolve); rl.on('error', resolve);
      });
    }
    log(`[SKILLS] scanned ${files.length} log file(s) for ${Object.keys(skills).length} character(s)`);
    broadcast({ type: 'skillsScanResult', skills, files: files.length });
  } catch (e) {
    err('[SKILLS]', e.message);
    broadcast({ type: 'skillsScanResult', error: e.message });
  } finally { _skillScanRunning = false; }
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

// ── Leveling timeline scan (owner, 2026-10-06) ────────────────────────────────
// Replays a character's whole log history (live, rotated .old, Logs\archive — oldest first, state carried across
// files) and buckets it by the level the character was at and the zone it was in:
//   hunt_ms   — time between XP messages in the same zone, each gap capped at 10 min (+1 min for the first kill),
//               so AFK, camping out and raid waits don't count;
//   played_ms — time between any two log lines ≤ 5 min apart;
//   xp_solo / xp_group — kills: "You gain experience!!" / "You gain party experience!!" right after a slain line
//               (P99 never logs the amount); xp_quest — the same XP lines with no kill (quest turn-ins);
//   deaths, mobs (the "slain" line just before each XP message).
// A level is "done" only when it was entered by a ding AND left by the next ding — a level re-entered after
// "You LOST a level!" isn't a full level. Lines before the first level message are skipped (level unknown).
const RE_LV_GAIN = /(?:You have gained a level! )?Welcome to level (\d+)!$/;
const RE_LV_LOST = /You LOST a level! You are now level (\d+)!/;
const RE_LV_XP = /^You gain (party )?experience!!$/;
const RE_LV_SLAIN = /^(?:You have slain (.+?)|(.+?) has been slain by (.+?))!$/;
const RE_LV_PET = /^([A-Z][a-z]+) tells you, 'Attacking .+ Master\.'$/;   // your pet's name — its kills are yours, not a power-level
const RE_LV_ZONE = /^You have entered (.+)\.$/;
let _lvlScanRunning = false;
async function scanLeveling(charFilter) {
  if (_lvlScanRunning) { broadcast({ type: 'levelScanResult', error: 'A leveling scan is already running' }); return; }
  if (!_config || !_config.logDir) { broadcast({ type: 'levelScanResult', error: 'No log directory configured' }); return; }
  const wanted = new Map((Array.isArray(charFilter) ? charFilter : []).map(c => [String(c).toLowerCase(), String(c)]));
  if (!wanted.size) { broadcast({ type: 'levelScanResult', error: 'No characters to scan' }); return; }
  _lvlScanRunning = true;
  try {
    const dirs = [_config.logDir, path.join(_config.logDir, 'archive')].filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
    const byChar = new Map();
    for (const d of dirs) for (const f of fs.readdirSync(d)) {
      const c = (f.match(/^eqlog_(.+?)_P1999Green.*\.(?:txt|old)$/i) || [])[1];
      if (!c || !wanted.has(c.toLowerCase())) continue;
      const fp = path.join(d, f); let mt = 0; try { mt = fs.statSync(fp).mtimeMs; } catch { continue; }
      const k = c.toLowerCase(); if (!byChar.has(k)) byChar.set(k, []); byChar.get(k).push({ fp, mt });
    }
    const results = {}; let done = 0;
    for (const [k, files] of byChar) {
      const name = wanted.get(k); files.sort((a, b) => a.mt - b.mt);
      const st = { level: null, byGain: false, zone: null, lastTs: 0, maxTs: 0, lastXpTs: 0, lastXpZone: null, slain: null, pets: new Set() };
      const agg = {}, levels = {};
      const A = (L, z) => { const key = L + '|' + z; return agg[key] || (agg[key] = { level: L, zone: z, hunt_ms: 0, played_ms: 0, xp_solo: 0, xp_group: 0, xp_quest: 0, xp_pl: 0, deaths: 0, mobs: {}, mk: {}, first: 0, last: 0 }); };
      const LV = L => levels[L] || (levels[L] = { done: false, xp: 0, quest: 0, start: 0, end: 0 });
      for (const { fp } of files) {
        broadcast({ type: 'levelScanProgress', charName: name, idx: done + 1, total: byChar.size });
        await new Promise(resolve => {
          const rl = require('readline').createInterface({ input: fs.createReadStream(fp, { encoding: 'latin1' }), crlfDelay: Infinity });
          rl.on('line', line => {
            if (line.length < 28 || line.charCodeAt(0) !== 91) return;
            const ts = /^\[\w{3} \w{3} +\d+ \d\d:/.test(line) ? _rtLineTs(line) : 0; if (!ts) return;   // _rtLineTs falls back to now()
            if (ts < st.maxTs - 1000) return;                    // overlapping rotated copy — already replayed
            if (ts > st.maxTs) st.maxTs = ts;
            const msg = line.slice(line.indexOf('] ') + 2);
            const gap = ts - st.lastTs; st.lastTs = ts;
            if (st.level != null && st.zone && gap > 0 && gap <= 5 * 60e3) A(st.level, st.zone).played_ms += gap;
            // previous line a faction change or someone "says" — the turn-in signature (same rule as the kill scan, v1.4.18)
            const wasTurnin = st.prevFS; st.prevFS = /^Your faction standing/.test(msg) || /^[A-Z][a-zA-Z`' ]+ says,/.test(msg);
            let m;
            if ((m = RE_LV_ZONE.exec(msg))) { if (!/^an? (area|arena)/i.test(m[1])) st.zone = m[1]; return; }
            if ((m = RE_LV_SLAIN.exec(msg))) { st.slain = { mob: (m[1] || m[2] || '').trim(), by: m[1] ? 'You' : (m[3] || '').trim(), ts }; return; }
            if (msg.indexOf(' tells you, ') > 0 && (m = RE_LV_PET.exec(msg))) { st.pets.add(m[1]); return; }
            if ((m = RE_LV_XP.exec(msg))) {
              if (st.level == null) return;
              const z = st.zone || 'Unknown', a = A(st.level, z);
              // Quest turn-ins print the same XP line as a kill (owner, 2026-10-07: Neriak Third Gate / Chardok
              // herbalist turn-ins read as 1,000+ kills). Solo XP with no kill just before it and a faction / "says"
              // line right before it is a turn-in. Group XP is always a kill — a groupmate's kill out of view
              // range prints no "slain" line.
              const slain = st.slain && ts - st.slain.ts <= 3000 ? st.slain : null;
              if (!m[1] && !slain && wasTurnin) { a.xp_quest++; LV(st.level).quest++; if (!a.first) a.first = ts; a.last = ts; return; }
              if (m[1]) a.xp_group++; else { a.xp_solo++; if (slain && slain.by !== 'You' && /^[A-Z][a-z]+$/.test(slain.by) && slain.by !== name && !st.pets.has(slain.by)) a.xp_pl++; }   // solo XP from another player's kill: power-levelled
              a.hunt_ms += st.lastXpTs && st.lastXpZone === z && ts - st.lastXpTs <= 10 * 60e3 ? ts - st.lastXpTs : 60e3;
              st.lastXpTs = ts; st.lastXpZone = z;
              if (slain && slain.mob && !/^you$/i.test(slain.mob)) {
                a.mobs[slain.mob] = (a.mobs[slain.mob] || 0) + 1;
                const e = a.mk[slain.mob] || (a.mk[slain.mob] = [0, 0]); e[m[1] ? 1 : 0]++;   // [solo, group] — XP estimate from the mob's level
              }
              st.slain = null;
              if (!a.first) a.first = ts; a.last = ts;
              LV(st.level).xp++;
              return;
            }
            if (msg.indexOf('You have been slain by') === 0 || msg === 'You died.') { if (st.level != null && st.zone) A(st.level, st.zone).deaths++; return; }
            if ((m = RE_LV_LOST.exec(msg))) { st.level = +m[1]; st.byGain = false; st.lastXpTs = 0; return; }
            if ((m = RE_LV_GAIN.exec(msg))) {
              const N = +m[1];
              if (st.level === N - 1 && st.byGain) { const l = LV(N - 1); l.done = true; l.end = ts; }
              if (st.level !== N) { st.level = N; st.byGain = true; const l = LV(N); if (!l.start) l.start = ts; }
              st.lastXpTs = 0;
            }
          });
          rl.on('close', resolve); rl.on('error', resolve);
        });
      }
      done++;
      const rows = Object.values(agg).filter(a => a.xp_solo + a.xp_group + a.xp_quest > 0 || a.played_ms >= 5 * 60e3).map(a => ({
        level: a.level, zone: a.zone, hunt_ms: Math.round(a.hunt_ms), played_ms: Math.round(a.played_ms), xp_solo: a.xp_solo, xp_group: a.xp_group, xp_quest: a.xp_quest, xp_pl: a.xp_pl, pl: a.xp_pl >= 0.3 * Math.max(1, a.xp_solo + a.xp_group),
        deaths: a.deaths, mobs: Object.fromEntries(Object.entries(a.mobs).sort((x, y) => y[1] - x[1]).slice(0, 8)), mk: a.mk,
        first_at: a.first || null, last_at: a.last || null }));
      results[name] = { rows, levels, current: st.level };
      log(`[LVLSCAN] ${name}: ${rows.length} level/zone row(s), ${Object.values(levels).filter(l => l.done).length} full level(s)`);
    }
    broadcast({ type: 'levelScanResult', results, scannedAt: Date.now() });
  } catch (e) {
    err('[LVLSCAN]', e.message);
    broadcast({ type: 'levelScanResult', error: e.message });
  } finally { _lvlScanRunning = false; }
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
  { const _gm = _groupHitMob(line); if (_gm) st.lastGroupHit = { mob: _gm, t: ts };
    if (line.indexOf(' says, ') > 0 && /^\[.+?\] [A-Z][a-zA-Z`' ]+ says,/.test(line)) st.lastSaysT = ts; }
  const _ghCtx = st.lastGroupHit && ts - st.lastGroupHit.t < 20e3 ? st.lastGroupHit : null, _ghKillCtx = !!(_ghCtx && ts - (st.lastSaysT || 0) > 5000);
  const _wasTurninCtx = st.prevFactionSays === true;
  st.prevFactionSays = (/^\[.+?\] Your faction standing/.test(line) || /^\[.+?\] [A-Z][a-zA-Z`' ]+ says,/.test(line));

  // XP tick (mirrors live: credited flag suppresses double-count;
  // otherwise pending slain-by within TTL, else pet's last target)
  if (RE_SESSION_XP.test(line)) {
    sess.xp++;
    if (st.killCredited) {
      st.killCredited = false;
    } else if (_wasTurninCtx && !(st.pendingSlain && (ts - st.pendingSlain.t) < TURNIN_KILL_MS) && !_ghKillCtx) {
      // FIX #1: prev line was faction/says → turn-in / faction XP, NOT a kill. Suppress (unless a slain-by came just before).
      // Checked BEFORE pendingSlain so a stale kill's mob name can't absorb turn-in ticks.
      st.pendingSlain = null; st.petLastTarget = null;
    } else if (st.pendingSlain && (ts - st.pendingSlain.t) < CHARM_CONFIRM_MS) {
      credit(st.pendingSlain.mob);
      st.pendingSlain = null; st.petLastTarget = null;
    } else {
      credit(st.petLastTarget || (_ghCtx ? _ghCtx.mob : 'unknown'));   // no slain line: the mob the group was just hitting
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

// ── Leatherfoot Raider Skullcap: each character's last use / recharge from all their logs (captrack.js) ──
// Each file's last event is cached by size + mtime (cap-cache.json next to the log positions), so the big archived logs are
// read once (first run ~30 s on the owner's 1.5 GB); live logs are re-read at start.
const _capTrack = {};
let _capScanRunning = false;
// merge one item's merchant offers into a map: lowest / highest / how many / the latest
function _vpAdd(map, e, item) {
  const o = map[item];
  if (!o) { map[item] = { lo: e.lo, hi: e.hi, n: e.n, cp: e.cp, ts: e.ts }; return; }
  o.lo = Math.min(o.lo, e.lo); o.hi = Math.max(o.hi, e.hi); o.n += e.n; if ((e.ts || 0) >= (o.ts || 0)) { o.cp = e.cp; o.ts = e.ts; }
}
// ── tells + spell timers (log-review features, 2026-10-18) ──
const RE_TELL_ARROW = /^\[[^\]]+\] ([A-Z][a-z]+) -> ([A-Z][a-z]+): (.*)$/;        // P99: "Figure -> Mixelmez: text"
const RE_CAST_YOU   = /^\[[^\]]+\] You begin casting (.+?)\.$/;
const RE_WORN_OFF   = /^\[[^\]]+\] Your (.+?) spell has worn off\.$/;
const RE_CAST_FAIL  = /^\[[^\]]+\] (?:Your spell fizzles!|Your spell is interrupted\.|Your target resisted the .+? spell\.|Your spell did not take hold\.|Your target is immune to .+|Your target cannot be .+|You must first select a target for this spell!|Your target is out of range, get closer!)/;
const RE_CHARM_NAME = /charm|dominat|allure|beguile|cajol|befriend|enslave|thrall|captivat|boltran|call of karana|tunare's request|command of druzzil/i;
let _spellDur = {};                 // spell → {list:[seconds…], med, n} learned from your logs
let _wikiDur = {}; try { _wikiDur = require('../../src/wiki-durations.js') || {}; } catch {}   // P99 wiki: duration by level + landing text
const RE_FEAR_NAME = /fear|panic|scare|terror|dread|spook|chase the moon|cower|flee/i;
const _lastFear = {};
const _landWait = {};
// CH chain calls ("CA 007 CH -- Concuss"), live, once per call across all your logs
const RE_CH_CALL = /^\[[^\]]+\] (?:([A-Z][a-z]+) (?:says out of character|says|shouts|tells the raid|tells the group)|You (?:say out of character|say|shout|tell your raid|tell your party)), '(?:CA\s*)?(\d{1,3})\s*CH\s*-+>?\s*([A-Z][A-Za-z`']+)[^']*'$/;
const _chSeen = new Map();
// CH chain speed: the tank's Defensive Discipline, and named mobs swinging at a player (the renderer keeps the roster bosses)
const RE_CH_DISC = /^\[[^\]]+\] ([A-Z][a-z]+) assumes a defensive fighting style\.$/;
const RE_CH_SWING = /^\[[^\]]+\] ([A-Z][^ ]*(?: [^ ]+){0,4}?) (?:hits|slashes|crushes|bashes|kicks|bites|claws|pierces|punches|smashes|mauls|gores|stings|strikes|slices|rends|tries to \w+) ([A-Z][a-z]+)(?: for |, but |!)/;
const _chSwSeen = new Map();
const RE_CH_SLOWCALL = /^\[[^\]]+\] (?:([A-Z][a-z]+) (?:says out of character|says|shouts|tells the raid|tells the group)|You (?:say out of character|say|shout|tell your raid|tell your party)), '(.{3,200})'$/;
// a mana call in /say (or group / raid): "40", "40 mana", "Cleric - 40m - Low Mana!", "Full mana", "OOM", "ENC at 20% MANA"
const RE_CH_MANA_LINE = /^\[[^\]]+\] (?:([A-Z][a-z]+) (?:says|tells the group|tells the raid)|You (?:say|tell your party|tell your raid)), '([^']{1,40})'$/;
function _chManaParse(t) {
  t = t.replace(/&PCT;/gi, '%').trim();
  if (/\?/.test(t)) return null;   // "mana?" is asking, not telling
  if (/^(?:[a-z]+\s+)?(?:full|fm)(?:\s+mana)?\s*!*$/i.test(t)) return 100;
  if (/^(?:[a-z]+\s+)?(?:oom|out of mana)(?:\s+[a-z]+)?\s*!*$/i.test(t)) return 0;
  const m = /^(?:(?:clerics?|clr|cler|druid|dru|shaman|shm|enc|enchanter|chanter|necro|nec|mage|wiz|pal|paladin|im|i'm|was)\s*(?:-|:|at)?\s*(?:at\s+)?)?(0|[1-9]\d{0,2})\s*(?:%|m|mana|pct)?(?:\s*-?\s*(?:low\s+)?(?:mana|%))?\s*!*$/i.exec(t);
  if (!m) return null; const v = +m[1]; return v <= 100 ? v : null;
}
// ── PL helper: per character, the current pull (a pull ends after 45 s with nothing happening) ──
const RE_PL_SLAIN = /^\[[^\]]+\] (.+?) has been slain by (.+?)!$/;
const RE_PL_XP    = /^\[[^\]]+\] You gain (?:party )?experience/;
const RE_PL_HIT   = /^\[[^\]]+\] You (?:hit|slash|pierce|crush|kick|bash|punch|backstab|slice|claw|bite|strike|sting|maul|gore|smash|rend|burn|frenzy on) (.+?) for \d+ points? of damage\.$/;
const RE_PL_SEEN  = /^\[[^\]]+\] (.+?) (?:was pierced by thorns|was burned|was tormented|was hit by non-melee|hits|pierces|bashes|punches|kicks|slashes|crushes|bites|claws|mauls|stings|tries to \w+) /;
const RE_PL_MISS = /^\[[^\]]+\] You try to \w+ (.+?), but miss!$/;
const RE_PL_FAR  = /Your target is too far away, get closer!$/;
// power-leveller side: another player's swings, your own kills, your pet's name
const RE_PL_OHIT  = /^\[[^\]]+\] ([A-Z][a-z]+) (?:hits|slashes|pierces|crushes|kicks|bashes|punches|backstabs|slices|claws|bites|strikes|stings|mauls|gores|smashes|rends|burns|frenzies on) (.+?) for \d+ points? of damage\.$/;
const RE_PL_OMISS = /^\[[^\]]+\] ([A-Z][a-z]+) tries to \w+ (.+?), but misses!$/;
const RE_PL_YSLAIN = /^\[[^\]]+\] You have slain (.+?)!$/;
const RE_PL_PET   = /^\[[^\]]+\] ([A-Z][a-z]+) tells you, 'Attacking .+ Master\.'$/;
const _plLvl = {};   // charName → {who, at}: you're power-levelling that player (their melee, kills land as theirs, you get no XP)
const _plOh = {};    // charName → {player: {last, hits, mobs:{mob: hits}}} — other players' hits heard in the last minute
const _plPets = {};  // charName → Set of your pet names (their kills are yours)
function _plLvOf(c) { const L = _plLvl[c]; return L && Date.now() - L.at < 15 * 60e3 ? L.who : null; }
const _plHist = {};
const _plStats = {};  // charName → name → {died, missed} this session (finished pulls) — your own miss rate per mob type   // charName → the last pulls' recaps [{start, end, killed, xp, missed}]
const _pl = {};   // charName → {start, last, kills:[{t,mob,by,xp}], names:{name:{last,hits,killed,atk:[ts],tagged,peak}}, timer}
const RE_PL_SNARE_AE = /^\[[^\]]+\] (.+?) is dragged down by dark vines\.$/;   // Bonds of Tunare: every mob in range, one line each
const RE_PL_SNARE_1  = /^\[[^\]]+\] (.+?)(?: has been ensnared|'s feet become entwined| is snared| has been snared)\.$/;   // single-target snares
const _plRate = {};   // mob name → attacks per mob per 6 s (learned: a pull's peak ÷ its kills of that name)
// targets of this name Figure has snared: the last Bonds of Tunare batch + single snares since, minus kills since
function _plSnared(p, name) {
  const S = p.snare; if (!S) return null;
  const after = t => S.one.filter(x => x.n === name && x.t >= t).length - p.kills.filter(k => k.mob === name && k.t >= t).length;
  let best = S.one.some(x => x.n === name) ? after(S.one.find(x => x.n === name).t) : 0;   // single snares only
  for (const b of S.batches) if (b.c[name]) best = Math.max(best, b.c[name] + after(b.t));   // the most any cast caught, minus kills since
  return best;
}
function _plAlive(n, now) {   // how many of this name are fighting: the busiest 6 s of attacks in the last 12 s ÷ attacks per mob
  const a = (n.atk || []).filter(t => now - t <= 12e3); let best = 0;
  for (let i = 0; i < a.length; i++) { let j = i; while (j < a.length && a[j] - a[i] < 6000) j++; if (j - i > best) best = j - i; }
  const rate = _plRate[n.key] || 3.6;
  return best ? Math.max(1, Math.round(best / rate)) : 0;
}
function _plState(c) { const p = _pl[c]; if (!p) return null;
  const k = p.kills, killed = k.length, xp = k.filter(x => x.xp === true).length, missed = k.filter(x => x.xp === false).length;
  return { char: c, start: p.start, killed, xp, missed, kills: k.slice(-40).map(x => ({ t: x.t, mob: x.mob, by: x.by, xp: x.xp, unseen: !!x.unseen, lv: !!x.lv, to: x.to || null })), lv: p.lv || null, lvKills: k.filter(x => x.lv && x.xp === true && (!x.chk || Date.now() - x.t > 2600)).length,   /* a levelling kill counts once 2.6 s pass with no XP for you (XP = a group / your pet) */ quiet: Date.now() - p.last > 45e3, tags: p.tags || 0, same: p.same || 0, swing: p.swing || null, hist: (_plHist[c] || []).slice(-6),
    snared: p.snare ? Object.keys(p.names).reduce((a, nm) => a + Math.max(0, _plSnared(p, nm)), 0) : null,
    names: Object.entries(p.names).map(([name, v]) => { const sn = p.snare ? _plSnared(p, name) : null; const wasSnared = !!(p.snare && (p.snare.ae[name] != null || p.snare.one.some(x => x.n === name))); const est0 = _plAlive(v, Date.now()) || (Date.now() - v.last <= 15e3 ? 1 : 0); v.estMax = Math.max(v.estMax || 0, est0 + (v.killed || 0)); const est = Date.now() - v.last <= 30e3 ? Math.max(est0, v.estMax - (v.killed || 0)) : est0, alive = wasSnared ? Math.max(Math.max(0, sn), est) : est; /* the pull's peak minus deaths since: idle mobs don't drop out (10-21: ≈3 burrowers for 5) */ const ss = (_plStats[c] || {})[name]; /* snare lines show only 3-4 mobs per Bonds cast (10-21: 8 vs 23 died) — the attack rate counts them */ /* from how often they attack; extra hits do not add mobs */ return { name, last: v.last, hits: v.hits, since: v.since || 0, killed: v.killed, lastKill: v.lastKill || 0, allDead: v.killed > 0 && !v.alive, bursts: v.bursts || 0, sess: ss ? { died: ss.died, missed: ss.missed } : null, alive, tagged: Math.min(v.tagged || 0, alive), snared: wasSnared }; }).sort((a, b) => b.last - a.last).slice(0, 20),
    pl: k.filter(x => x.by !== c && x.xp === true && !x.party && !x.lv && !x.chk).length };   // solo XP from someone else's kill — party XP is a group, not a power-level
}
setInterval(() => { for (const c of Object.keys(_pl)) if (Date.now() - _pl[c].last < 60e3) _plSend(c); }, 2000);
function _plSend(c) { const p = _pl[c]; if (!p || p.timer) return; p.timer = setTimeout(() => { p.timer = null; const st = _plState(c); if (st) broadcast({ type: 'plState', state: st }); }, 250); }
function _plLine(line, c) {
  if (line.indexOf('] Pain and suffering ') > 0) return;   // the client's stand-in name for a creature it already dropped (P99 wiki) — one of the real mobs, not a target
  const now = Date.now(); let m, p = _pl[c];
  const touch = () => { if (!p || now - p.last > 45e3) { if (p) for (const [nm, v] of Object.entries(p.names)) if (v.killed && v.peak) _plRate[nm] = Math.max(2, Math.min(8, _plRate[nm] ? (_plRate[nm] * 2 + v.peak / v.killed) / 3 : v.peak / v.killed));   // learn attacks per mob
      if (p && p.kills.length) { const S = _plStats[c] || (_plStats[c] = {}); for (const k of p.kills) { if (k.unseen) continue; const x = S[k.mob] || (S[k.mob] = { died: 0, missed: 0 }); x.died++; if (k.xp === false) x.missed++; }
        const h = _plHist[c] || (_plHist[c] = []); h.push({ start: p.start, end: p.last, killed: p.kills.length, xp: p.kills.filter(x => x.xp === true).length, missed: p.kills.filter(x => x.xp === false).length }); if (h.length > 8) h.shift(); }
      p = _pl[c] = { start: now, last: now, kills: [], names: {}, timer: null, tags: 0, swing: null, own: 0, lv: null }; } p.last = now; };
  const N = mob => { const n = p.names[mob] || (p.names[mob] = { key: mob, last: now, hits: 0, killed: 0, alive: true, atk: [], tagged: 0, peak: 0 }); if (!n.key) n.key = mob; if (!n.atk) n.atk = []; return n; };
  // a landed hit / a miss on a mob — yours, or (power-levelling) the player you're levelling
  const hitOn = mob => { const n = N(mob); n.hits++; n.since = (n.since || 0) + 1; n.last = now; n.alive = true;
    const b = p.burst, same = b && b.name === mob && now - b.t < 2600 && b.hit && (_plAlive(n, now) || 1) <= 5; /* a few of a kind: a 2nd hit in a burst is the same mob; in a big pack you tab between same-named ones (10-21: 14 of 15 excavators tagged) */   // a burst: swings on one name < 2.6 s apart, nothing else between
    if (same) { b.t = now; b.hits++; p.same = (p.same || 0) + 1; p.swing = { name: mob, t: now, res: 'same', n: b.hits }; }   // auto-attack still on the one you just tagged
    else { if (now - (n.lastTag || 0) > 1200) { n.tagged = (n.tagged || 0) + 1; n.lastTag = now; p.tags = (p.tags || 0) + 1; }
      n.bursts = (n.bursts || 0) + 1; p.burst = { name: mob, t: now, hit: true, hits: 1 }; p.swing = { name: mob, t: now, res: 'hit', fresh: true }; }
    _plSend(c); };
  const missOn = mob => { const n = N(mob); n.last = now; n.alive = true; n.miss = (n.miss || 0) + 1;
    if (p.burst && p.burst.name === mob && now - p.burst.t < 2600) p.burst.t = now; else p.burst = { name: mob, t: now, hit: false, hits: 0 };
    const pv = p.swing; p.swing = { name: mob, t: now, res: 'miss', n: pv && pv.name === mob && pv.res !== 'hit' ? (pv.n || 1) + 1 : 1 }; _plSend(c); };
  if (line.indexOf(' tells you, ') > 0 && (m = RE_PL_PET.exec(line))) { (_plPets[c] || (_plPets[c] = new Set())).add(m[1]); return; }
  // another player's swing: counted toward their tags when you're levelling them, else remembered for a minute
  if ((m = RE_PL_OHIT.exec(line) || RE_PL_OMISS.exec(line)) && m[1] !== c && !/^(?:[A-Z][a-z]+|YOU)$/.test(m[2]) && !(_plPets[c] && _plPets[c].has(m[1]))) {
    const X = m[1], mob = m[2].toLowerCase(), hit = / for \d+ points? of damage\.$/.test(line);
    if (_plLvOf(c) === X) { touch(); p.lv = X; if (hit) hitOn(mob); else missOn(mob); return; }
    if (hit) { const O = _plOh[c] || (_plOh[c] = {}), o = O[X] && now - O[X].last < 60e3 ? O[X] : (O[X] = { last: now, hits: 0, mobs: {} }); o.last = now; o.hits++; o.mobs[mob] = (o.mobs[mob] || 0) + 1; }
    return; }
  // your own kill while levelling someone: it went to you, not them
  if (_plLvOf(c) && (m = RE_PL_YSLAIN.exec(line))) { touch(); const mob = m[1].toLowerCase(), n = N(mob); n.killed++; n.alive = false; n.since = 0; n.lastKill = now;
    p.lv = _plLvOf(c); p.kills.push({ t: now, mob, by: c, xp: false, lv: true, to: 'you', n }); _plSend(c); return; }
  if ((m = RE_PL_SLAIN.exec(line))) { const mob = m[1].toLowerCase(); if (/^[A-Z][a-z]+$/.test(m[1])) return;   // a player died, not a mob
    touch(); const k = { t: now, mob, by: m[2] === 'You' ? c : m[2], xp: null }; p.kills.push(k);
    const n = N(mob); n.killed++; n.alive = false; n.since = 0; n.lastKill = now;
    k.n = n;
    { const by = k.by, lv = _plLvOf(c), X = by !== c && /^[A-Z][a-z]+$/.test(by) && !(_plPets[c] && _plPets[c].has(by)) ? by : null;
      const oh = X && _plOh[c] && _plOh[c][X] && now - _plOh[c][X].last < 60e3 ? _plOh[c][X] : null;
      if (X && (lv === X || (oh && !(p.own > 0)))) {   // their kill, they were swinging, you weren't: you're levelling them
        if (lv !== X) { for (const [mb, h] of Object.entries(oh.mobs)) { const q = N(mb); q.hits += h; q.tagged = Math.max(q.tagged || 0, 1); q.bursts = Math.max(q.bursts || 0, 1); } p.tags = (p.tags || 0) + Object.keys(oh.mobs).length; }
        _plLvl[c] = { who: X, at: now }; p.lv = X; k.lv = true; k.xp = true; k.chk = true; if (n.tagged > 0) n.tagged--; _plSend(c); return; }
      if (lv && by !== c && X) { p.lv = lv; k.lv = true; k.xp = false; k.to = X; _plSend(c); return; } }   // levelling, but the kill went to a third player
    setTimeout(() => { if (k.xp === null) { k.xp = false; _plSend(c); } }, 2500); _plSend(c); return; }   // no XP = an untagged one died
  if (RE_PL_XP.test(line)) { if (!p) return;
    const kc = p.kills.filter(x => x.chk && now - x.t <= 2500).pop();
    if (kc) { kc.lv = false; kc.chk = false; kc.party = line.indexOf('party experience') > 0; delete _plLvl[c]; p.lv = null; _plSend(c); return; }   // you got XP from it: a group / your pet, not levelling (party XP stays a group kill — 10-25: Auto popped in Mixelems' group)
    if (_plLvOf(c) && p.lv) return;
    let k = p.kills.filter(x => x.xp === null && now - x.t <= 2500).pop() || p.kills.filter(x => x.xp === false && now - x.t <= 3000).pop();
    if (!k && now - p.last <= 45e3) {   // XP with no "slain" line (it always comes right before its XP): a kill EverQuest didn't print — still a kill
      const cand = Object.values(p.names).filter(n => now - (n.last || 0) <= 20e3).sort((a, b) => ((b.tagged > 0) - (a.tagged > 0)) || (b.last - a.last))[0];
      k = { t: now, mob: cand ? cand.key : 'a mob', by: null, xp: null, unseen: true }; p.kills.push(k); p.last = now;
      if (cand) { cand.killed++; cand.lastKill = now; k.n = cand; } }
    if (k) { k.xp = true; k.party = line.indexOf('party experience') > 0; if (k.n && k.n.tagged > 0) k.n.tagged--; _plSend(c); } return; }   // a tagged one died
  if ((m = RE_PL_HIT.exec(line))) { touch(); p.own = (p.own || 0) + 1; if (p.lv && _plLvOf(c)) return;   // levelling someone: your hits tag nobody
    hitOn(m[1].toLowerCase()); return; }
  if ((m = RE_PL_MISS.exec(line))) { touch(); if (p.lv && _plLvOf(c)) return; missOn(m[1].toLowerCase()); return; }
  if (RE_PL_FAR.test(line)) { if (!p || now - p.last > 45e3) return; const pv = p.swing; p.swing = { name: pv ? pv.name : null, t: now, res: 'far', n: pv && pv.res === 'far' && now - pv.t < 10e3 ? (pv.n || 1) + 1 : 1 }; _plSend(c); return; }
  if ((m = RE_PL_SNARE_AE.exec(line)) || (m = RE_PL_SNARE_1.exec(line))) {
    touch(); const mob = m[1].toLowerCase(), ae = RE_PL_SNARE_AE.test(line); N(mob).last = now; N(mob).alive = true;
    const S = p.snare || (p.snare = { ae: {}, aeAt: 0, aeLast: 0, one: [], batches: [] });
    if (ae) { if (now - S.aeLast > 1500 || !S.batches.length) { S.batches.push({ t: now, c: {} }); if (S.batches.length > 12) S.batches.shift(); } const b = S.batches[S.batches.length - 1]; b.c[mob] = (b.c[mob] || 0) + 1; S.aeLast = now; S.ae[mob] = 1; }   // one Bonds cast = one batch of lines
    else S.one.push({ t: now, n: mob });
    _plSend(c); return; }
  if ((m = RE_PL_SEEN.exec(line))) { const who = m[1]; if (who === 'You' || who === 'YOU' || /^[A-Z][a-z]+$/.test(who)) return;   // a single capitalised word = a player / pet name
    if (!p || now - p.last > 45e3) return;   // only inside a pull (a kill or one of your hits starts one)
    const mob = who.toLowerCase(), n = N(mob); n.last = now; n.alive = true; p.last = now;
    if (!/ was /.test(line)) { n.atk.push(now); if (n.atk.length > 200) n.atk.splice(0, n.atk.length - 200); let j = n.atk.length - 1; while (j > 0 && now - n.atk[j - 1] < 6000) j--; n.peak = Math.max(n.peak || 0, n.atk.length - j); }   // an attack (not a damage-shield line)
    _plSend(c); }
}               // charName → [{spell, suffix, until}] casts waiting for their landing line (→ target)
const _castNow = {};                // charName → {spell, ts} last cast
const _lastCharm = {};              // charName → last charm-type spell cast
function _durAdd(map, spell, sec) { const e = map[spell] || (map[spell] = []); e.push(Math.round(sec)); if (e.length > 60) e.shift(); }
function _durSummary(map) { const out = {}; for (const [sp, l] of Object.entries(map)) { if (!l.length) continue; const s2 = l.slice().sort((a, b) => a - b); out[sp] = { med: s2[Math.floor(s2.length / 2)], n: l.length }; } return out; }
// guild-chat speakers heard by each of your logs: {logChar: {speaker: lastSeenMs}} (backfill + live) — the "current roster"
const RE_GUILD_SPEAKER = /^\[[^\]]+\] ([A-Z][a-z]+) tells the guild, /;
const _guildSpeakers = {};
function guildRoster(chars, days) {
  const since = Date.now() - (days || 90) * 864e5, want = new Set((chars || []).map(c => String(c).toLowerCase())), out = new Set();
  for (const [c, sp] of Object.entries(_guildSpeakers)) { if (want.size && !want.has(c.toLowerCase())) continue; for (const [n, t] of Object.entries(sp)) if (t >= since) out.add(n); }
  broadcast({ type: 'guildRoster', names: [...out], at: Date.now() });
}
// your characters: anyone with a log (eqlog_<Name>_…) or an inventory export (<Name>-Inventory.txt); refreshed every 5 min
let _ownNames = null, _ownNamesAt = 0;
function ownNames() {
  if (_ownNames && Date.now() - _ownNamesAt < 5 * 60e3) return _ownNames;
  const set = new Set();
  try { if (_config && _config.logDir) for (const f of fs.readdirSync(_config.logDir)) { const m = f.match(/^eqlog_(.+?)_P1999/i); if (m) set.add(m[1].toLowerCase()); } } catch {}
  try { if (_config && _config.logDir) for (const f of fs.readdirSync(path.dirname(_config.logDir))) { const m = f.match(/^([A-Za-z]+)-Inventory\.txt$/i); if (m) set.add(m[1].toLowerCase()); } } catch {}
  _ownNames = set; _ownNamesAt = Date.now(); return set;
}

async function capBackfill(force) {
  if (_capScanRunning || !_config || !_config.logDir) return;
  _capScanRunning = true;
  try {
    const cacheFp = _logPosPath ? path.join(path.dirname(_logPosPath), 'cap-cache.json') : null;
    let cache = {}; if (cacheFp && !force) { try { cache = JSON.parse(fs.readFileSync(cacheFp, 'utf8')); } catch {} }
    const results = {}, next = {}, prices = {}, whos = {}, sdAll = {};
    for (const d of [_config.logDir, path.join(_config.logDir, 'archive')]) {
      let names = []; try { names = fs.readdirSync(d); } catch { continue; }
      for (const f of names) {
        const c = (f.match(/^eqlog_(.+?)_P1999Green.*\.(?:txt|old)$/i) || [])[1]; if (!c) continue;
        const fp = path.join(d, f); let st; try { st = fs.statSync(fp); } catch { continue; }
        const hit = cache[fp]; let last = null, pr = {};
        let who = {}, gs = {}, sd = {}; const own = ownNames(); const lc = {}; let lcCharm = null;
        if (hit && hit.size === st.size && hit.mtime === st.mtimeMs && hit.prices && hit.whoV === 4) { last = hit.last; pr = hit.prices; who = hit.who || {}; gs = hit.gs || {}; sd = hit.sd || {}; }
        else {
          const tr = capTrack.createTracker();
          await new Promise(resolve => {
            const rl = require('readline').createInterface({ input: fs.createReadStream(fp, { encoding: 'latin1' }), crlfDelay: Infinity });
            rl.on('line', line => {
              const e = tr.feed(line); if (e && (!last || e.ts >= last.ts)) last = e;
              if (line.indexOf("tells you, 'I'll give you ") > 0) { const q = capTrack.vendorQuote(line); if (q) _vpAdd(pr, { lo: q.cp, hi: q.cp, n: 1, cp: q.cp, ts: q.ts }, q.item); }
              if (line.indexOf('You begin casting ') > 0) { const cm = RE_CAST_YOU.exec(line); if (cm) { const ct = capTrack.lineTs(line); lc[cm[1]] = ct; if (RE_CHARM_NAME.test(cm[1])) lcCharm = { sp: cm[1], t: ct }; } }
              else if (line.indexOf(' spell has worn off.') > 0) { const wm = RE_WORN_OFF.exec(line); if (wm) { const wt = capTrack.lineTs(line), sp = wm[1] === 'charm' ? (lcCharm && lcCharm.sp) : wm[1], t0 = wm[1] === 'charm' ? (lcCharm && lcCharm.t) : lc[wm[1]];
                if (sp && t0 && wt - t0 > 3e3 && wt - t0 < 3600e3) _durAdd(sd, sp, (wt - t0) / 1000); } }
              if (line.indexOf(' tells the guild, ') > 0) { const g = RE_GUILD_SPEAKER.exec(line); if (g) { const gt = capTrack.lineTs(line); if (gt && (!gs[g[1]] || gt > gs[g[1]])) gs[g[1]] = gt; } }
              if (line.indexOf('] [') > 0) { const w = RE_WHO_SELF.exec(line); if (w && own.has(w[3].toLowerCase())) who[w[3]] = { level: +w[1], title: w[2].trim(), race: w[4].trim(), ts: capTrack.lineTs(line) }; }   // a /who of any of your characters, last one wins
            });
            rl.on('close', resolve); rl.on('error', resolve);
          });
        }
        next[fp] = { size: st.size, mtime: st.mtimeMs, last, prices: pr, who, gs, sd, whoV: 4 };
        for (const [sp, l] of Object.entries(sd)) for (const v of l) _durAdd(sdAll, sp, v);
        { const tgt = _guildSpeakers[c] = _guildSpeakers[c] || {}; for (const [n, t] of Object.entries(gs)) if (!tgt[n] || t > tgt[n]) tgt[n] = t; }
        for (const [n, w] of Object.entries(who)) if (!whos[n] || (w.ts || 0) >= (whos[n].ts || 0)) whos[n] = w;
        if (last && (!results[c] || last.ts > results[c].ts)) results[c] = last;
        for (const [item, e] of Object.entries(pr)) _vpAdd(prices, e, item);
      }
    }
    if (cacheFp) { try { fs.writeFileSync(cacheFp, JSON.stringify(next), 'utf8'); } catch {} }
    broadcast({ type: 'capScanResult', results, scannedAt: Date.now() });
    broadcast({ type: 'vendorPrices', prices });   // what merchants have offered you, per item (copper): lo / hi / n / last
    broadcast({ type: 'whoScan', whos });
    _spellDur = _durSummary(sdAll); broadcast({ type: 'spellDurations', d: _spellDur });   // how long your roots / charms / DoTs last, from your logs   // the last /who of each of your characters, from any of your logs: class title, race, level
    log(`[CAP] ${Object.keys(results).length} character(s) with a cap use / recharge in the logs`);
  } catch (e) { err('[CAP]', e.message); }
  finally { _capScanRunning = false; }
}

function command(cmd, args) {
  if (cmd === 'requestAll') {
    sendFullSnapshot();
    raidBackfill();
    bindBackfill();
    skyCorpse.emit();
    capBackfill();
  } else if (cmd === 'reload') {
    stop();
    start({ config: _config, logPosPath: _logPosPath, factionPath: _factionPath, onMessage: _onMessage });
  } else if (cmd === 'scanSkills') {
    scanSkillsAllLogs();
  } else if (cmd === 'scanKillCounts') {
    scanKillCountsAllLogs(args && args.chars);
  } else if (cmd === 'parseFight') {
    const job = { id: args && args.id, logDir: _config && _config.logDir, names: args && args.names, from: args && args.from, to: args && args.to };
    if (_fpNoWorker) { _fpDirect(job); return; }
    try {
      if (!_fpWorker) { const { Worker } = require('worker_threads'); _fpWorker = new Worker(require.resolve('./fightparse'), { workerData: { fightParseWorker: true } });
        _fpWorker.on('message', m => { _fpPending.delete(m.id); broadcast({ type: 'fightParse', id: m.id, result: m.result }); });
        _fpWorker.on('error', e => _fpFail(e.message));
        _fpWorker.on('exit', () => { if (_fpPending.size) _fpFail('exited'); else _fpWorker = null; }); }
      _fpPending.set(job.id, job); _fpWorker.postMessage(job);
    } catch (e) { _fpPending.delete(job.id); _fpNoWorker = true; _fpDirect(job); }
  } else if (cmd === 'guildRoster') {
    guildRoster(args && args.chars, args && args.days);
  } else if (cmd === 'scanCaps') {
    capBackfill(true);
  } else if (cmd === 'scanLeveling') {
    scanLeveling(args && args.chars);
  } else if (cmd === 'scanSessions') {
    scanLogsForSessions(args && args.chars, args && args.idleGapMin);
  } else if (cmd === 'scanRaidTicks') {
    scanRaidHistory(args && args.since);
  } else if (cmd === 'scanCoins') {
    scanCoins(args && args.chars);
  } else if (cmd === 'resistSnapshot') {
    resistWatch.snapshot(args && args.chars);
  }
}

module.exports = { start, stop, command, sendFullSnapshot };
