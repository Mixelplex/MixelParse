// Fight parse for one raid kill (owner, 2026-10-18: "build all 5" — damage parse per kill, CH chain report, boss hit profile).
// Reads only the kill's time window from each log (binary search to the start), then:
//   damage on the boss per attacker (melee lines + your own "You hit …"), crits, unattributed non-melee (spells / shields),
//   the boss's hits (max / average / per target, misses), rampages / flurries / enrages,
//   Complete Heal landings ("X is completely healed.") and chain calls ("CA 007 CH -- Target").
// The same event shows in every one of your logs that saw it, so: third-person lines come from ONE log (the one that saw
// the most of the fight), each of your characters' own lines ("You …", "… hits YOU …") from its own log, and CH lines /
// chain calls are de-duplicated by second + text.
'use strict';
const fs = require('fs');
const path = require('path');

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
function lineTs(line) {
  const m = /^\[\w{3} (\w{3}) +(\d+) (\d+):(\d+):(\d+) (\d{4})\]/.exec(line);
  return m ? new Date(+m[6], MONTHS[m[1]], +m[2], +m[3], +m[4], +m[5]).getTime() : 0;
}
const VERBS = 'hits?|slash(?:es)?|pierces?|crush(?:es)?|kicks?|bash(?:es)?|punch(?:es)?|backstabs?|slices?|claws?|bites?|strikes?|stings?|mauls?|gores?|smash(?:es)?|rends?|frenz(?:y|ies) on|burns?|lashes|lash';
const RE_DMG = new RegExp('^(.+?) (' + VERBS + ') (.+?) for (\\d+) points? of damage\\.$');
const RE_MISS = /^(.+?) tries to \w+(?: on)? (.+?), but (?:misses|.+? (?:parries|dodges|ripostes|blocks|blocks with \w+ shield))!$/;
const RE_YOUMISS = /^You try to \w+ (.+?), but miss!$/;
const RE_NONMELEE = /^(.+?) was hit by non-melee for (\d+) points? of damage\.$/;
const RE_CRIT = /^(\w+) Scores a (critical hit|crippling blow)!\((\d+)\)$/;
const RE_RAMPAGE = /^(.+?) goes on a RAMPAGE!$/;
const RE_FLURRY = /^(.+?) executes a FLURRY of attacks on (.+?)!$/;
const RE_ENRAGE = /^(.+?) has become ENRAGED\.$/;
const RE_SLAIN = /^(.+?) has been slain by (.+?)!$/;
const RE_YOUSLAIN = /^You have slain (.+?)!$/;
const RE_CH = /^(.+?) is completely healed\.$/;
const RE_YOUCH = /^You are completely healed\.$/;
const RE_CALL = /^(?:(\w+) says out of character|You say out of character|(\w+) (?:says|shouts|tells the raid|tells the group)|You (?:say|shout|tell your raid|tell your party)), 'CA (\d+) CH -- ([^']+?)'$/;

// byte offset of the first line at or after ts (binary search on line timestamps)
function seekTs(fd, size, ts) {
  let lo = 0, hi = size; const buf = Buffer.alloc(8192);
  while (hi - lo > 65536) {
    const mid = Math.floor((lo + hi) / 2);
    const n = fs.readSync(fd, buf, 0, buf.length, mid); const s = buf.toString('latin1', 0, n);
    const i = s.indexOf('\n['); if (i < 0) { hi = mid; continue; }
    const t = lineTs(s.slice(i + 1));
    if (!t) { lo = mid + i + 1; continue; }
    if (t < ts) lo = mid; else hi = mid;
  }
  return lo;
}
function readWindow(fp, from, to, onLine) {
  let fd; try { fd = fs.openSync(fp, 'r'); } catch { return 0; }
  try {
    const size = fs.fstatSync(fd).size; let pos = seekTs(fd, size, from), carry = '', n = 0;
    const buf = Buffer.alloc(1 << 20);
    for (;;) {
      const r = fs.readSync(fd, buf, 0, buf.length, pos); if (r <= 0) break; pos += r;
      const lines = (carry + buf.toString('latin1', 0, r)).split(/\r?\n/); carry = lines.pop();
      for (const l of lines) { const t = lineTs(l); if (!t) continue; if (t < from) continue; if (t > to) return n; n++; onLine(l, t); }
    }
    if (carry) { const t = lineTs(carry); if (t >= from && t <= to) { n++; onLine(carry, t); } }
    return n;
  } finally { try { fs.closeSync(fd); } catch {} }
}

