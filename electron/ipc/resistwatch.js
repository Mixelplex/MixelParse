'use strict';
// ipc/resistwatch.js — Resist data recorder (WATCH-ONLY, silent).
//
// P99's resist math is undocumented (Haynar: per-spell resist adjusts, a non-linear
// curve, level difference). Nothing in the app uses this yet: it only appends what
// the logs show to <userData>/resist-watch.jsonl so the curve can be fitted later.
//
// One JSON object per line:
//   k:'in'  a spell cast ON the character — o:'resist' ("You resist the X spell!") or
//           o:'land' (the spell's cast-on-you text), dmg = the "You were hit by non-melee"
//           that follows (breaths / nukes — partial resists show as lower damage).
//           cast = recent "X begins to cast a spell." lines, con = their last /con phrase.
//   k:'out' the character's own detrimental spell — o:'resist' ("Your target resisted"),
//           'land' (cast-on-other text, with the target) or 'nohold'. con = the target's
//           (or the last considered mob's) con phrase.
//   rs   = the renderer's resist snapshot for the character (base / gear / parked buffs,
//          level, class); buffs = resist-changing spells that landed on the character and
//          haven't faded (from the logs: cast-on-you / fades text of spells_us.txt).
// Spell facts (resist type rt, resist adjust adj) come from the client's spells_us.txt.

const fs   = require('fs');
const path = require('path');

const RT = ['none', 'magic', 'fire', 'cold', 'poison', 'disease', 'chromatic', 'prismatic', 'physical', 'corruption'];
const RESIST_FX = { 46: 'fr', 47: 'cr', 48: 'pr', 49: 'dr', 50: 'mr' };
const MAX_BYTES = 20 * 1024 * 1024;   // then rotate to .1 (one generation kept)
const CAST_WINDOW = 12e3;             // "begins to cast" → outcome
const CON_TTL = 30 * 60e3;

let _log = () => {}, _err = () => {};
let _eqDir = null, _outPath = null;
let _sp = null;          // loaded spell tables, or false when spells_us.txt is unavailable
const _snap = {};        // charLower -> renderer snapshot
const _st = {};          // charName -> per-character state

function _loadSpells() {
  if (_sp !== null) return _sp;
  _sp = false;
  if (!_eqDir) return _sp;
  try {
    const rows = fs.readFileSync(path.join(_eqDir, 'spells_us.txt'), 'latin1').split(/\r?\n/);
    const byName = new Map(), onYou = new Map(), buffOn = new Map(), buffFade = new Map();
    for (const l of rows) {
      const r = l.split('^');
      if (r.length < 150 || !r[1]) continue;
      const name = r[1], good = r[83] !== '0';
      // Resist type counts for detrimental spells, and for "beneficial" ones only when they are
      // lulls / charms (SE 18 / 22 / 30 / 86) — illusions carry a resist type too but aren't rolled.
      const eff = r.slice(86, 98).map(Number);
      const rt = good && !eff.some(e => e === 18 || e === 22 || e === 30 || e === 86) ? 0 : (+r[85] || 0);
      const fx = {};
      for (let i = 0; i < 12; i++) {
        const k = RESIST_FX[+r[86 + i]];
        if (k) { const v = +r[20 + i] || 0, mx = +r[44 + i] || 0; if (v) fx[k] = v > 0 ? Math.max(v, mx) : v; }
      }
      // Direct damage = first HP effect (SE 0 / 79) with a negative base.
      let dd = 0;
      for (let i = 0; i < 12; i++) if ((eff[i] === 0 || eff[i] === 79) && +r[20 + i] < 0) { dd = -r[20 + i]; break; }
      const info = { rt: RT[rt] || String(rt), adj: +r[147] || 0, cast: +r[13] || 0, onOther: r[7] || '', good, dd };
      // Same-name versions differ ("Lava Breath": adj 0 / -17 / -400; "Rain of Molten Lava": 1000 / 300
      // damage): keep every distinct [adj, damage] so an event can list them, and a landing's
      // damage can pick the one that hit.
      const first = byName.get(name);
      if (!first) { info.vars = [[info.adj, dd]]; byName.set(name, info); }
      else if (rt && !first.vars.some(v => v[0] === info.adj && v[1] === dd)) first.vars.push([info.adj, dd]);
      // Any spell with a resist type — lulls (Pacify) and charms are flagged beneficial in the data.
      if (rt && r[6]) { const a = onYou.get(r[6]) || []; if (!a.includes(name)) a.push(name); onYou.set(r[6], a); }
      if (Object.keys(fx).length && r[6]) {
        const a = buffOn.get(r[6]) || [];
        if (!a.some(b => b.n === name)) a.push({ n: name, fx, dur: (+r[17] || 0) * 6e3 || 3 * 3600e3 });
        buffOn.set(r[6], a);
        if (r[8]) { const f = buffFade.get(r[8]) || new Set(); f.add(r[6]); buffFade.set(r[8], f); }
      }
    }
    // Shared landing texts: real spells first ("Lava Breath - Test", GM / NPC-only copies last).
    const junk = n => /\btest\b|^gm |\bnpc\b/i.test(n) ? 1 : 0;
    for (const a of onYou.values()) a.sort((x, y) => junk(x) - junk(y));
    _sp = { byName, onYou, buffOn, buffFade };
    _log(`[RESIST] spells_us.txt: ${byName.size} spells, ${onYou.size} landing texts, ${buffOn.size} resist-buff texts`);
  } catch (e) { _err('[RESIST] spells_us.txt unavailable:', e.message); }
  return _sp;
}

