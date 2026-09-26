# MixelParse — notes for Claude sessions

Start with the newest `HANDOFF_v*.md` **by version number** (currently `HANDOFF_v1.5.14.md`), then read the code.

## Standing rules
- Never push `main` or a `v*` tag without the owner's explicit all-clear (main redeploys Pages; a tag publishes a release + auto-update).
- Test builds may be installed on the owner's PC without asking: check recent `eqlog_*` files for raid activity first, close MixelParse, run `dist\MixelParse-Setup-<ver>.exe /S`, verify, relaunch. Never run `npm start` alongside the installed app.
- The desktop app is the focus, not the website/PWA. `src/admin.html` is a public troubleshooting tool by design.
- Gear Planner rules are intended (max-only linear haste, STA scored via HP, NO DROP excluded from buy lists) — don't flag them.
- Ask before writing to the shared Supabase `item_db` table. Never enter credentials.

## Working in this repo
- Build: `npx.cmd electron-builder --win --publish never`
- Syntax check after editing: `node tools/mp-check.js src/index.html` (and `src/admin.html`)
- `src/index.html` is very large with long single-line functions: edit with exact, unique anchors.
