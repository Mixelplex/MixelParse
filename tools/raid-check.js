// Pre-install raid check. Exit code 1 = a raid looks active (don't restart MixelParse), 0 = clear.
// Reads the newest lines of EVERY log (file mtimes are unreliable while EQ holds a log open) and
// looks at the timestamps INSIDE them: a fight in progress has no RAIDTICK yet, so enrage/rampage,
// raid-channel chat, raid ticks and being in a raid zone all count.
//   node tools/raid-check.js            (uses MixelParse's configured log folder)
const fs = require('fs'), path = require('path');
let logDir = 'C:\\Program Files (x86)\\Sony\\EverQuest\\Logs';
try { const c = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'MixelParse', 'config.json'), 'utf8')); if (c.logDir) logDir = c.logDir; } catch {}
const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const ts = l => { const m = /^\[\w{3} (\w{3}) +(\d+) (\d\d):(\d\d):(\d\d) (\d{4})\]/.exec(l); return m ? new Date(+m[6], MON[m[1]], +m[2], +m[3], +m[4], +m[5]).getTime() : 0; };
const RAID_ZONES = /Temple of Veeshan|Western Wastes|Veeshan's Peak|Sleeper's Tomb|Plane of (Fear|Hate|Air|Growth)|Kael Drakkel|Wakening Land|Dragon Necropolis|Icewell Keep|Thurgadin|Skyshrine|Cobalt Scar|Old Sebilis|Karnor's Castle|Emerald Jungle|Dreadlands|Skyfire|Timorous Deep|Great Divide|Velketor/i;
const now = Date.now(), ACTIVE = 15 * 60e3;
const out = [];
let raid = false;
for (const f of fs.readdirSync(logDir).filter(f => /^eqlog_.+_P1999Green\.txt$/i.test(f))) {
  const fp = path.join(logDir, f);
  let st; try { st = fs.statSync(fp); } catch { continue; }
  if (now - st.mtimeMs > 24 * 3600e3) continue;                       // not touched today at all
  const n = Math.min(256 * 1024, st.size), buf = Buffer.alloc(n);
  const fd = fs.openSync(fp, 'r'); fs.readSync(fd, buf, 0, n, st.size - n); fs.closeSync(fd);
  const lines = buf.toString('latin1').split(/\r?\n/).filter(Boolean);
  const last = ts(lines[lines.length - 1] || '');
  if (!last || now - last > ACTIVE) continue;                          // char not played in the last 15 min
  let zone = null; for (let i = lines.length - 1; i >= 0; i--) { const m = /\] You have entered (.+)\.$/.exec(lines[i]); if (m) { zone = m[1]; break; } }
  const recent = (ms, re) => lines.filter(l => re.test(l) && now - ts(l) <= ms);
  const sig = {
    tick: recent(60 * 60e3, /RAID ?TICK/i).length,
    raidChat: recent(15 * 60e3, /tells the raid|You tell your raid/).length,
    fight: recent(10 * 60e3, /ENRAGED|goes on a RAMPAGE|executes a FLURRY/).length,
  };
  const inRaidZone = zone && RAID_ZONES.test(zone);
  const hot = sig.fight > 0 || sig.raidChat > 0 || (sig.tick > 0 && inRaidZone);
  if (hot) raid = true;
  out.push(`${hot ? 'RAID ' : 'quiet'} ${f.replace(/^eqlog_|_P1999Green\.txt$/g, '').padEnd(14)} last line ${new Date(last).toLocaleTimeString()}  zone=${zone || '?'}  ticks/60m=${sig.tick} raidChat/15m=${sig.raidChat} enrage+rampage/10m=${sig.fight}`);
}
console.log(out.length ? out.join('\n') : 'no character played in the last 15 minutes');
console.log(raid ? '=> RAID ACTIVE - do not restart MixelParse' : '=> clear');
process.exit(raid ? 1 : 0);
