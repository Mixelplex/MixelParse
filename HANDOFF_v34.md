# MixelParse Handoff — v34

## Session Summary
This session focused on three areas: (1) full implementation of con-based faction auto-detection via EQ log parsing, (2) UI Copy Tool (base UI template system), and (3) zone bar aesthetic improvements. The con faction system was previously a dead stub — it is now fully functional with a 200+ mob `CON_TARGET_MAP` sourced from the P99 wiki.

---

## Files Changed This Session

| File | Location | Changes |
|------|----------|---------| 
| `index.html` | `src/` | UI Copy Tool button + modal, zone bar CSS rework (Option B layout), button reorder in header, `window.electronAPI` → `window.MixelParseApp` fix, console debug logging on uiCopyBtn (remove before release) |
| `watcher.js` | `electron/ipc/` | Full con-based faction detection: `RE_CON`, `CON_TARGET_MAP` (200+ mobs), `CON_WORD_TO_LEVEL`, replaces dead stub with real broadcast logic |
| `mixelparse-watcher.js` | `watcher/` | Same RE_CON, CON_TARGET_MAP, CON_WORD_TO_LEVEL updates as watcher.js |
| `main.js` | root | `BASE_UI_PATH` + 4 new IPC handlers: `ui:set-base`, `ui:has-base`, `ui:copy-from-base`, `ui:browse-ini`, `ui:set-base-from-path`. Also `openDevTools()` added temporarily — **remove before release** |
| `preload.js` | root | Exposed 5 new `MixelParseApp` methods: `setBaseUI`, `hasBaseUI`, `copyFromBaseUI`, `browseIniFile`, `setBaseUIFromPath` |

---

## Features Added

### 1. Con-based faction auto-detection
- **How it works:** Watcher tails EQ log files, matches con messages via `RE_CON`, looks up NPC name in `CON_TARGET_MAP`, snaps faction value to `LEVEL_MIDPOINTS[levelName]`, saves state, broadcasts `factionUpdate` WebSocket event
- **RE_CON covers:** `regards you`, `considers you`, `judges you`, `glares at you` — with optional `as an` prefix and all con word variants (with/without `ly` suffix)
- **Con words:** ally, warmly, kindly, amiable/amiably, indifferent/indifferently, apprehensive/apprehensively, dubious/dubiously, threatening/threateningly, scowls (→ Ready to Attack)
- **CON_TARGET_MAP:** 200+ mobs across CoV, Kromzek, Kromrif, Coldain, Kael Drakkel, Thurgadin, Storm Guards, Emerald Warriors, Brood of Di'Zok, Sarnak Collective, Ring of Scale, and others. Sourced directly from P99 wiki faction pages
- **Log line in watcher:** `[CON] Mixelmedic → Claws of Veeshan: Ally (1500)`

### 2. UI Copy Tool
- **Button:** Header top-right, above Gear Planner Reports
- **Flow:** Set a base UI from any character's `UI_<Char>_P1999Green.ini` file (via dropdown or Browse file picker), then copy to any new character name
- **Base storage:** `app.getPath('userData')/baseUI.ini` — persists independently of EQ directory
- **Update base:** Re-select any character + click "Set as Base" to overwrite
- **IPC chain:** `ui:browse-ini` → native file dialog → `ui:set-base-from-path` → copies to `baseUI.ini`. `ui:copy-from-base` → copies `baseUI.ini` to `UI_<Dest>_P1999Green.ini` in EQ dir
- **Known issue:** UI Copy Tool button doesn't respond to mouse clicks in Electron despite element being found and `dispatchEvent` working. `window.addEventListener('click')` capture shows click never reaches JS. Cause unknown — not drag region, not z-index overlap, not pointer-events. Needs further investigation

---

## Bugs Fixed

### 1. Tray icon missing
- Renamed path expectation: `main.js` looks for `assets/icon.ico`. Either rename `MixelParseICON.ico` → `icon.ico` or update the 5 references in `main.js`. Use a PNG-to-ICO converter (png2ico.com recommended, select all sizes 16–256px for proper Windows rendering)

### 2. `window.electronAPI` → `window.MixelParseApp`
- UI Copy Tool JS was calling `window.electronAPI.*` but preload exposes as `window.MixelParseApp`. Fixed all 10 occurrences in `index.html`

### 3. UI Copy Tool modal wouldn't open
- Used `style.display = 'flex'` instead of `.classList.add('open')` — the `.wl-modal-overlay` CSS requires the `.open` class. Fixed

---

## Known Bugs (carry forward)

- **UI Copy Tool button unclickable** — mouse clicks don't reach the JS event listener despite element being present and programmatic `.click()` working. `window.addEventListener('click', e, true)` capture shows zero events from mouse clicks in Electron. Debug logging (`[UI Copy] button clicked`) added — remove before release along with `openDevTools()`
- **`watchList is not defined` IPC error** — `renderWatchlistBar` called before `watchList` initialized. Separate from this session's work, carry forward

---

## CON_TARGET_MAP Notable Additions This Session
- Full CoV "lower faction" mob list from wiki (152 new entries): all Skyshrine Fe`Dhar NPCs, all ToV named, all Western Wastes named, all Cobalt Scar named
- `a glimmering drake`, `a wyvern huntress`, `a fiery temple guardian`, `a fiery watcher`
- `esorpa of the ring` → Ring of Scale
- `korakaz`, `priest grenk`, `a storm giant escort` → Kromzek
- `an off duty slavemaster`, `a di\`zok underling` → Brood of Di'Zok

---

## Roadmap (current)

| # | Item | Status |
|---|------|--------|
| 1 | EQ log reader — auto-update faction info | ✅ Done (v34) |
| 2 | Weapon stats for stat calc | Open |
| 3 | Quest item flagging | Open |
| 4 | Mobile-friendly version | Open |
| 5 | PigParse timer integration with SMS | Open |
| 6 | Custom timers with SMS | Open |
| 7 | Discord integration for timers | Open |
| 8 | Stat weight profiles — Raider vs. Solo | Open |
| 9 | Best in Slot vs. Realistic toggle | Open |
| 10 | Companion app (MixelParse.exe) | Open |
| 11 | UI Copy Tool | ⚠️ Built, button click bug |
| 12 | Code signing (paid EV cert) | Open |
| 13 | Net Worth calculation | Open |

---

## Standing Rules (carry forward)
- Never guess EQ game mechanics or item stats — always ask or wiki-verify first
- Python heredoc scripts required for string replacements involving apostrophes
- JS syntax must be validated with `node --check` after every edit
- All three files plus a new versioned handoff doc delivered at session end
- Never package zips or write handoff docs until explicitly told to do so
- Always present working file for testing first
- Scoring logic changes in `index.html` must also be applied to parallel implementation in `admin.html`
- `window.MixelParseApp` — not `window.electronAPI` — is the preload bridge name
