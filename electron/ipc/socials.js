// WTS hotbuttons with real item links (owner, 2026-10-28). EverQuest strips the link character (DC2, 0x12) from pasted
// text, so links only work from social macros saved in <Char>_P1999Green.ini. This reads a character's socials (so the
// Selling tab can show what's on each page) and writes the WTS lines as socials — safely:
//  - only a social page with nothing on it, and none of its buttons on a hotbar ([HotButtons] is never touched);
//  - later writes only replace buttons whose text is still exactly what MixelParse wrote (an edit in game = yours);
//  - only while the character is logged out (EQ keeps its own copy while you play and writes it back);
//  - a backup of the ini in MixelParse's folder first; every other line of the file stays as it was.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PAGES = 10, BUTTONS = 12;
const KEY = /^Page(\d+)Button(\d+)(Name|Color|Line\d)=(.*)$/;

function iniPath(eqDir, char) { return path.join(eqDir, char + '_P1999Green.ini'); }

// the file as lines (latin1 keeps every byte, the link character included) + its line ending
function readLines(file) {
  const raw = fs.readFileSync(file, 'latin1');
  const eol = /\r\n/.test(raw) ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return { lines, eol };
}

// [Socials] → { 'p,b': {page, button, name, color, lines:[]} } and the line numbers of that section
function parseSocials(lines) {
  const out = {}; let start = -1, end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const sec = /^\s*\[([^\]]+)\]\s*$/.exec(lines[i]);
    if (sec) { if (start >= 0) { end = i; break; } if (/^socials$/i.test(sec[1])) start = i; continue; }
    if (start < 0) continue;
    const m = KEY.exec(lines[i]); if (!m) continue;
    const k = m[1] + ',' + m[2], s = out[k] || (out[k] = { page: +m[1], button: +m[2], name: '', color: '', lines: [] });
    if (m[3] === 'Name') s.name = m[4]; else if (m[3] === 'Color') s.color = m[4]; else s.lines[+m[3].slice(4) - 1] = m[4];
  }
  return { socials: out, start, end };
}

// social numbers a hotbar points at (E##). Whether E counts from 0 or 1 isn't certain, so a slot is "on a hotbar" if
// either reading points at it.
function hotbarSocials(lines) {
  const refs = new Set(); let inHot = false;
  for (const l of lines) {
    const sec = /^\s*\[([^\]]+)\]\s*$/.exec(l); if (sec) { inHot = /^hotbuttons$/i.test(sec[1]); continue; }
    if (!inHot) continue;
    const m = /=E(\d+)\s*$/.exec(l); if (m) refs.add(+m[1]);
  }
  return refs;
}
const onHotbar = (refs, page, button) => refs.has((page - 1) * BUTTONS + button) || refs.has((page - 1) * BUTTONS + button - 1);

// logged out = EverQuest isn't running, or the character's log ends with the camp countdown
function onlineState(logDir, char) {
  let running = true;
  try { running = /eqgame\.exe/i.test(execFileSync('tasklist', ['/FI', 'IMAGENAME eq eqgame.exe', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })); } catch (e) {}
  if (!running) return { online: false, why: 'EverQuest isn’t running' };
  const log = path.join(logDir || '', 'eqlog_' + char + '_P1999Green.txt');
  try {
    const st = fs.statSync(log), n = Math.min(8192, st.size), fd = fs.openSync(log, 'r'), b = Buffer.alloc(n);
    fs.readSync(fd, b, 0, n, st.size - n); fs.closeSync(fd);
    const last = b.toString('latin1').split(/\r?\n/).filter(l => l.trim()).pop() || '';
    const ts = (/^\[([^\]]+)\]/.exec(last) || [])[1] || '';
    if (/prepare your camp/i.test(last)) return { online: false, why: 'camped ' + ts };
    return { online: true, why: 'last log line ' + ts + ' isn’t a camp', last: last.slice(0, 160) };
  } catch (e) { return { online: true, why: 'no log for ' + char + ' — can’t tell whether it’s logged in' }; }
}

// what MixelParse wrote, per character: { page, buttons: { b: { name, line } } }
function recFile(userData) { return path.join(userData, 'socials-written.json'); }
function readRec(userData) { try { return JSON.parse(fs.readFileSync(recFile(userData), 'utf8')); } catch (e) { return {}; } }
function saveRec(userData, rec) { try { fs.writeFileSync(recFile(userData), JSON.stringify(rec, null, 1)); } catch (e) {} }

// is a button still exactly what MixelParse wrote there?
const stillOurs = (s, r) => !!s && !!r && s.name === r.name && (s.lines[0] || '') === r.line && s.lines.filter(Boolean).length <= 1;

