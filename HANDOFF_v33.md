# MixelParse Handoff — v33

## Session Summary
This session focused on fixing the Electron app's watcher infrastructure, TOD alias system, and several UI bugs. No changes to the web/GitHub Pages version of index.html except the boss list sync.

---

## Files Changed This Session

| File | Location | Changes |
|------|----------|---------|
| `index.html` | `src/` | Watcher badge moved to title block, 2H auto-detect fallback, _NOTES_BOSS_LIST synced, TOD queue rate limiter + Skip All button |
| `watcher.js` | `electron/ipc/` | Full rewrite of inventory/log watchers (chokidar → mtime polling), startup zone scan, sendFullSnapshot timing fix |
| `main.js` | root | `setWindowOpenHandler` for admin popup, `did-finish-load` snapshot replay, `openDevTools` (temporary debug — remove before release) |
| `mixelparse-watcher.js` | `watcher/` | notesSeen persistence removed (in-memory only), file position tracking for notes, `__dirname` path fix, alias additions, startup zone scan |

---

## Bugs Fixed

### 1. Zone bar empty on startup
- **Root cause:** Chokidar `add` events never fired in Electron main process due to `awaitWriteFinish` blocking with large log directory (100+ files)
- **Fix:** Direct `fs.readdirSync` startup scan in `startLogWatcher()` reads last 100KB of each char's log, extracts last "You have entered" line, broadcasts `zoneUpdate`
- **Also fixed:** `main.js` now calls `sendFullSnapshot()` 500ms after `did-finish-load` so zone/inventory/faction state isn't lost to renderer timing race

### 2. Inventory not updating live
- **Root cause:** Chokidar polling completely non-functional in Electron main process on Windows
- **Fix:** Replaced chokidar inventory watcher with `setInterval` mtime polling every 2 seconds. On mtime change, reads file and sends if hash differs
- **Also fixed:** `invCache` was storing content but comparing to hash (always mismatch). Split into `invCache` (hashes) and `invContent` (content for sendFullSnapshot)

### 3. Log watcher not firing (zones/faction not updating live)
- **Root cause:** Same chokidar issue
- **Fix:** Replaced chokidar log watcher with mtime polling every 2 seconds, calls `tailLogFile` on change

### 4. Admin panel broken in Electron ("Not connected")
- **Root cause:** `createAdminWindow()` opens a new `BrowserWindow` with no `window.opener` relationship
- **Fix:** Removed Electron-specific branch from `openAdminPanel()` — now uses `window.open()` for both browser and Electron. Added `setWindowOpenHandler` in `main.js` to allow popups

### 5. Watcher badge wrong location
- **Fix:** Badge now injected into `.header-title-block` below the ✦ ornament instead of `.header-top-bar`

### 6. 2H auto-detect failing for Herbalist's Spade / Meljeldin
- **Root cause:** Items not in local baked DB, so `currentData._skill` was empty
- **Fix:** Added fallback — if skill check fails, checks if equipped PRIMARY item name appears in `all2h` candidates list

### 7. TOD modal freeze on rapid-fire notes
- **Fix:** 150ms rate limiter on `todEnqueue`, added `_todSkipAll()` function, "Skip All" button appears in modal when queue > 1

### 8. TOD /note fright and /note dread not working
- **Root cause:** `_NOTES_BOSS_LIST` in `index.html` was a completely different, outdated list — missing Fright, Dread, and ~30 other bosses
- **Fix:** Fully synced `_NOTES_BOSS_LIST` with `mixelparse-watcher.js` NOTES_BOSS_LIST

### 9. notesSeen persisted across restarts (blocked re-noting same boss)
- **Fix:** Removed `mixelparse-notesseen.json` persistence. `notesSeen` is now in-memory only — resets on each watcher restart
- **Also:** Replaced line-content dedup with file position tracking (`_notesPos`) in `mixelparse-watcher.js`

### 10. mixelparse-watcher.js JSON files saving to wrong location
- **Root cause:** `path.dirname(process.execPath)` pointed to Node.exe directory
- **Fix:** Replaced all 5 occurrences with `__dirname`

### 11. GitHub push blocked by large files
- **Fixed:** Removed `electron-bin.zip` (105MB) and `node_modules/electron/dist/electron.exe` (171MB) from git history using BFG Repo Cleaner. Added `.gitignore` with `node_modules/` and `electron-bin.zip`

---

## Alias Updates (both `mixelparse-watcher.js` and `index.html` `_NOTES_BOSS_LIST`)

| Boss | Added Alias |
|------|-------------|
| King Tormax | `kt` |
| Klandicar | `klandi` |
| Lord Kreizenn | `kreiz` |
| Zlandicar | `zlandi` |
| Wuoshi | `wush` |

---

## Known Bugs (carry forward)

- **Tray icon missing** — `assets/icon.ico` not found. File in repo is `MixelParseICON.ico` — needs rename or path update in `main.js`
- **`openDevTools` left in `main.js`** — remove before production build (line ~115)
- **Mixelmez zone** — no zone line found in last 100KB of log. Will populate next time they zone in-game

---

## Architecture Notes

### Chokidar is broken in Electron main process on Windows
All three file watchers originally used chokidar. In Electron's main process on Windows, chokidar `add`/`change` events never fire regardless of config (`usePolling`, `awaitWriteFinish`, etc.). Solution:
- **Inventory:** `setInterval` mtime polling every 2s
- **Log files:** `setInterval` mtime polling every 2s  
- **Notes file:** chokidar still used (single file, works fine) with hash dedup to prevent duplicate sends

### Two separate boss lists must stay in sync
- `mixelparse-watcher.js` → `NOTES_BOSS_LIST` (used by standalone WebSocket watcher)
- `index.html` → `_NOTES_BOSS_LIST` (used by Electron IPC path)
- Any alias changes must be applied to BOTH

### TOD modal path differs by environment
- **Web/standalone watcher:** `mixelparse-watcher.js` fuzzy-matches in Node, sends `todNote` event
- **Electron:** `watcher.js` sends raw `notesUpdate` with full file text, `_handleNotesUpdate()` in `index.html` does the matching

---

## Open Roadmap (unchanged)
- EQ log reader to automatically update faction info
- Weapon stats for stat calc
- Quest item flagging
- Mobile-friendly version
- PigParse timer integration with SMS notification
- Custom timers with SMS notification
- Discord integration for timers
- Stat weight profiles (Raider vs. Solo)
- Best in Slot vs. Realistic toggle
- Companion app (MixelParse.exe)
- UI Copy Tool
