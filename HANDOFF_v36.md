# MixelParse Handoff v36

## File Sizes
- `index.html` — 7,587 lines → `src/`
- `admin.html` — 3,172 lines → `src/`
- `mixelparse-watcher.js` — 1,532 lines → (standalone watcher root)
- `main.js`, `preload.js`, `watcher.js` — **unchanged this session**

## Supabase Migration Required (if not already run)
```sql
ALTER TABLE guild_data ADD COLUMN IF NOT EXISTS banker_registry jsonb;
```

---

## What Was Built This Session

### 1. Bankers Tab (complete, working, one known UX bug pending)
**Purpose**: Separate "inventory-only" toons (Mixelvault, Mixelbank) from the main character roster entirely.

**Core mechanic — `charNames()` now excludes bankers**:
- New `isBanker(cn)` helper checks `bankerRegistry[]` (case-insensitive)
- `charNames()` filters out bankers → they're automatically absent from: character tabs, gear/stats/upgrades, factions, skyshrine, quests, raid consumes, watchlist character checkboxes, DKP credit check
- `bankerNames()` for the registry list
- `saveToSupabase` row-building uses `Object.keys(chars)` (not `charNames()`) so banker inventory still syncs to their existing `characters` Supabase rows

**On first load**: `migrateLegacyBankers()` checks if registry is empty AND Mixelvault/Mixelbank are already in `chars` — if so, seeds the registry automatically, saves to Supabase. One-time migration.

**Bankers tab UI**:
- "📁 Add Banker…" button → native OS file picker → must be a `<Name>-Inventory.txt` (validated, rejects anything else with an alert)
- Drag & drop onto the Bankers panel also works (gold dashed outline while dragging)
- Pill list of registered bankers (styled like character tabs), each with ✕ to remove (toon returns to roster, inventory data kept)
- "Characters X / Bankers X" now shown in the All Characters Combined stats bar

**Persistence**: `banker_registry` jsonb column in `guild_data`. `saveBankerRegistryToSupabase()` gates on `currentUser` (fixed — was using `window.currentUser` which is always falsy).

**admin.html**: `gcBuildCharBtns` now skips bankers via `A.isBanker(name)`. `charNames`/`isBanker`/`bankerNames` exposed via `window.opener`.

**Pending UX bug**: Once a toon is wrongly added via a non-`-Inventory.txt` file (e.g. the eqlog case from this session), removing them via ✕ brings them back as a regular character tab with junk inventory. User needs to then ✕ that character tab too to fully clean up. No code fix yet — just a known flow.

---

### 2. `/note standard` / `/note hourly` → Hourly Tick (complete, pending test confirmation)

**`mixelparse-watcher.js`**:
- Added `NOTES_TICK_MAP` (alongside `NOTES_BOSS_LIST`):
  - Standard: aliases `standard`, `hourly`, `std`
  - NToV/Sky/VP: aliases `ntov`, `sky`, `vp`
  - Training Events: aliases `training`, `train`
- Added `fuzzyMatchTick(text)` — same word-boundary regex logic as `fuzzyMatchBoss`
- `processNotesLines()` now: try boss match first, if no match try tick match → broadcasts `{type:'todTick', desc, value, noteText, timestamp}`

**`index.html`**:
- `_NOTES_TICK_MAP` mirrors the watcher map (Electron IPC raw-notes path)
- `_handleNotesUpdate` now falls through to `_NOTES_TICK_MAP` check after boss matching fails
- Both WS and Electron IPC paths handle `type:'todTick'` → call `todTickHandle(desc, value)`
- `todTickHandle()`:
  - If `activeSession` is null: creates one via `newSession()`
  - "No session in progress" = `!raidSessions.includes(activeSession)` — catches the lazy-init empty draft that `renderKillsPanel()` creates (never null in practice)
  - If new: pushes into `raidSessions` immediately, saves to Supabase
  - Calls `window.ktHourlyAdj(desc, value, 1)` to increment the tick counter
  - Saves to Supabase every tick
  - Toast: `⏱ New session — Standard ×1` (new) or `⏱ Standard ×2` (existing)
- **Bonus fix**: `showWatcherToast` was scoped inside the watcher-socket IIFE and not accessible outside it — all boss-kill toasts (todAddToSession / todStartNewSession) were silently throwing `ReferenceError`. Fixed by exposing as `window.showWatcherToast` at the end of the definition.

**Pending test**: Confirm `/note hourly` with no active session creates a new session visible in Session History + persists across refresh.

---

### 3. `saveZonesToSupabase` bug fix
- Was using `if(!window.currentUser)return;` — same `window.currentUser` bug as banker registry save. Zone data was never persisting across reloads.
- Fixed to `if(!currentUser)return;`
- Worth testing: zone bar should now survive a refresh.

---

## Pending / Known Issues (carry forward)
1. `watchList is not defined` IPC error in `renderWatchlistBar` — carried from v35, untouched
2. `/note hourly` session creation — pending test confirmation (believed fixed but not verified in-game yet)
3. Zone bar persistence — believed fixed (same `window.currentUser` bug) but not explicitly re-tested
4. Banker drag-and-drop of wrong file type (e.g. eqlog) leaves a junk character tab that requires a second manual ✕

## Standing Rules (unchanged)
- Never guess EQ mechanics, item stats, proc values, or formulas — always ask or wiki-verify first
- Python heredoc scripts preferred over `str_replace` for replacements involving apostrophes or complex JS
- Run JS syntax validation (`node --check`) after every edit before delivery
- Never package zip or write handoff doc until explicitly told to do so
- `admin.html` has parallel scoring logic — any scoring/stat weight change in `index.html` must also be applied to `admin.html`
- Log watcher only scans characters whose inventory files exist in MixelParse (`getMyChars()` drives this filter)

## File Placement Map
```
index.html              → src/
admin.html              → src/
mixelparse-watcher.js   → (watcher root, not src/ or electron/)
main.js                 → electron/   (UNCHANGED)
preload.js              → electron/   (UNCHANGED)
watcher.js              → (root)      (UNCHANGED)
setup.html              → src/        (UNCHANGED)
```