function init({ eqDir, dataDir, log, err }) {
  if (log) _log = log; if (err) _err = err;
  _eqDir = eqDir || null; _sp = null;
  _outPath = dataDir ? path.join(dataDir, 'resist-watch.jsonl') : null;
}

// Renderer → { chars: { name: {lv, cls, race, base:{mr..}|null, gear:{mr..}, parked:{mr..}} } }
function snapshot(chars) {
  if (!chars) return;
  const at = Date.now();
  for (const [n, s] of Object.entries(chars)) _snap[n.toLowerCase()] = Object.assign({ at }, s);
}

function _write(ev) {
  if (!_outPath) return;
  try {
    try { if (fs.statSync(_outPath).size > MAX_BYTES) fs.renameSync(_outPath, _outPath + '.1'); } catch {}
    fs.appendFileSync(_outPath, JSON.stringify(ev) + '\n', 'utf8');
  } catch (e) { _err('[RESIST] write failed:', e.message); }
}

function _state(c) {
  return _st[c] || (_st[c] = { casters: [], cons: new Map(), lastCon: null, buffs: new Map(), out: null, pendIn: null });
}
function _conOf(st, name, ts) {
  const c = name && st.cons.get(name.toLowerCase());
  return c && ts - c.ts < CON_TTL ? c.p : undefined;
}
function _buffsNow(st, ts) {
  const out = [];
  for (const [txt, b] of st.buffs) {
    if (ts - b.ts > b.maxDur) { st.buffs.delete(txt); continue; }
    out.push({ c: b.cands, age: Math.round((ts - b.ts) / 1e3) });
  }
  return out.length ? out : undefined;
}
function _base(charName, st, ts, zone) {
  const ev = { t: ts, c: charName };
  if (zone) ev.z = zone;
  const rs = _snap[charName.toLowerCase()]; if (rs) ev.rs = rs;
  const b = _buffsNow(st, ts); if (b) ev.buffs = b;
  return ev;
}
// A landing's damage names the version that hit when exactly one version does that damage.
function _pickVar(ev) {
  if (!ev.vars || !ev.dmg) return;
  const hit = ev.vars.filter(v => v[1] === ev.dmg);
  if (hit.length === 1) { ev.adj = hit[0][0]; ev.byDmg = true; }
}
function _flushIn(st) { if (st.pendIn) { _pickVar(st.pendIn.ev); _write(st.pendIn.ev); st.pendIn = null; } }

