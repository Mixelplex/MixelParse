# MixelParse Handoff — v40

**Session version shipped: 1.0.12**
**Next build must be: 1.0.13**

---

## Files Changed This Session

| File | Destination |
|------|------------|
| `index.html` | `src/` |
| `main.js` | `electron/` |
| `watcher.js` | `electron/ipc/` |
| `package.json` | repo root |

---

## Fixes Shipped

### 1. Desktop shortcut showing default Electron icon
**Root cause:** `package.json` build section was missing the top-level `"icon"` key. `nsis.installerIcon` only controls the installer dialog icon — the key that tells electron-builder what to embed into the `.exe` binary is `build.icon`. Without it, electron-builder falls back to `build/icon.ico` (which doesn't exist), and the exe gets the default Electron feather.

**Fix:** Added `"icon": "assets/icon.ico"` to the `build` section of `package.json`.

**Note:** If desktop shortcut still shows old icon after a clean reinstall, run:
```cmd
taskkill /f /im explorer.exe
del /f /s /q "%localappdata%\IconCache.db"
del /f /s /q "%localappdata%\Microsoft\Windows\Explorer\iconcache*"
start explorer.exe
```

---

### 2. Update splash showing current version instead of incoming version
**Root cause:** `update-available` and `update-downloaded` events in `main.js` were declared as `() => {}` — they ignored the `info` argument from electron-updater which contains `info.version`. The renderer then called `getVersion()` which returns the *currently installed* version. So it always showed what you had, not what was downloading.

**Fix:**
- `main.js`: both event handlers now capture `(info)` and forward `{ type, version: info.version }`
- `index.html` event handler: passes `ev` into `openUpdateSplash` so version travels with it
- `index.html` `openUpdateSplash`: uses `data.version` directly; `getVersion()` kept only as dead fallback

---

### 3. DKP History tab empty for all users except the uploader
**Root cause:** `loadDkpFromSupabase()` filtered by `.eq('user_id', currentUser.id)`. DKP data is saved to the uploader's (Alex's) `guild_data` row. Other users query their own row, find nothing, get a blank panel.

**Fix:** Removed `user_id` filter from the load query. Now loads from any `guild_data` row with `pool='SoV'` that has `dkp_lookup` data, ordered by `updated_at DESC`. Save path unchanged — still writes to the current user's row.

---

### 4. First `/note <boss>` never fired — all subsequent notes worked
**Root cause (attempted fix 1 — failed):** `_handleNotesUpdate` had baseline logic: first call sets line count and returns without processing. Intended to skip old notes on reconnect. But since the watcher only sent `notesUpdate` on file *changes* (never on startup), the first real note triggered the baseline → was eaten.

**Attempted fix:** Send `notesBaseline` at watcher startup to pre-set the baseline before the first real note. **Failed** due to race condition — `notesBaseline` was broadcast before the renderer's IPC listener was registered, so it was dropped silently.

**Actual fix:** Replaced full-file-read approach in `watcher.js` with **tail-read / byte-position tracking** (same pattern as `mixelparse-watcher.js`):
- At `startNotesWatcher()` startup, `_notesPos` is set to the current end-of-file byte position
- On each `change` event, only bytes written *after* `_notesPos` are read and sent
- `notesUpdate` now contains only new content — renderer never needs baseline logic
- Baseline state vars (`_lastNotesLineCount`, `_notesBaselineSet`) kept in `index.html` as dead no-ops for safety

**Also fixed:** The str_replace that rewrote `_handleNotesUpdate` left the old function body as orphaned code after the closing brace — causing a JS syntax error that broke the entire page (login failure). Removed the orphaned block.

---

### 5. Silent background updates when renderer is broken
**Context:** The syntax error in fix #4 shipped briefly as 1.0.11, breaking login for users on that version. They couldn't use the app to trigger the update modal.

**Fix:** Added explicit `autoUpdater.autoDownload = true` and `autoUpdater.autoInstallOnAppQuit = true` to `main.js`. Both were already the default, but are now explicit. Even with a completely broken renderer, the main process downloads the update silently and installs it the moment the user quits and relaunches.

**Recovery for users on broken version:** Tell them to quit the app and relaunch — no login or modal interaction needed.

---

## Standing Rules (unchanged)

- Always run `node --check` after every `.js` edit
- **NEW: Also verify `index.html` edits don't leave orphaned code** — str_replace on large functions can silently leave the old body behind if the match boundary doesn't cover the full function
- Keep `admin.html` scoring logic in sync with `index.html`
- Keep `watcher.js` and `mixelparse-watcher.js` in sync for watcher changes
- `_NOTES_BOSS_LIST` in `index.html` must stay in sync with `NOTES_BOSS_LIST` in `mixelparse-watcher.js`
- IPC bridge is `window.MixelParseApp`
- Always work from the previous output file, never re-extract session zip mid-session
- File placement: `index.html` → `src/`, `main.js` → `electron/`, `watcher.js` → `electron/ipc/`, `package.json` → repo root
- `getMyChars()` must filter to inventory-file-based character list only
- Next build version: **1.0.13**
