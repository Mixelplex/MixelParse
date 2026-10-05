# MixelParse — notes for Claude sessions

Start with the newest `HANDOFF_v*.md` **by version number** (currently `HANDOFF_v1.7.6.md`), then read the code.

## Standing rules
- Never push `main` or a `v*` tag without the owner's explicit all-clear (main redeploys Pages; a tag publishes a release + auto-update).
- Test builds may be installed on the owner's PC without asking: run `node tools/raid-check.js` first (its own command; exit 1 = raid; if no log has a line in the last 15 min, ask), close MixelParse, run `dist\MixelParse-Setup-<ver>.exe /S`, verify, relaunch. Never run `npm start` alongside the installed app.
- Pushing: run `git push origin main`, `git tag vX.Y.Z`, `git push origin vX.Y.Z` as separate commands (they match the owner's allow rules).
- The desktop app is the focus, not the website/PWA. `src/admin.html` is a public troubleshooting tool by design.
- Gear Planner rules are intended (max-only linear haste, STA scored via HP, NO DROP excluded from buy lists) — don't flag them.
- Ask before writing to the shared Supabase `item_db` table. Never enter credentials.
- Auto-Detect: Watch mode never writes; Active mode is exactly what the handoff describes — don't widen it without the owner asking. Roster / chat data may only upgrade a tick, never downgrade one.
- Bot timers come from Supabase `bot_timers` (the Discord bot's sheet, via a service account). Never publish that sheet; its key stays in Supabase secrets.

## Working in this repo
- Build: `npx.cmd electron-builder --win --publish never`
- Syntax check after editing: `node tools/mp-check.js src/index.html` (and `src/admin.html`)
- `src/index.html` is very large with long single-line functions: edit with exact, unique anchors.