// names: the boss's names (full + short); from / to: the window to read (ms); logDir: EQ Logs folder
function parseFight({ logDir, names, from, to }) {
  const norm = n => String(n || '').toLowerCase().replace(/^the /, '').replace(/[`\u2018\u2019']/g, "'").trim();   // Vulak'Aerr = Vulak`Aerr
  const want = new Set((names || []).map(norm));
  const isBoss = n => want.has(norm(n));
  const files = [];
  for (const d of [logDir, path.join(logDir, 'archive')]) {
    let ls = []; try { ls = fs.readdirSync(d); } catch { continue; }
    for (const f of ls) { const c = (f.match(/^eqlog_(.+?)_P1999Green.*\.txt$/i) || [])[1]; if (!c) continue;
      const fp = path.join(d, f); let st; try { st = fs.statSync(fp); } catch { continue; } if (st.mtimeMs < from) continue; files.push({ c, fp }); }
  }
  // pass 1: per log, its events in the window
  const perLog = [];
  for (const { c, fp } of files) {
    const ev = []; let bossLines = 0;
    readWindow(fp, from, to, (l, t) => {
      const x = l.slice(l.indexOf('] ') + 2); let m;
      if ((m = RE_DMG.exec(x))) { const a = m[1] === 'You' ? c : m[1], tg = m[3] === 'YOU' ? c : m[3];
        if (isBoss(tg)) { bossLines++; ev.push({ t, k: 'dmg', a, n: +m[4], own: m[1] === 'You' }); }
        else if (isBoss(a)) { bossLines++; ev.push({ t, k: 'bhit', tg, n: +m[4], own: m[3] === 'YOU' }); }
        return; }
      if ((m = RE_YOUMISS.exec(x))) { if (isBoss(m[1])) ev.push({ t, k: 'miss', a: c, own: true }); return; }
      if ((m = RE_MISS.exec(x))) { if (isBoss(m[2])) ev.push({ t, k: 'miss', a: m[1] }); else if (isBoss(m[1])) ev.push({ t, k: 'bmiss', tg: m[2] === 'YOU' ? c : m[2], own: m[2] === 'YOU' }); return; }
      if ((m = RE_NONMELEE.exec(x))) { if (isBoss(m[1])) { bossLines++; ev.push({ t, k: 'nm', n: +m[2] }); } return; }
      if ((m = RE_CRIT.exec(x))) { ev.push({ t, k: 'crit', a: m[1], n: +m[3] }); return; }
      if ((m = RE_RAMPAGE.exec(x))) { if (isBoss(m[1])) ev.push({ t, k: 'ramp' }); return; }
      if ((m = RE_FLURRY.exec(x))) { if (isBoss(m[1])) ev.push({ t, k: 'flurry', tg: m[2] }); return; }
      if ((m = RE_ENRAGE.exec(x))) { if (isBoss(m[1])) ev.push({ t, k: 'enrage' }); return; }
      if ((m = RE_SLAIN.exec(x))) { if (isBoss(m[1])) ev.push({ t, k: 'slain', by: m[2] }); return; }
      if ((m = RE_YOUSLAIN.exec(x))) { if (isBoss(m[1])) ev.push({ t, k: 'slain', by: c }); return; }
      if ((m = RE_YOUCH.exec(x))) { ev.push({ t, k: 'ch', tg: c }); return; }
      if ((m = RE_CH.exec(x))) { ev.push({ t, k: 'ch', tg: m[1] }); return; }
      if ((m = RE_CALL.exec(x))) { ev.push({ t, k: 'call', by: m[1] || m[2] || c, slot: m[3], tg: m[4].trim() }); return; }
    });
    if (ev.length) perLog.push({ c, ev, bossLines });
  }
  if (!perLog.length) return { ok: false, error: 'No lines about this boss in your logs for that time.' };
  // the fight: the last unbroken stretch of the boss's lines — damage on / by it, rampages, flurries, enrage (gaps under
  // 2 minutes) up to the kill. Many logs have no damage lines at all (EQ's "Hits by others" filter, or too far away).
  const hits = [].concat(...perLog.map(p => p.ev.filter(e => e.k === 'dmg' || e.k === 'bhit' || e.k === 'nm' || e.k === 'ramp' || e.k === 'flurry' || e.k === 'enrage').map(e => e.t))).sort((a, b) => a - b);
  if (!hits.length) return { ok: false, error: 'Nothing about this boss in your logs for that time.' };
  const slainEv = [].concat(...perLog.map(p => p.ev.filter(e => e.k === 'slain'))).sort((a, b) => a.t - b.t)[0];
  let end = slainEv ? slainEv.t : hits[hits.length - 1], i = hits.length - 1;
  while (i > 0 && hits[i] > end) i--;
  let start = hits[i]; while (i > 0 && start - hits[i - 1] <= 120e3) { i--; start = hits[i]; }
  const inFight = e => e.t >= start - 5e3 && e.t <= end + 5e3;
  // one log for what everyone else did: the one that saw the most of the fight
  const owners = new Set(perLog.filter(p => p.ev.some(e => e.own && inFight(e))).map(p => p.c));
  const primary = perLog.slice().sort((a, b) => b.ev.filter(inFight).length - a.ev.filter(inFight).length)[0];
  const att = {}, bt = {}, A = n => att[n] || (att[n] = { name: n, dmg: 0, hits: 0, max: 0, miss: 0, crits: 0, critMax: 0 });
  let nm = 0, bossHits = 0, bossMiss = 0, bossMax = 0, bossSum = 0, ramp = 0, flurry = 0, enrage = 0; const flurryOn = {};
  const take = (e, fromPrimary) => {
    if (e.k === 'dmg') { const a = A(e.a); a.dmg += e.n; a.hits++; if (e.n > a.max) a.max = e.n; }
    else if (e.k === 'miss') A(e.a).miss++;
    else if (e.k === 'bhit') { bossHits++; bossSum += e.n; if (e.n > bossMax) bossMax = e.n; const b = bt[e.tg] || (bt[e.tg] = { name: e.tg, n: 0, dmg: 0, max: 0 }); b.n++; b.dmg += e.n; if (e.n > b.max) b.max = e.n; }
    else if (e.k === 'bmiss') bossMiss++;
    else if (fromPrimary && e.k === 'nm') nm += e.n;
    else if (fromPrimary && e.k === 'ramp') ramp++;
    else if (fromPrimary && e.k === 'flurry') { flurry++; flurryOn[e.tg] = (flurryOn[e.tg] || 0) + 1; }
    else if (fromPrimary && e.k === 'enrage') enrage++;
  };
  for (const e of primary.ev) { if (!inFight(e)) continue;
    const who = e.k === 'dmg' || e.k === 'miss' ? e.a : e.k === 'bhit' || e.k === 'bmiss' ? e.tg : null;
    if (who && owners.has(who) && !(e.own && primary.c === who)) continue;   // that character's own log counts it
    take(e, true); }
  for (const p of perLog) { if (p === primary) continue; for (const e of p.ev) if (e.own && inFight(e)) take(e, false); }
  // crits: by attackers on the boss (crit lines don't name the target)
  const critSeen = new Set();
  for (const p of perLog) for (const e of p.ev) if (e.k === 'crit' && inFight(e) && att[e.a]) { const k = e.t + '|' + e.a + '|' + e.n; if (critSeen.has(k)) continue; critSeen.add(k); att[e.a].crits++; if (e.n > att[e.a].critMax) att[e.a].critMax = e.n; }
  // Complete Heals and chain calls, de-duplicated across logs
  const chSeen = new Map(), callSeen = new Map();
  for (const p of perLog) for (const e of p.ev) {
    if (!inFight(e) && !(e.k === 'call' && e.t >= start - 300e3 && e.t <= end + 5e3)) continue;   // the chain starts before the pull
    if (e.k === 'ch') { const k = Math.floor(e.t / 1000) + '|' + e.tg; if (!chSeen.has(k)) chSeen.set(k, { t: e.t, tg: e.tg }); }
    if (e.k === 'call') { const k = Math.floor(e.t / 1000) + '|' + e.by + '|' + e.slot; if (!callSeen.has(k)) callSeen.set(k, { t: e.t, by: e.by, slot: e.slot, tg: e.tg }); }
  }
  const ch = [...chSeen.values()].sort((a, b) => a.t - b.t), calls = [...callSeen.values()].sort((a, b) => a.t - b.t);
  const chBy = {}; for (const x of ch) (chBy[x.tg] = chBy[x.tg] || []).push(x.t);
  const chTargets = Object.entries(chBy).map(([tg, ts]) => { let gap = 0; for (let j = 1; j < ts.length; j++) gap = Math.max(gap, ts[j] - ts[j - 1]); return { name: tg, n: ts.length, maxGap: gap, avgGap: ts.length > 1 ? (ts[ts.length - 1] - ts[0]) / (ts.length - 1) : 0 }; }).sort((a, b) => b.n - a.n);
  const callers = {}; for (const x of calls) { const c = callers[x.by] || (callers[x.by] = { name: x.by, n: 0, slot: x.slot }); c.n++; }
  const callTo = {}; for (const x of calls) callTo[x.tg] = (callTo[x.tg] || 0) + 1;
  let callGapMax = 0; for (let j = 1; j < calls.length; j++) callGapMax = Math.max(callGapMax, calls[j].t - calls[j - 1].t);
  const callEvery = calls.length > 1 ? (calls[calls.length - 1].t - calls[0].t) / (calls.length - 1) : 0;
  // rotation on the main target: slots cycle in number order; a skipped slot = a missed turn; a call that comes
  // more than 1.5 × the usual gap after the one before = late. A break of 30 s+ restarts the chain.
  let chain = null;
  const mainTg = Object.entries(callTo).sort((a, b) => b[1] - a[1])[0];
  if (mainTg && mainTg[1] >= 6) {
    const csAll = calls.filter(x => x.tg === mainTg[0]);                 // includes the pre-pull calls (for doubles / changes)
    const cs = csAll.filter(x => x.t >= start - 5e3); if (cs.length < 2) cs.push(...csAll.slice(-2));   // rotation stats: fight time only
    const order = [...new Set(cs.map(x => +x.slot))].sort((a, b) => a - b);
    const gaps = [], gapAt = []; for (let j = 1; j < cs.length; j++) { gaps.push((cs[j].t - cs[j - 1].t) / 1000);
      const ps = +cs[j - 1].slot, exp = order.length ? order[(order.indexOf(ps) + 1) % order.length] : 0;
      gapAt.push([Math.round((cs[j].t - start) / 1000), ps, +cs[j].slot, exp]); }   // [time from pull, slot before, slot that called, slot whose turn it was]
    const sg = gaps.filter(g => g < 30).slice().sort((a, b) => a - b), med = sg.length ? sg[Math.floor(sg.length / 2)] : 0;
    const slot = {}; for (const x of cs) { const k = +x.slot; const o = slot[k] || (slot[k] = { slot: x.slot, who: {}, n: 0, missed: 0, late: 0, first: x.t, last: x.t }); o.n++; o.who[x.by] = (o.who[x.by] || 0) + 1; if (x.t > o.last) o.last = x.t; }
    let prev = null, prevT = 0;
    for (const x of cs) {
      const k = +x.slot, gap = prevT ? (x.t - prevT) / 1000 : 0;
      if (prev != null && gap < 30 && k !== prev) {
        if (med && gap > med * 1.5) slot[k].late++;
        const pi = order.indexOf(prev), ki = order.indexOf(k), steps = (ki - pi + order.length) % order.length;
        if (steps > 1 && steps <= Math.ceil(order.length / 2)) for (let q = 1; q < steps; q++) { const o = slot[order[(pi + q) % order.length]]; if (x.t > o.first && x.t < o.last) o.missed++; }   // skipped over, while that healer was on the chain
      }
      if (k !== prev) { prev = k; prevT = x.t; }
    }
    // the live window's view: who holds which number; a healer calling a new number leaves the old one; two on one = doubled
    const hold = {}, dupsEv = [], moves = []; let lastDup = new Set();
    for (const x of csAll) { const k = +x.slot;
      for (const [n, who] of Object.entries(hold)) if (+n !== k && who[x.by]) { if (x.t - who[x.by] < 120e3) moves.push({ t: Math.round((x.t - start) / 1000), by: x.by, from: +n, to: k }); delete who[x.by]; }
      (hold[k] = hold[k] || {})[x.by] = x.t;
      const win = Math.max(45e3, (med || 3) * Math.max(order.length, 4) * 2.2 * 1000), now = new Set();
      for (const [n, who] of Object.entries(hold)) { const L = Object.entries(who).filter(([, t]) => x.t - t <= win).map(([nm]) => nm).sort(); if (L.length > 1) { const key = n + '|' + L.join(','); now.add(key); if (!lastDup.has(key)) dupsEv.push({ t: Math.round((x.t - start) / 1000), slot: +n, names: L }); } }
      lastDup = now; }
    chain = { target: mainTg[0], calls: cs.length, dups: dupsEv.slice(0, 60), moves: moves.slice(0, 80), healers: order.length, med, maxGap: sg.length ? sg[sg.length - 1] : 0,
      span: cs.length > 1 ? (cs[cs.length - 1].t - cs[0].t) / 1000 : 0, gaps: gaps.map(g => Math.round(g * 10) / 10).slice(0, 900), gapAt: gapAt.slice(0, 900),
      slots: order.map(k => { const o = slot[k]; const who = Object.entries(o.who).sort((a, b) => b[1] - a[1]); return { slot: o.slot, name: who[0][0], also: who.slice(1).map(w => w[0]), n: o.n, missed: o.missed, late: o.late, from: Math.round((o.first - cs[0].t) / 1000), to: Math.round((o.last - cs[0].t) / 1000) }; }) };
  }
  const dur = Math.max(1, (end - start) / 1000);
  const attackers = Object.values(att).map(a => Object.assign(a, { dps: a.dmg / dur })).sort((a, b) => b.dmg - a.dmg);
  const total = attackers.reduce((s, a) => s + a.dmg, 0);
  return {
    ok: true, v: 3, start, end, dur, total, nonMelee: nm, attackers,
    boss: { hits: bossHits, misses: bossMiss, max: bossMax, avg: bossHits ? bossSum / bossHits : 0, targets: Object.values(bt).sort((a, b) => b.dmg - a.dmg).slice(0, 15), rampage: ramp, flurry, flurryOn, enrage },
    ch: { landed: ch.length, targets: chTargets, calls: calls.length, callers: Object.values(callers).sort((a, b) => b.n - a.n), timeline: ch.slice(0, 400),
      callTo: Object.entries(callTo).map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n).slice(0, 8), callEvery, callGapMax, chain },
    melee: total > 0,
    logs: perLog.map(p => p.c), primary: primary.c, slainBy: slainEv ? slainEv.by : null,
  };
}

module.exports = { parseFight, lineTs };

// run as a worker thread: {id, logDir, names, from, to} in → {id, result} out (keeps the app's main process free)
try {
  const wt = require('worker_threads');
  if (!wt.isMainThread && wt.workerData && wt.workerData.fightParseWorker) {
    wt.parentPort.on('message', job => { let result; try { result = parseFight(job); } catch (e) { result = { ok: false, error: e.message }; } wt.parentPort.postMessage({ id: job.id, result }); });
  }
} catch {}
