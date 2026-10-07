'use strict';
// ipc/skycorpse.js — every death (zone, slain by, time) and, for Plane of Sky corpses, the keys on them.
// (owner, 2026-10-06) All deaths are kept for the corpse strip; corpses without a zone are older Sky-only records.
//
// Sky keys vanish when you leave the zone, so players leave them on a corpse in Sky. Routines
// differ (die to the Key Master, duel a friend to skip the exp loss, leave early without dying),
// so ANY death while the zone is "Plane of Air" (the log's name for Sky) is a Sky corpse.
// A corpse lasts 7 days from death (the "/consider" corpse line reads "6 days, 23 hours, 57
// minutes" two minutes after a death); the rez window is 3 hours.
//
// Looting your own corpse isn't logged and people log out with keys and lose them, so keys are
// never assumed or carried forward — a corpse's keys are VERIFIED only by:
//   • an /outputfile inventory made in Plane of Air, during the same visit, before the death;
//   • a corpse export ("<Name>'s corpse123-Inventory.txt", /outputfile inventory with your
//     corpse open) written after the death.
// Otherwise keys = null (unverified).
//
// State persists in <userData>/sky-corpses.json and is rebuilt from the last 8 days of logs at
// startup (so corpses from before the app started show too). Renderer gets { type:'skyCorpses' }.

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SKY_ZONE = 'Plane of Air';
const DECAY_MS = 7 * 864e5;
const KEEP_MS = DECAY_MS + 864e5;          // show "decayed" for a day, then drop
const SKY_KEYS = ['Key of Swords', 'Key of the Misplaced', 'Key of Misfortune', 'Key of Beasts',
  'Avian Key', 'Key of the Swarm', 'Key of Scale', "Veeshan's Key"];
const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

let _log = () => {}, _err = () => {}, _broadcast = () => {};
let _statePath = null;
let _state = { chars: {} };                 // name -> { corpses:[{t,by,keys,keysSrc,keysAt}] }
const _rt = {};                             // name -> { zone, enteredAt, visitExport:{t,keys} }

const lineTs = l => { const m = /^\[\w{3} (\w{3}) +(\d+) (\d\d):(\d\d):(\d\d) (\d{4})\]/.exec(l); return m ? new Date(+m[6], MON[m[1]], +m[2], +m[3], +m[4], +m[5]).getTime() : 0; };
const rt = n => _rt[n] || (_rt[n] = { zone: null, enteredAt: 0, visitExport: null });
const charOf = n => _state.chars[n] || (_state.chars[n] = { corpses: [] });

// Sky keys in an inventory export (tab-separated Location, Name, ID, Count, Slots); bank rows don't count.
function keysIn(content) {
  const found = [];
  for (const line of String(content || '').split(/\r?\n/)) {
    const p = line.split('\t'); if (p.length < 2) continue;
    if (/^(bank|sharedbank)/i.test(p[0])) continue;
    const n = p[1].replace(/\*+$/, '').trim();
    if (SKY_KEYS.includes(n) && !found.includes(n)) found.push(n);
  }
  return found;
}

function save() {
  if (!_statePath) return;
  try { fs.writeFileSync(_statePath, JSON.stringify(_state), 'utf8'); } catch (e) { _err('[SKY] save failed:', e.message); }
}
function prune(now) {
  for (const c of Object.values(_state.chars)) c.corpses = c.corpses.filter(x => now - x.t < KEEP_MS);
}
function snapshot() {
  prune(Date.now());
  return { type: 'skyCorpses', chars: _state.chars, decayMs: DECAY_MS, rezMs: 3 * 3600e3, keys: SKY_KEYS };
}
function emit() { save(); _broadcast(snapshot()); }

function addCorpse(name, t, by, exp, zone) {
  const c = charOf(name);
  if (c.corpses.some(x => x.t === t)) return false;            // replay + live overlap
  c.corpses.push({ t, by, zone: zone || null, keys: exp ? exp.keys : null, keysSrc: exp ? 'export' : null, keysAt: exp ? exp.t : null });
  c.corpses.sort((a, b) => a.t - b.t);
  return true;
}

// One log line. Returns true when the state changed.
function line(raw, name, ts) {
  if (raw.length < 28 || raw.charCodeAt(0) !== 91) return false;
  const s = raw.slice(raw.indexOf('] ') + 2), r = rt(name);
  let m;
  if ((m = /^You have entered (.+)\.$/.exec(s))) {
    r.zone = m[1]; r.enteredAt = ts; r.visitExport = null;       // a new visit — keys from an earlier one are gone
    return false;
  }
  if ((m = /^You have been slain by (.+?)!$/.exec(s)) || (m = /^(You died)\.$/.exec(s))) {
    const sky = r.zone === SKY_ZONE;
    const exp = sky && r.visitExport && r.visitExport.t >= r.enteredAt && r.visitExport.t <= ts + 5e3 ? r.visitExport : null;
    if (sky) r.visitExport = null;
    return addCorpse(name, ts, m[1] === 'You died' ? '' : m[1], exp, r.zone);
  }
  if (r.zone && /^You don't have any corpses in this zone\.$/.test(s)) {
    const c = charOf(name), n = c.corpses.length;
    c.corpses = c.corpses.filter(x => x.t > ts || (x.zone || SKY_ZONE) !== r.zone);
    return c.corpses.length !== n;
  }
  return false;
}

