# MixelParse — Deployment Handoff v2
**Session date:** 2026-06-17  
**Version:** v1.0.1 (tester patch — guild data isolation + item DB access)

---

## What Was Accomplished This Session

### 1. Electron Installer Packaging
- Configured `package.json` with electron-builder for Windows NSIS installer
- Removed code signing config (`sign.js`, `signingHashAlgorithms`) — unsigned build fine for testers
- Removed `ws` dependency (standalone watcher only, not needed in Electron)
- Added `"copyright": "2026 mixelplex"` (no © symbol — causes rcedit failure)
- **Build command:** `npm run build` from project root with Windows Defender disabled
- **Output:** `dist\MixelParse Setup X.X.X.exe`
- `dist/` added to `.gitignore`

### 2. Supabase: Item Database Shared Read Access
- `item_db` stores items by `item_name` with no `user_id` — intentionally shared guild-wide
- RLS was blocking testers from reading rows
- **Fix:** RLS SELECT policy added in Supabase dashboard:
  ```sql
  create policy "Allow authenticated read"
  on "public"."item_db"
  as PERMISSIVE for SELECT to public
  using (true);
  ```

### 3. guild_data Per-User Isolation (index.html)
- **Problem:** All `guild_data` queries used `.eq('pool','SoV')` only — one shared row visible to all users
- **Affected:** raid sessions, DKP, zone data, banker registry, credit data
- **Fix:** All 15 query sites patched in `index.html`:
  - SELECTs/UPDATEs: added `.eq('user_id',currentUser.id)`
  - INSERTs: added `user_id:currentUser.id`

#### ⚠️ REQUIRED Supabase SQL (run once if not already done)
```sql
ALTER TABLE guild_data ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id);
UPDATE guild_data SET user_id = auth.uid() WHERE pool = 'SoV';
```
Run in Supabase → SQL Editor while logged into the dashboard.

---

## Current File State

| File | Status | Destination |
|------|--------|-------------|
| `index.html` | ✅ Patched (guild_data user_id isolation) | `src/` |
| `package.json` | ✅ v1.0.1, signing removed, copyright fixed | repo root |
| `admin.html` | ⬜ Unchanged | `src/` |
| `main.js` | ⬜ Unchanged | `electron/` |
| `preload.js` | ⬜ Unchanged | `electron/` |

---

## Build Process

1. Disable Windows Defender
2. Bump `"version"` in `package.json` and get full file from Claude
3. `npm run build`
4. Re-enable Defender
5. Distribute `dist\MixelParse Setup X.X.X.exe`

### Auto-update release flow (GitHub Actions)
Upload these three files to a new GitHub Release tagged `vX.X.X`:
- `MixelParse Setup X.X.X.exe`
- `latest.yml`
- `MixelParse Setup X.X.X.exe.blockmap`

Existing installs will auto-update on next launch.

---

## Known Issues

- **rcedit / Defender:** Build fails if Defender is on. Disable before building, re-enable after.
- **Unsigned installer:** Testers see SmartScreen "Unknown publisher" — click "More info → Run anyway."
- **Clear DB button:** No user guard on item DB delete. Low risk for now.
