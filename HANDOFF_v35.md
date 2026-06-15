# MixelParse Handoff — v35

## Session Summary
This session resolved the UI Copy Tool end to end. The v34 "button unclickable" bug was misdiagnosed — the button always worked; the modal was held shut by a leftover inline `display:none` that overrode the `.open` class. With that fixed, the tool's IPC handlers were wired into the **real** `electron/` files (root `main.js`/`preload.js` are dead decoys — the app loads `electron/main.js` per `package.json` `"main"`). The copy destination was moved out of the EQ directory (which sits under `Program Files` and blocks non-elevated writes → `EPERM`) into `Documents\MixelParse\UIs\`, with an "Open Folder" reveal so the user drags the file(s) into EQ themselves. Finally, the tool was extended to copy **both** per-character files: the `UI_<Char>` layout file **and** the `<Char>_P1999Green.ini` character-settings file that holds the friends list, hotbuttons, socials, and combat abilities.

---

## Files Changed This Session

| File | Location | Changes |
|------|----------|---------|
| `index.html` | `src/` | Removed inline `display:none` on `#uiCopyOverlay` (the real "button" bug); removed all `[UI Copy]`/`[diag]` debug logging; `uiCopyRefreshBase()` handles new `{ui,char}` shape and shows char-file status; Set as Base + Copy UI messages reflect dual-file copy; added hidden "Open Folder" button + reveal handler; Open-folder button reset on modal open |
| `main.js` | `electron/` | `BASE_CHAR_PATH` constant; `ui:set-base` + `ui:set-base-from-path` now also capture sibling `<Char>_P1999Green.ini` (clears stale char base if absent); `ui:has-base` returns `{ui,char}`; `ui:copy-from-base` writes to `Documents\MixelParse\UIs\`, copies both files, returns `{dst,dir,files,includedChar}`; new `ui:reveal` handler (`shell.showItemInFolder`) |
| `preload.js` | `electron/` | Exposed `revealPath`; bridge version → `v35-uicopy3` |

> **Placement reminder:** `main.js` → `electron/`, `preload.js` → `electron/`, `index.html` → `src/`. Root-level `main.js`/`preload.js` are decoys the app does **not** load.

---

## The v34 "Unclickable Button" — Root Cause

The button was never broken. `#uiCopyOverlay` carried an inline `style="display:none"`, which always beats a stylesheet rule (`.wl-modal-overlay.open{display:flex}`) regardless of specificity. The v34 fix correctly switched the JS to `classList.add('open')`, but the inline attribute silently neutralized it — the class was added, computed `display` stayed `none`. From the outside this looked exactly like "clicks don't register." Verified with Playwright: after a real mouse click, `hasOpenClass:true` but `computedDisplay:"none"`. Removing the inline style fixed it (`computedDisplay:"flex"`, visible).

Lesson logged: programmatic `.click()` "working" while mouse clicks "didn't" was a red herring — both fired the handler; only the visible result differed.

---

## Features Added / Reworked

### 1. UI Copy Tool — fully working
- **Set base** from a roster character (dropdown) or any picked `UI_*.ini` (Browse).
- Base stored in `userData`: `baseUI.ini` (layout) + `baseChar.ini` (character settings), independent of EQ dir.
- **Copy** writes both files for the new character into `Documents\MixelParse\UIs\`, then **Open Folder** reveals them in Explorer for a manual drag into the EQ folder.

### 2. EPERM avoidance (Program Files writes)
- User's P99 install is under `C:\Program Files (x86)\Sony\EverQuest` — Windows blocks non-elevated writes there. Running elevated is not viable (crashes the game client via privilege mismatch).
- Fix: never write into the EQ dir. Write to `Documents\MixelParse\UIs\` (always writable), user drags over — a single normal UAC paste prompt, no elevated app.

### 3. Friends list / character settings included
- Friends list, ignore list, hotbuttons, socials, and combat abilities live in `<Char>_P1999Green.ini` — **not** the `UI_` file. (Verified via P99/EQ docs, per standing rule.)
- Both files now travel together. Base label distinguishes "UI + character settings" vs "UI only."
- **Class caveat (by design):** the character file carries class-specific hotbuttons/abilities. Current approach is a deliberate baseline-then-expand: copy a standard layout + friends list, refine each toon in-game afterward. Stale char base auto-clears when switching to a UI-only source so one toon's settings never ship onto another.

---

## Bugs Fixed
1. **UI Copy Tool modal wouldn't open** — leftover inline `display:none` on `#uiCopyOverlay` overrode `.open`. Removed. (This was the v34 "unclickable button.")
2. **UI Copy handlers in wrong file** — edits were going into root `main.js`/`preload.js`; app loads `electron/`. Rewired into the real files. Added `bridgeVersion` stamp to detect stale preloads at a glance.
3. **EPERM on copy** — destination moved out of Program Files into Documents.
4. **Friends list not copied** — added the `<Char>_P1999Green.ini` file to the copy.

---

## Known Bugs (carry forward)
- **`watchList is not defined` IPC error** — `renderWatchlistBar` called before `watchList` initialized. Unrelated to this session; still open.

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
| 11 | UI Copy Tool | ✅ Done (v35) — base set, dual-file copy, Documents output + reveal |
| 12 | Code signing (paid EV cert) | Open |
| 13 | Net Worth calculation | Open |
| 14 | **Bankers tab** | Open (newly scoped — see below) |

---

## Bankers Tab — Scoped This Session (not yet built)
- Banker toons are **inventory-only entities**, not roster characters.
- A Bankers tab lists each banker as **toon name + its watched inventory file**; the watcher refreshes that file like any other inventory, and bankers stay in **ALL INVENTORIES search**.
- Bankers are deliberately excluded from **all** per-character systems: gear, level, quests, factions, raid consumes, etc.
- Plan is to **migrate the two current bankers (Mixelvault, Mixelbank)** out of the roster into banker-only treatment. Bankers identified by name.
- Build = new banker registry + tab the watcher reads from, plus migration of the existing two.
- Open build-time questions: where the registry lives (Supabase column vs. flag in existing char data), and how migration carries existing Mixelvault/Mixelbank inventory data over without re-upload.

---

## Standing Rules (carry forward)
- Never guess EQ game mechanics or item stats — always ask or wiki-verify first.
- Python heredoc scripts required for string replacements involving apostrophes.
- JS syntax must be validated with `node --check` after every edit.
- Updated files plus a new versioned handoff doc delivered at session end.
- Never package zips or write handoff docs until explicitly told to do so.
- Always present working files for testing first.
- Scoring logic changes in `index.html` must also be applied to the parallel implementation in `admin.html`.
- `window.MixelParseApp` — not `window.electronAPI` — is the preload bridge name.
- **App structure / file placement:** entry point is `electron/main.js` (per `package.json` `"main"`). Electron process files (`main.js`, `preload.js`) live in `electron/`; HTML (`index.html`, `admin.html`, `setup.html`) lives in `src/`; watcher in `electron/ipc/watcher.js`. **Root `main.js`/`preload.js` are dead decoys.** Always state destination folders explicitly when delivering files.