// One log line (with its "[timestamp] " prefix). ts = the line's own time (ms).
function line(raw, charName, ts, zone) {
  const sp = _loadSpells();
  if (!sp || raw.length < 28 || raw.charCodeAt(0) !== 91) return;
  const s = raw.slice(raw.indexOf('] ') + 2);
  const st = _state(charName);
  let m;

  // Damage that belongs to the incoming spell that just landed (same second or next lines).
  if (st.pendIn) {
    if ((m = /^You were hit by non-melee for (\d+) damage\.$/.exec(s))) { st.pendIn.ev.dmg = +m[1]; _flushIn(st); return; }
    if (++st.pendIn.n > 3 || ts - st.pendIn.ev.t > 2e3) _flushIn(st);
  }
  if (s.indexOf(", '") >= 0 || / says? '/.test(s)) return;   // chat / NPC speech

  if ((m = /^(.+?) begins to cast a spell\.$/.exec(s))) {
    st.casters = st.casters.filter(c => ts - c.ts < CAST_WINDOW);
    st.casters.push({ n: m[1], ts }); if (st.casters.length > 6) st.casters.shift();
    return;
  }
  if ((m = /^(.+?) (?:regards|considers|judges|glares at|scowls at)\b.*? -- (.+)$/.exec(s))) {
    const k = m[1].toLowerCase(); st.cons.set(k, { p: m[2], ts }); st.lastCon = { n: m[1], ts };
    if (st.cons.size > 300) st.cons.delete(st.cons.keys().next().value);
    return;
  }
  if (/^Welcome to EverQuest!|^You have been slain by |^You died\./.test(s)) { st.buffs.clear(); st.out = null; return; }

  // ── Own spells (outgoing) ──
  if ((m = /^You begin casting (.+)\.$/.exec(s))) {
    const info = sp.byName.get(m[1]);
    st.out = info && info.rt !== 'none' ? { sp: m[1], info, ts, lands: 0 } : null;
    return;
  }
  if (st.out && ts - st.out.ts > st.out.info.cast + 4e3) st.out = null;
  if ((m = /^Your target resisted the (.+) spell\.$/.exec(s))) {
    const info = sp.byName.get(m[1]) || {};
    const ev = Object.assign(_base(charName, st, ts, zone), { k: 'out', sp: m[1], o: 'resist', rt: info.rt, adj: info.adj });
    const lc = st.lastCon; if (lc && ts - lc.ts < CON_TTL) { ev.tgt = lc.n; ev.con = _conOf(st, lc.n, ts); ev.tgtGuess = true; }
    _write(ev); st.out = null; return;
  }
  if (st.out && /^Your spell did not take hold\.$/.test(s)) {
    _write(Object.assign(_base(charName, st, ts, zone), { k: 'out', sp: st.out.sp, o: 'nohold', rt: st.out.info.rt, adj: st.out.info.adj }));
    st.out = null; return;
  }
  if (st.out && /^Your spell (?:is interrupted|fizzles)/.test(s)) { st.out = null; return; }
  if (st.out && st.out.info.onOther.length > 3 && s.endsWith(st.out.info.onOther) && st.out.lands < 12) {
    const tgt = s.slice(0, s.length - st.out.info.onOther.length).trim();
    const ev = Object.assign(_base(charName, st, ts, zone), { k: 'out', sp: st.out.sp, o: 'land', rt: st.out.info.rt, adj: st.out.info.adj, tgt });
    const con = _conOf(st, tgt, ts); if (con) ev.con = con;
    _write(ev); st.out.lands++; return;
  }

  // ── Spells cast on the character (incoming) ──
  const incoming = (o, names, extra) => {
    const info = sp.byName.get(names[0]) || {};
    st.casters = st.casters.filter(c => ts - c.ts < CAST_WINDOW);
    const ev = Object.assign(_base(charName, st, ts, zone), { k: 'in', sp: names[0], o, rt: info.rt, adj: info.adj }, extra || {});
    if (info.vars && info.vars.length > 1) ev.vars = info.vars;   // [adj, damage] per version; see _pickVar
    if (names.length > 1) ev.cands = names.slice(0, 6).map(n => { const i = sp.byName.get(n) || {}; return { n, rt: i.rt, adj: i.adj }; });
    if (st.casters.length) ev.cast = st.casters.map(c => { const x = { n: c.n, a: Math.round((ts - c.ts) / 100) / 10 }; const p = _conOf(st, c.n, ts); if (p) x.con = p; return x; });
    return ev;
  };
  if ((m = /^You resist the (.+) spell!$/.exec(s))) { _flushIn(st); _write(incoming('resist', [m[1]])); return; }
  let body = s, dmg;
  if ((m = /^(.+?\.)\s+You have taken (\d+) points? of damage\.$/.exec(s))) { body = m[1]; dmg = +m[2]; }
  const names = sp.onYou.get(body);
  if (names) {
    _flushIn(st);
    const ev = incoming('land', names, dmg ? { dmg } : null);
    if (dmg) { _pickVar(ev); _write(ev); }
    else { st.pendIn = { ev, n: 0 }; setTimeout(() => { if (st.pendIn && st.pendIn.ev === ev) _flushIn(st); }, 4e3); }
    // a resist debuff that landed also changes resists — fall through to the buff tracker
  }

  // ── Resist-changing buffs / debuffs on the character ──
  const b = sp.buffOn.get(body);
  if (b) { st.buffs.set(body, { cands: b.map(x => ({ n: x.n, fx: x.fx })).slice(0, 6), ts, maxDur: Math.max(...b.map(x => x.dur)) }); return; }
  const fades = sp.buffFade.get(s);
  if (fades) for (const t of fades) st.buffs.delete(t);
}

module.exports = { init, snapshot, line };
