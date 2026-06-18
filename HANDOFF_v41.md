# MixelParse Handoff — v41

**Session version shipped: 1.0.18**
**Next build must be: 1.0.19**

---

## Files Changed This Session

| File | Destination |
|------|------------|
| `index.html` | `src/` |
| `watcher.js` | `electron/ipc/` |
| `package.json` | repo root |

---

## Fixes Shipped

### 1. `/note <boss>` cascading into dozens of TOD modals

**Root cause:** Two bugs stacked. The v40 session correctly removed the baseline-skip logic from `_handleNotesUpdate` (it was eating the first note), but the corresponding `watcher.js` tail-read fix described in the v40 handoff was never actually applied to the file. This left `_handleNotesUpdate` with no protection against the full-file-read that `watcher.js` was still doing.

On every `/note` command, the watcher sent the entire `notes.txt` content. `_handleNotesUpdate` processed every line in the file — any line containing a boss alias (including dozens of entries from prior raids) triggered a `todEnqueue`. Dozens of "⚔ KILL DETECTED" modals stacked up.

**Contributing factor:** `watcher.js` was being placed in the wrong directory (repo root instead of `electron/ipc/`) for several build cycles, so fixes weren't taking effect.

**Fix — `watcher.js`:**
- Replaced chokidar notes watcher with `setInterval` mtime polling at 500ms (chokidar unreliable in Electron main process on Windows; consistent with how inventory and log watchers already work)
- Added byte-position tail-read (`_notesPos`) so `notesUpdate` only ever contains bytes written since the last poll — never the full file
- Added `notesBaseline` broadcast to `sendFullSnapshot()`: on `requestAll` (fired by renderer after IPC listener is registered), reads the full `notes.txt` and sends it as `notesBaseline` so the renderer can mark all existing lines as already-seen before any `notesUpdate` fires. This resolves the timing race that caused `notesBaseline` to be dropped silently in v40.
- Notes poll is 500ms (not 2s like inventory/log) because TOD detection is time-sensitive — respawn timers start from the moment of death.

**Fix — `index.html`:**
- Replaced dead `_notesBaselineSet` no-op with a `_seenNoteLines` Set
- `_handleNotesUpdate` skips any line already in `_seenNoteLines` and adds each processed line to it — belt-and-suspenders against the full-file-read case
- `isBaseline` path now correctly populates `_seenNoteLines` from the baseline content and returns without processing, instead of being a no-op
- `_lastNotesLineCount` and `_notesBaselineSet` kept as dead vars (do not remove)

**Full flow (post-fix):**
1. Renderer registers IPC listener → calls `requestWatcherAll()`
2. `sendFullSnapshot()` reads `notes.txt`, sends `notesBaseline` with full content
3. `_handleNotesUpdate(text, ts, true)` → all existing lines added to `_seenNoteLines`, nothing processed
4. User types `/note Severilous` → watcher detects mtime change within 500ms → reads only new bytes → sends `notesUpdate`
5. `_handleNotesUpdate` checks `_seenNoteLines` → new line not present → processes → one `todEnqueue` → one modal

---

## Standing Rules (unchanged)

- Always run `node --check` after every `.js` edit
- Verify `index.html` edits don't leave orphaned code after str_replace on large functions
- Keep `admin.html` scoring logic in sync with `index.html`
- Keep `watcher.js` and `mixelparse-watcher.js` in sync for watcher changes
- `_NOTES_BOSS_LIST` in `index.html` must stay in sync with `NOTES_BOSS_LIST` in `mixelparse-watcher.js`
- IPC bridge is `window.MixelParseApp`
- Always work from the previous output file, never re-extract session zip mid-session
- **File placement: `index.html` → `src/`, `main.js` → `electron/`, `watcher.js` → `electron/ipc/`, `package.json` → repo root**
- `getMyChars()` must filter to inventory-file-based character list only
- Next build version: **1.0.19**
