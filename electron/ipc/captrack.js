'use strict';
// ipc/captrack.js
// Leatherfoot Raider Skullcap charge tracking (owner, 2026-10-12: "A dead cap means you die when the time really counts").
// The log never shows charges (the inventory file's count stays 1), so the state comes from two events:
//   USE      — you arrive in West Commonlands (the cap always lands there, ~478, 1427) from a zone that doesn't border it,
//              and it wasn't: a death ("You have lost experience." / "Returning to home point"), a login, a rez, a duel /
//              weapon-proc teleport, your own finished teleport spell, a wizard's mystic portal, or a group member's cast.
//   RECHARGE — you sell the cap to a merchant and buy it back seconds later. Whether you were being recharged or were the
//              recharger (they sell a full cap and buy it back), you end up holding a charged cap. Or someone hands you a cap
//              in a trade ("X has offered you a Leatherfoot Raider Skullcap." — the trade itself isn't logged).
//   A full cap has 1 charge (Effect: Ring of Commons, instant — no casting line).
// Checked on all the owner's logs: 6 of 6 caps announced in chat caught, 38 of 49 uses followed by a recharge.
// One tracker per character; feed() it every log line in order, it returns an event or null.

const WC = 'West Commonlands';
const WC_BORDER = new Set(['East Commonlands', 'Kithicor Forest', 'Kithicor Woods', 'Befallen', WC]);
const CAP = 'Leatherfoot Raider Skullcap';
const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const RE_TS = /^\[\w{3} (\w{3}) +(\d+) (\d\d):(\d\d):(\d\d) (\d{4})\]/;
const RE_TELEPORT = /^You begin casting (?:Gate|Common Gate|Common Portal|Ring of Commons|Circle of Commons|Translocate[^.]*|Succor[^.]*|Evacuate[^.]*|[^.]*Portal|[^.]*Gate)\.$/;
const RE_BROKE = /^(?:Your spell is interrupted|Your spell fizzles|You can't cast|Insufficient Mana|You must be standing)/;
// only lines that matter are kept (cheap on 500 MB archives)
const KEEP = ['LOADING, PLEASE WAIT', 'You have entered', 'You begin casting', 'interrupted', 'fizzles', "can't cast", 'Insufficient Mana',
  'must be standing', 'begins to cast a spell', 'mystic portal', 'lost experience', 'Returning to home point', 'have been slain by',
  'You died.', 'resurrection', 'duel to the death', 'the group', 'invites you to join', 'Welcome to EverQuest', CAP, 'You give '];

function lineTs(line) { const m = RE_TS.exec(line); return m ? new Date(+m[6], MON[m[1]], +m[2], +m[3], +m[4], +m[5]).getTime() : 0; }

function createTracker() {
  let zone = null, loadT = 0, inviter = null, group = new Set(), quote = null, sold = 0;
  const recent = [];   // {t, msg} — last ~2 min of kept lines
  return {
    feed(line) {
      if (line.length < 28 || line.charCodeAt(0) !== 91) return null;
      let keep = false; for (const k of KEEP) if (line.indexOf(k) > 0) { keep = true; break; }
      if (!keep) return null;
      const t = lineTs(line); if (!t) return null;
      const msg = line.slice(line.indexOf('] ') + 2);
      recent.push({ t, msg }); while (recent.length && recent[0].t < t - 150e3) recent.shift();
      let m;
      if ((m = /^([A-Z][a-z`]+) invites you to join a group\.$/.exec(msg))) { inviter = m[1]; return null; }
      if (msg === 'You have joined the group.') { group = new Set(inviter ? [inviter] : []); return null; }
      if ((m = /^([A-Z][a-z`]+) has joined the group\.$/.exec(msg))) { group.add(m[1]); return null; }
      if ((m = /^([A-Z][a-z`]+) has left the group\.$/.exec(msg))) { group.delete(m[1]); return null; }
      if (/^You (?:have been removed from|have left) the group|^Your group has been disbanded|^You are no longer grouped/.test(msg)) { group.clear(); return null; }
      if (/^Welcome to EverQuest!/.test(msg)) { group.clear(); return null; }
      if (msg === 'LOADING, PLEASE WAIT...') { loadT = t; return null; }
      // recharge: sell the cap, then buy one back from that merchant
      if (msg.indexOf(CAP) > 0) {
        if (/^You receive .* for the Leatherfoot Raider Skullcap\(s\)\.$/.test(msg)) { sold = t; return null; }
        // handed a cap in a trade — someone recharged it for you (Mixelflop, Aug 25 2026: "Millimeters has offered you a
        // Leatherfoot Raider Skullcap." 85 min after capping out of Hate; the game showed Charges: 1 later). Trades aren't
        // logged, the offer is.
        if ((m = /^(.+?) has offered you a Leatherfoot Raider Skullcap\.$/.exec(msg))) return { kind: 'recharge', ts: t, vendor: m[1] + ' (trade)', sold: false };
        if ((m = /^(.+?) tells you, 'That'll be .* for the Leatherfoot Raider Skullcap\.'$/.exec(msg))) { quote = { t, who: m[1] }; return null; }
      }
      if (quote && (m = /^You give .* to (.+?)\.$/.exec(msg))) {
        const q = quote; quote = null;
        if (m[1] === q.who && t - q.t <= 15e3) { const wasSold = sold && t - sold <= 10 * 60e3; sold = 0; return { kind: 'recharge', ts: t, vendor: q.who, sold: !!wasSold }; }
        return null;
      }
      if (!(m = /^You have entered (.+)\.$/.exec(msg))) return null;
      const to = m[1], from = zone; zone = to;
      if (to !== WC || !from || WC_BORDER.has(from) || WC_BORDER.has(from.replace(/^The /, ''))) return null;
      if (!(loadT && t - loadT < 30e3)) return null;
      const li = recent.map(x => x.msg).lastIndexOf('LOADING, PLEASE WAIT...'); if (li < 0) return null;
      const L = recent[li].t, win = recent.slice(0, li), w = s => win.filter(x => x.t >= L - s * 1e3);
      if (recent.some(x => x.t >= t - 30e3 && /^Welcome to EverQuest!/.test(x.msg))) return null;                                 // login
      if (w(60).some(x => /^You have lost experience\.|^Returning to home point|^You have been slain by|^You died\./.test(x.msg))) return null;   // death
      if (w(30).some(x => /^You regain some experience from resurrection/.test(x.msg))) return null;                              // rez
      if (w(120).some(x => /duel to the death/.test(x.msg))) return null;                                                        // duel / proc
      let ci = -1; for (let i = win.length - 1; i >= 0; i--) if (win[i].t >= L - 25e3 && RE_TELEPORT.test(win[i].msg)) { ci = i; break; }
      if (ci >= 0 && !win.slice(ci + 1).some(x => RE_BROKE.test(x.msg))) return null;                                            // own teleport
      if (w(20).some(x => /^[A-Z][a-z`]+ creates a mystic portal\.$/.test(x.msg))) return null;                                  // wizard portal
      if (w(20).some(x => { const c = /^([A-Z][a-z`]+) begins to cast a spell\.$/.exec(x.msg); return c && group.has(c[1]); })) return null;   // group port
      return { kind: 'use', ts: t, from };
    },
  };
}

module.exports = { createTracker, CAP };