// An inventory export arrived (live). Counts only when that character is in Sky right now.
function inventory(name, content, mtimeMs) {
  const r = rt(name);
  if (r.zone !== SKY_ZONE || !(mtimeMs >= r.enteredAt) || Date.now() - mtimeMs > 10 * 60e3) return;
  r.visitExport = { t: mtimeMs, keys: keysIn(content) };
  _log(`[SKY] ${name}: inventory export in Sky — ${r.visitExport.keys.length} key(s)`);
}

// "<Name>'s corpse123-Inventory.txt" — exact contents of that character's corpse.
function corpseInventory(filename, content, mtimeMs) {
  const m = /^(.+?)'s corpse\d*-Inventory\.txt$/i.exec(filename); if (!m) return;
  const name = Object.keys(_state.chars).find(n => n.toLowerCase() === m[1].toLowerCase()) || m[1];
  const c = _state.chars[name]; if (!c || !c.corpses.length) return;
  // the newest Sky corpse that died before this export and hasn't decayed
  const target = c.corpses.filter(x => (x.zone || SKY_ZONE) === SKY_ZONE && x.t <= mtimeMs && mtimeMs - x.t < DECAY_MS).pop();
  if (!target || (target.keysSrc === 'corpse' && target.keysAt >= mtimeMs)) return;
  target.keys = keysIn(content); target.keysSrc = 'corpse'; target.keysAt = mtimeMs;
  _log(`[SKY] ${name}: corpse export — ${target.keys.length} key(s) on the Sky corpse`);
  emit();
}

// Rebuild the last 8 days from the live logs. An inventory file whose mtime falls inside a Sky
// visit before a death verifies that corpse's keys (only the latest export exists on disk).
async function backfill(logDir, eqDir) {
  const since = Date.now() - KEEP_MS;
  let files = [];
  try { files = fs.readdirSync(logDir).filter(f => /^eqlog_.+_P1999Green\.txt$/i.test(f)); } catch { return; }
  let changed = false;
  for (const f of files) {
    const fp = path.join(logDir, f);
    let st; try { st = fs.statSync(fp); } catch { continue; }
    if (st.mtimeMs < since) continue;
    const name = (f.match(/^eqlog_(.+?)_P1999Green/i) || [])[1]; if (!name) continue;
    let inv = null;
    try { const ip = path.join(eqDir, name + '-Inventory.txt'); inv = { t: fs.statSync(ip).mtimeMs, keys: keysIn(fs.readFileSync(ip, 'utf8')) }; } catch {}
    const r = { zone: null, enteredAt: 0, visitExport: null };
    const saveRt = _rt[name]; _rt[name] = r;
    await new Promise(resolve => {
      const rl = readline.createInterface({ input: fs.createReadStream(fp, { encoding: 'latin1' }), crlfDelay: Infinity });
      rl.on('line', l => {
        if (l.indexOf('You have entered') < 0 && l.indexOf('slain by') < 0 && l.indexOf('You died') < 0 && l.indexOf('corpses in this zone') < 0) return;
        const ts = lineTs(l); if (!ts) return;
        if (inv && r.zone === SKY_ZONE && inv.t >= r.enteredAt && inv.t <= ts && !r.visitExport) r.visitExport = inv;
        if (ts < since && l.indexOf('You have entered') < 0) return;
        if (line(l, name, ts)) changed = true;
      });
      rl.on('close', resolve); rl.on('error', resolve);
    });
    // keep the live zone if the live tail already moved past the replay
    _rt[name] = saveRt && saveRt.enteredAt > r.enteredAt ? saveRt : r;
  }
  if (changed) _log('[SKY] backfill: corpses rebuilt from logs');
  emit();
}

function init({ dataDir, log, err, broadcast }) {
  if (log) _log = log; if (err) _err = err; if (broadcast) _broadcast = broadcast;
  _statePath = dataDir ? path.join(dataDir, 'sky-corpses.json') : null;
  try { const j = JSON.parse(fs.readFileSync(_statePath, 'utf8')); if (j && j.chars) _state = j; } catch {}
}

module.exports = { init, line, inventory, corpseInventory, backfill, snapshot, emit, keysIn, lineTs };
