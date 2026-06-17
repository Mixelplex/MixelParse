# MixelParse — Handoff v39
**Session date:** 2026-06-17
**Version:** 1.0.8

---

## What Was Accomplished This Session

### 1. Auto-Update System (full implementation)

#### Nav bar Update button
- Added **"⟳ Update"** button in the top nav, beside Feedback
- Hidden on web (`display:none`), revealed only in Electron via `initElectronBridge()`
- States: `Checking…` → `⬇ Downloading…` → `↻ Restart to Update` → `✔ Up to Date`
- 15-second hard timeout resets the button if no event ever fires
- Clicking when state is `ready` calls `installUpdate()` directly

#### Update splash modal (multi-state)
- Opens automatically on `update-available` (not just `update-downloaded`)
- **Downloading state:** progress bar with shimmer animation, `X.X / X.X MB · X KB/s`
- **Ready state:** checkmark, "Restart & Update" + "Later" buttons
- **Error state:** red box showing the actual error message from electron-updater, "Try Again" button
- `@keyframes updaterShimmer` added to CSS

#### Tray right-click menu
- Added **"Check for Updates"** item between Admin Panel and the separator

#### IPC additions (`main.js` + `preload.js`)
- `updater:install` → `autoUpdater.quitAndInstall(false, true)` with `app.isQuitting = true` set first (fixes "cannot be closed" NSIS error caused by tray keep-alive blocking shutdown)
- `app:get-version` → `app.getVersion()` (used to populate version badge and splash)
- `download-progress` event forwarded to renderer with `percent`, `transferred`, `total`, `bytesPerSecond`
- `update-not-available` event forwarded as `up-to-date`
- `error` event forwarded with `err.message` (was previously swallowed silently — root cause of stuck "Checking…" button)
- `getVersion`, `installUpdate` exposed on `window.MixelParseApp` in `preload.js`

#### Version badge
- Was hardcoded `v1.0` in HTML
- Now empty on load, filled dynamically from `app.getVersion()` in `initElectronBridge()`

### 2. Icon fix
- `ICON_PATH` constant defined once at top of `main.js`
- In packaged builds: resolves via `process.resourcesPath` (outside asar, real file on disk)
- In dev: resolves via `app.getAppPath()` (repo root)
- `package.json` `extraResources` updated: `{ "from": "assets", "to": "assets" }` — copies `assets/` to `resources/assets/` during build so OS can load the icon directly

### 3. Artifact filename fix
- Added `"artifactName": "${productName}-Setup-${version}.${ext}"` to `package.json` build config
- Fixes mismatch between `latest.yml` (dashes) and actual `.exe` filename (spaces) that caused "failed to get update" error

### 4. GitHub release process fix (non-code)
- All releases were being published as **Pre-release** — electron-updater ignores these
- Must publish as full release (uncheck "Set as a pre-release") for auto-update to work
- `/releases/latest/download/latest.yml` returning 404 is the diagnostic for this

---

## Current File State

| File | Status | Destination |
|------|--------|-------------|
| `index.html` | ✅ Update button, splash modal, version badge, shimmer CSS | `src/` |
| `main.js` | ✅ Icon fix, updater IPC, download-progress, quitAndInstall fix | `electron/` |
| `preload.js` | ✅ getVersion, installUpdate exposed | `electron/` |
| `package.json` | ✅ v1.0.8, artifactName, extraResources | repo root |
| `admin.html` | ⬜ Unchanged | `src/` |
| `setup.html` | ⬜ Unchanged | `src/` |
| `watcher.js` | ⬜ Unchanged | `electron/ipc/` |
| `mixelparse-watcher.js` | ⬜ Unchanged | `watcher/` |

---

## Build Process

1. Disable Windows Defender
2. `npm run build` from repo root
3. Re-enable Defender
4. Create GitHub Release tagged `vX.X.X`
5. Upload: `MixelParse-Setup-X.X.X.exe`, `MixelParse-Setup-X.X.X.exe.blockmap`, `latest.yml`
6. **Uncheck "Set as a pre-release"** — publish as full release

### Verify release is correct
```
https://github.com/mixelplex/MixelParse/releases/latest/download/latest.yml
```
Should return YAML with the new version number. "Not Found" = pre-release or missing files.

---

## Known Issues

- **rcedit / Defender:** Build fails if Defender is on. Disable before building, re-enable after.
- **Unsigned installer:** Testers see SmartScreen "Unknown publisher" — click "More info → Run anyway."
- **Clear DB button:** No user guard on item DB delete. Low risk for now.

---

## Session Zip Script (updated — includes package.json)
```powershell
$files = @("src\index.html","src\admin.html","src\setup.html","electron\main.js","electron\preload.js","electron\ipc\watcher.js","watcher\mixelparse-watcher.js","package.json"); $h = Get-ChildItem -Filter "HANDOFF_v*.md" | Sort-Object Name | Select-Object -Last 1; if ($h) { $files += $h.Name }; Compress-Archive -Path $files -DestinationPath "session-upload.zip" -Force; Write-Host "Done"
```