// a page MixelParse may use: its own page from last time (buttons edited in game are skipped), else the highest page
// with nothing on it and nothing of it on a hotbar
function pickPage(socials, refs, mine) {
  const used = p => Object.values(socials).filter(s => s.page === p);
  if (mine && mine.page) {
    const foreign = used(mine.page).filter(s => !stillOurs(s, (mine.buttons || {})[s.button]));
    if (foreign.length < BUTTONS) return { page: mine.page, reused: true, skip: new Set(foreign.map(s => s.button)) };
  }
  for (let p = PAGES; p >= 1; p--) {
    if (used(p).length) continue;
    let hot = false; for (let b = 1; b <= BUTTONS; b++) if (onHotbar(refs, p, b)) hot = true;
    if (!hot) return { page: p, reused: false, skip: new Set() };
  }
  return null;
}

function status({ eqDir, logDir, userData }, char) {
  if (!eqDir) return { ok: false, error: 'EQ folder not set (run Setup)' };
  const file = iniPath(eqDir, char);
  if (!fs.existsSync(file)) return { ok: false, error: 'No ' + char + '_P1999Green.ini in the EQ folder — log that character in once first' };
  const { lines } = readLines(file), { socials } = parseSocials(lines), refs = hotbarSocials(lines);
  const mine = readRec(userData)[char.toLowerCase()] || null, pick = pickPage(socials, refs, mine);
  const pages = {};
  for (const s of Object.values(socials)) (pages[s.page] = pages[s.page] || []).push({ b: s.button, name: s.name, line: (s.lines.find(Boolean) || ''), ours: !!mine && mine.page === s.page && stillOurs(s, (mine.buttons || {})[s.button]), hot: onHotbar(refs, s.page, s.button) });
  for (const p in pages) pages[p].sort((a, b) => a.b - b.b);
  return { ok: true, file, pages, page: pick ? pick.page : 0, reused: !!(pick && pick.reused), free: pick ? BUTTONS - pick.skip.size : 0, ...onlineState(logDir, char) };
}

// buttons: [{ name, line }] (one /auction line each). force: write although the character looks logged in.
function write({ eqDir, logDir, userData }, char, buttons, force) {
  if (!eqDir) return { ok: false, error: 'EQ folder not set (run Setup)' };
  const file = iniPath(eqDir, char);
  if (!fs.existsSync(file)) return { ok: false, error: 'No ' + char + '_P1999Green.ini in the EQ folder' };
  const on = onlineState(logDir, char);
  if (on.online && !force) return { ok: false, online: true, error: char + ' looks logged in (' + on.why + ') — camp first' };
  const { lines, eol } = readLines(file), sec = parseSocials(lines), refs = hotbarSocials(lines);
  const rec = readRec(userData), key = char.toLowerCase(), mine = rec[key] || null;
  const pick = pickPage(sec.socials, refs, mine);
  if (!pick) return { ok: false, error: 'No empty social page on ' + char + ' — clear one in game (Socials pages 1–10) and try again' };
  const slots = []; for (let b = 1; b <= BUTTONS; b++) if (!pick.skip.has(b)) slots.push(b);
  if (buttons.length > slots.length) return { ok: false, error: buttons.length + ' lines but only ' + slots.length + ' free buttons on page ' + pick.page + ' — check fewer items' };
  // backup first (MixelParse's own folder; the newest 20 per character are kept)
  const bdir = path.join(userData, 'ini-backups'); fs.mkdirSync(bdir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(file, path.join(bdir, char + '_P1999Green.' + stamp + '.ini'));
  try { fs.readdirSync(bdir).filter(f => f.toLowerCase().startsWith(key + '_p1999green.')).sort().slice(0, -20).forEach(f => fs.unlinkSync(path.join(bdir, f))); } catch (e) {}
  // drop only MixelParse's own buttons on that page, then add the new ones at the end of [Socials]
  const ours = new Set(); if (pick.reused) for (let b = 1; b <= BUTTONS; b++) if (!pick.skip.has(b)) ours.add(b);
  const kept = lines.filter((l, i) => { if (sec.start < 0 || i <= sec.start || i >= sec.end) return true; const m = KEY.exec(l); return !(m && +m[1] === pick.page && ours.has(+m[2])); });
  const add = [], done = {};
  buttons.forEach((bt, i) => { const b = slots[i], name = String(bt.name).slice(0, 32), line = String(bt.line);
    add.push('Page' + pick.page + 'Button' + b + 'Name=' + name, 'Page' + pick.page + 'Button' + b + 'Color=0', 'Page' + pick.page + 'Button' + b + 'Line1=' + line);
    done[b] = { name, line }; });
  let out;
  if (sec.start < 0) out = kept.concat(['[Socials]'], add);
  else { const s2 = parseSocials(kept); out = kept.slice(0, s2.end).concat(add, kept.slice(s2.end)); }
  const tmp = file + '.mptmp'; fs.writeFileSync(tmp, out.join(eol) + eol, 'latin1'); fs.renameSync(tmp, file);
  rec[key] = { page: pick.page, buttons: done, at: Date.now() }; saveRec(userData, rec);
  return { ok: true, page: pick.page, buttons: Object.keys(done).map(Number), backup: bdir };
}

module.exports = { status, write };
