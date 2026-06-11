# MixelParse Handoff — v29

## Session Summary
Two major workstreams this session:
1. Watchlist badge column fix (carried from v28)
2. MixelParse.exe — Electron app scaffold built, repo restructured into single source of truth

---

## Part 1 — Watchlist Badge Fix (index.html)

**Root cause:** `renderWatchlistBar()` used `grid-template-columns:220px 1fr` for single-char rows. The `1fr` column gave all remaining horizontal space to the badge cell, so the `inline-flex` span with its tinted background stretched edge-to-edge, producing full-width red/green row stripes.

**Fix:** Changed `1fr` → `auto` so the badge column hugs its content.

```js
// Before
return`<div style="display:grid;grid-template-columns:220px 1fr;...">
// After
return`<div style="display:grid;grid-template-columns:220px auto;...">
```

---

## Part 2 — MixelParse.exe Electron App

### Decisions Made
- **Framework:** Electron (bundles Chromium + Node.js, reuses existing HTML/JS with zero rewrite)
- **IPC:** Electron IPC replaces WebSocket — `window.MixelParseApp` API exposed via `preload.js`
- **Backend:** Supabase kept as-is
- **Distribution:** NSIS installer (not portable) — required for auto-updater to work
- **Auto-updater:** `electron-updater` + GitHub Releases
- **Code signing:** SignPath.io free tier (open source) + GitHub Actions build pipeline
- **Tray:** App minimizes to system tray, watcher keeps running in background while playing EQ
- **Windows:** Main window (`index.html`), separate Admin window (`admin.html`), first-run Setup screen (`setup.html`)

### EQ Path Auto-Detection
| Field | Auto-detected value |
|---|---|
| EQ Directory | `C:\Program Files (x86)\Sony\EverQuest` |
| Log Directory | `C:\Program Files (x86)\Sony\EverQuest\Logs` |
| Notes File | `C:\Program Files (x86)\Sony\EverQuest\notes.txt` |

Config saved to `%APPDATA%\MixelParse\config.json` — survives updates.

### App Icon
Two candidate icons were created (AI-generated). The selected icon is the second one: large **M emblem with blue crystal**, MIXELPARSE text, EQ P99 subtitle, dark stone background with compass rose. Reads well at small tray/taskbar sizes. Needs to be converted to `.ico` and placed at `assets/icon.ico`.

---

## Part 3 — Repo Structure (Single Source of Truth)

### GitHub Repo: `mixelplex/MixelParse` (public)

```
MixelParse/
├── src/
│   ├── index.html          ← THE source for both web + Electron
│   ├── admin.html          ← THE source for both web + Electron
│   └── setup.html          ← Electron first-run setup screen only
├── watcher/
│   └── mixelparse-watcher.js   ← standalone Node.js watcher (WebSocket mode)
├── electron/
│   ├── main.js             ← Electron main process
│   ├── preload.js          ← context bridge / IPC API
│   └── ipc/
│       └── watcher.js      ← watcher ported to IPC mode (no WebSocket)
├── assets/
│   └── icon.ico            ← app icon (MUST be placed here before building)
├── docs/                   ← GitHub Pages serving directory (AUTO-POPULATED BY CI)
│   ├── index.html          ← copied from src/ automatically — DO NOT EDIT DIRECTLY
│   └── admin.html          ← copied from src/ automatically — DO NOT EDIT DIRECTLY
├── .github/workflows/
│   ├── pages.yml           ← auto-deploys src/ → docs/ on push to main
│   └── release.yml         ← builds MixelParse.exe installer on version tag push
└── package.json            ← electron-builder config, main entry: electron/main.js
```

