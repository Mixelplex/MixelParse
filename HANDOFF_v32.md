# MixelParse Handoff — v32

## Session Summary
Bug fix pass — all 5 bugs from the session report addressed. `index.html`, `watcher.js`, and `mixelparse-watcher.js` were modified. `admin.html`, `setup.html`, `main.js`, `preload.js` unchanged.

---

## Bugs Fixed This Session

### Bug 1 — Watchlist badges: replace "✔ Have / ✘ Need" with plain ✔ / ✘ / N/A ✅
**Problem:** Single-char watchlist used styled pill badges ("✔ Have", "✘ Need"). All Characters overview used plain `rc-check-green` / `rc-check-red` / `rc-check-na` classes. User wanted them to match.

**Fix (index.html `renderWatchlistBar`):**
- Single-char view: replaced inline-styled badge `<span>` elements with `rc-check-green` / `rc-check-red` / `rc-check-na` class spans. No more "Have" / "Need" text — just ✔ / ✘ / N/A.
- All-chars table view: replaced inline-styled `<td>` cells with `class="rc-check"` cells containing the same class spans, matching the raid consumes overview style.

---

### Bug 2 — 2H weapon shows as MH; 2H mode not auto-selected ✅
**Problem:** Characters with a 2H weapon equipped in PRIMARY (Mixelreaper, Wenril) showed the weapon in the MH card and `is2hMode` defaulted to `false`. The 2H card showed `(none)`.

**Root cause:** `window['_upgTwoHander_'+name]` defaulted to `undefined` (falsy), and nothing set it based on what the character actually has equipped.

**Fix (index.html `renderUpgradesPanel`):** Added auto-detect block immediately before the `const is2hMode` line:
```js
if(window['_upgTwoHander_'+name] === undefined){
  const primaryItem = slotResults.find(sr => sr.dbSlot==='PRIMARY' && !sr.isEmpty && !sr.is2hCard);
  if(primaryItem){
    const sk = (primaryItem.currentData._skill || primaryItem.currentData._itemType || '').toLowerCase();
    if(sk.includes('2h') || sk.includes('two hand')){
      window['_upgTwoHander_'+name] = true;
    }
  }
}
```
Only fires when the flag is `undefined` (never set) — a manual toggle-off by the user is respected.

---

### Bug 3 — TOD modal spam on startup / random bosses / window shrinking ✅
**Problem:** TOD modals kept appearing with random old bosses on app startup/watcher reconnect. The "shrinking" effect was multiple modals stacking behind each other.

**Root cause:** The Electron watcher (`watcher.js`) sends `notesUpdate` with the **full** notes.txt content every time the file changes. On first call, `_lastNotesLineCount = 0`, so ALL existing note lines were treated as new and matched against `_NOTES_BOSS_LIST`, re-firing every previously recorded TOD.

**Fix (index.html `_handleNotesUpdate`):** Added `_notesBaselineSet` flag. The **first** `notesUpdate` call now sets `_lastNotesLineCount` to the full file length and returns without processing anything. Only subsequent calls (actual new lines added) trigger TOD enqueue.

```js
let _notesBaselineSet = false;
function _handleNotesUpdate(text, timestamp){
  if(!text) return;
  const allLines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if(!_notesBaselineSet){
    _lastNotesLineCount = allLines.length;
    _notesBaselineSet = true;
    return; // treat initial content as already-seen baseline
  }
  // ... only new lines processed
}
```

---

### Bug 4 — Zone tracker not visible / not working ✅
**Two root causes fixed:**

**Fix A — `invCache` stored MD5 hashes instead of content (watcher.js):**
`handleInvFile` stored the MD5 hash in `invCache[filename]` for dedup, but `sendFullSnapshot` sent `invCache` values as inventory content — sending hash strings, not file text. Characters never reloaded on reconnect.
- Fixed by splitting into `invCache` (actual content) and `invHashes` (MD5, dedup-only).

**Fix B — Zone state empty on startup (watcher.js):**
On `watcher.on('add', ...)` the watcher seeked to end-of-file and never parsed prior log content, so `zoneState` was empty. `requestAll` / `sendFullSnapshot` sent nothing for zones.
- Added `scanLastZoneFromLog(fp, charName)`: reads last 50KB of log, scans backwards for most recent "You have entered X." line, populates `zoneState` and broadcasts `zoneUpdate` immediately on startup.
- Zone bar now populates as soon as the Electron app starts, without needing to zone first.

---

### Bug 5 — Faction tracking not working ✅
**Root cause (watcher.js):**
- Faction log key had spaces stripped (`ClawsofVeeshan`) but `displayName` was also set to the stripped key — `index.html` `renderFactionsPanel` couldn't match it to any known faction display name.
- `applyFactionDelta` signature didn't include `displayName`.

**Fix (watcher.js):**
- Added `TRACKED_FACTIONS` map (same as `mixelparse-watcher.js`) mapping stripped log keys → proper display names.
- `processLogLine` now extracts `logKey` (stripped) and looks up `displayName = TRACKED_FACTIONS[logKey] || rawName`.
- `applyFactionDelta(charName, logKey, displayName, delta, source)` — now passes display name through to `factionUpdate` payload.
- `buildFactionSnapshot` now resolves display names via `TRACKED_FACTIONS`.

---

## Files Modified

| File | Modified | Notes |
|------|----------|-------|
| index.html | ✅ Yes | Bugs 1, 2, 3 |
| watcher.js | ✅ Yes | Bugs 4, 5 |
| mixelparse-watcher.js | No | Unchanged |
| admin.html | No | Unchanged |
| setup.html | No | Unchanged |
| main.js | No | Unchanged |
| preload.js | No | Unchanged |

---

## Open Bugs (carried forward)
- None known. All 5 reported bugs addressed.

---

## Roadmap

### MixelParse.exe
- SignPath.io code signing setup
- UI Copy Tool — reads `UI_<CharName>_P1999Green.ini` files, copy source UI to target character
- Companion app onboarding / full app explanation screen

### Web / Core Features
- Weapon stats for stat calc (damage, ratio, proc, MH/OH for melee/hybrid scoring)
- Quest item flagging (P99 wiki crawl for quest ingredients)
- Mobile-friendly responsive layout pass
- PigParse / custom timers with SMS notification
- Discord webhook integration for timers
- Stat weight profiles: Raider vs. Solo presets
- Best in Slot vs. Realistic toggle (per-slot or global)

---

## Standing Rules (never skip)
- **Never guess EQ mechanics, item stats, proc values, or game data** — always confirm with Alex first
- Always run JS validation after edits
- Use `data-*` attributes for apostrophes in item/boss names in inline `onclick` handlers
- Never put `</script>` inside a JS string literal — use string concatenation
- `str_replace` fails on strings with apostrophes — use Python heredoc scripts
- Always `web_fetch` P99 wiki before writing quest steps or game data
- **Both watcher files must stay in sync** — changes to `watcher/mixelparse-watcher.js` must be ported to `electron/ipc/watcher.js`
- **`_NOTES_BOSS_LIST` in index.html must stay in sync** with `NOTES_BOSS_LIST` in `mixelparse-watcher.js`
- Session begins with zip upload; ends with updated files + new handoff doc