### Local Clone Location
`C:\Users\Owner\Desktop\MixelParse-Source\MixelParse\`

### GitHub Pages Setup
- Source must be set to: **main branch, /docs folder**
- Verify at: repo → Settings → Pages
- `docs/` is never edited manually — always auto-populated by `pages.yml` CI

---

## ⚠️ CRITICAL: How to Update Files Going Forward

**NEVER edit files in `docs/` directly. NEVER edit `index.html` or `admin.html` anywhere except `src/`.**

### Workflow for every change:

#### Web + Electron changes (index.html, admin.html)
1. Edit `src/index.html` or `src/admin.html` in `MixelParse-Source\MixelParse\src\`
2. Commit + Push in GitHub Desktop
3. `pages.yml` automatically copies to `docs/` and deploys the website
4. Electron build picks up from `src/` — no extra step needed

#### Electron-only changes (main.js, preload.js, setup.html, ipc/watcher.js)
1. Edit the file in its location (`electron/` or `src/setup.html`)
2. Commit + Push in GitHub Desktop
3. No website impact — Electron only

#### Watcher standalone changes (mixelparse-watcher.js)
1. Edit `watcher/mixelparse-watcher.js`
2. **Also port the same logic change to `electron/ipc/watcher.js`** — these two must stay in sync
3. Commit + Push

#### Releasing a new .exe
1. In GitHub Desktop: Repository → Create tag → name it `v1.x.x`
2. Push the tag
3. `release.yml` builds and publishes the installer to GitHub Releases automatically
4. Auto-updater in existing installs picks it up within ~3 seconds of launch

### Claude session workflow (unchanged)
- Session begins with zip upload of current files
- All edits made to files in session
- Session ends with: updated zip + new HANDOFF doc
- After session: replace files in `MixelParse-Source\MixelParse\src\` with new versions, commit + push via GitHub Desktop

---

## Part 4 — Electron App: What's Built vs What's Pending

### Built ✅
- `electron/main.js` — window management, tray, IPC handlers, auto-updater, watcher integration
- `electron/preload.js` — full `window.MixelParseApp` API bridge
- `electron/ipc/watcher.js` — watcher logic in IPC mode (inventory, log tailing, notes, faction, zone)
- `src/setup.html` — first-run setup screen with auto-detect, browse buttons, config save
- `package.json` — electron-builder config, NSIS installer, GitHub publish
- `.github/workflows/release.yml` — CI build + publish pipeline
- `.github/workflows/pages.yml` — web deploy pipeline
- Tray fault-tolerance — missing `icon.ico` uses empty fallback instead of crashing

### Pending ⏳ (next session picks up here)
1. **IPC bridge in `index.html`** — swap WebSocket listener for `window.MixelParseApp.onWatcherEvent()` when `window.MixelParseApp.isElectron === true`. Branch condition already in preload. This is the next task.
2. **Admin window open button** — wire existing admin button in `index.html` to call `window.MixelParseApp.openAdmin()`
3. **`icon.ico`** — convert PNG to ICO, place at `assets/icon.ico`
4. **Test full app launch** — setup screen → config save → main window → tray behavior
5. **SignPath.io** — apply for free open source signing (repo is public ✅)

---

## File State

| File | Location | Notes |
|------|----------|-------|
| index.html | `src/index.html` | v28 watchlist fix applied |
| admin.html | `src/admin.html` | Unchanged |
| setup.html | `src/setup.html` | New — Electron first-run screen |
| main.js | `electron/main.js` | New — tray fault-tolerant |
| preload.js | `electron/preload.js` | New |
| ipc/watcher.js | `electron/ipc/watcher.js` | New — IPC mode watcher |
| mixelparse-watcher.js | `watcher/mixelparse-watcher.js` | Unchanged — standalone WS mode |
| package.json | repo root | Updated for new structure |

---

## Open Bugs (carried forward)
- Watcher `getMyChars()` scope issue — may still only scan Mixelplex's log in some configurations

## Roadmap

### MixelParse.exe
- IPC bridge in index.html (next session — immediate priority)
- Admin window wiring
- icon.ico placement
- Full launch test
- SignPath.io code signing setup
- UI Copy Tool — reads `UI_<CharName>_P1999Green.ini` files, copy source UI to target character
- Companion app onboarding / full app explanation screen

### Web / Core Features
- Weapon stats for stat calc (damage, ratio, proc, MH/OH for melee/hybrid scoring)
- Quest item flagging (P99 wiki crawl for quest ingredients)
- Mobile-friendly responsive layout pass
- PigParse / custom timers with SMS notification
- Custom timers with SMS notification
- Discord webhook integration for timers
- Stat weight profiles: Raider vs. Solo presets
- Best in Slot vs. Realistic toggle (per-slot or global)
- Zone tracking via EQ log (`You have entered [Zone]`)

---

## Standing Rules (never skip)

- **Never guess EQ mechanics, item stats, proc values, or game data** — always confirm with Alex first
- Always run JS validation after edits
- Use `data-*` attributes for apostrophes in item/boss names in inline `onclick` handlers
- Never put `</script>` inside a JS string literal — use string concatenation
- `str_replace` fails on strings with apostrophes — use Python heredoc scripts
- Always `web_fetch` P99 wiki before writing quest steps or game data
- **Never edit `docs/` directly** — always edit `src/`, CI handles the rest
- **Both watcher files must stay in sync** — changes to `watcher/mixelparse-watcher.js` must be ported to `electron/ipc/watcher.js`
- Session begins with zip upload; ends with updated files + new handoff doc
