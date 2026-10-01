# MixelParse — Handoff v1.6.5 (2026-10-01)

Supersedes `HANDOFF_v1.5.21.md` (kept for history — its §3 weapon/Auto-Detect/DKP/weight detail and §5 tools are
still accurate). Start here, then read the code. Git history is the source of truth.

---

## 1. Standing rules (owner — also in Claude memory)
- **Push / tag only on the owner's all-clear** ("push it" / "publish" = the full release flow below).
- **Pushing works through allow rules** in `.claude/settings.local.json` (owner added 2026-09-30, git-excluded):
  exactly `git push origin main`, `git push origin v*`, `git tag v*`. Run each as its OWN command — chained with `;`
  they don't match and auto mode refuses. Claude can't edit its own permissions (refused as self-modification).
- **Standing OK to install test builds** — but run `node tools/raid-check.js` FIRST as its own step (exit 1 = raid).
  It reads in-log timestamps (file mtimes lie while EQ holds a log open) and enrage/rampage/raid chat/ticks
  (a fight in progress has no tick yet). **If no log has a line in the last 15 min, ASK before restarting** —
  2026-10-01 I restarted mid Lady Mirenilla kill: that character's log had a crash gap, so everything looked quiet.
  When the owner explicitly says "install", do it (they've judged the raid timing).
- Don't bump the version per test build; bump only to publish. Never `npm start` alongside the installed app.
- Desktop app is the focus. Gear Planner rules are intended. Ask before writing Supabase `item_db`. No credentials.
- **Clickies ignore item class lists** — the Class line limits equipping only; any class clicks from inventory.
- **Plane of Sky pays DKP but is never parked for**; the log zone name is **"Plane of Air"**.
- **Resist recorder + Auto-Detect stay watch-only** until the owner says otherwise.

## 2. Versions this session (all published)
| Version | What |
|---|---|
| 1.5.22 | Supplies panel (Weight column, drag-reorder rows, compact), bag-weight rounding fix, parking port items (Vial of Velium Vapors → Dain, Lizard Blood Potion → Fear, Vial of Swirling Smoke / Gate → bound toons), silent resist recorder + Admin Resist Watch |
| 1.6.0 | Keys tab + Plane of Sky corpse tracker, menu: Raid Info (Raid Parking + Spawn Timers), Bankers (+ Consolidate), Sky removed from parking |
| 1.6.1 | Eye of Zomm consume = Stalking Probe / Holgresh Elder Beads / Clay Bracelet; WIZ/MAG pass (guild bug report) |
| 1.6.2 | Auto-Detect right-click → Add to Raid Kill Tracker (kill dialog for that tick's time) |
| 1.6.3 | Searchable boss menu, tick zone, Mobs up column, spawn-timer ToD suggestion |
| 1.6.4 | Unknown ToD (Dead), pending "Collecting evidence" rows, Load deep-copy fix, split-line + zone fixes, Admin Resist Watch bridge, `tools/raid-check.js` |
| 1.6.5 | Mobs up = potential spawns only (in window / up < 24 h); stale counted |

Release flow: `scratchpad rel165.js` pattern (in `session-data-2026-09-30/scratchpad`) — replaces WHATS_NEW, prepends
release-notes.md, bumps package.json (1) + package-lock **top-level and `packages[""]` only** (a blind replace hit
the `sax` dependency at 1.6.0 in the 1.6.1 release — fixed in a follow-up commit). Commit with `git commit -F <file>`
(PowerShell 5.1 breaks messages containing double quotes). Then `git fetch` + `git merge origin/main` (CI pushes
"deploy src to docs"), push main, tag, push tag — separately. Check the run via
`https://api.github.com/repos/Mixelplex/MixelParse/actions/runs?per_page=12`.

## 3. What was built (where)
### Resist recorder (watch-only) — `electron/ipc/resistwatch.js`
Appends to `%APPDATA%\MixelParse\resist-watch.jsonl` (20 MB rotate): spells on your chars (resist/land + damage,
caster + /con phrase), your resistable spells (resist/land/nohold + target), renderer resist snapshot
(`resistSnapSend`: base/gear/parked), resist buffs seen in the log. Spell facts from the client's `spells_us.txt`
(resist type col 85, adjust col 147; same-name versions listed as `vars`, landing damage picks one).
Admin → Research → **Resist Watch** reads it (`resist:read` IPC; Admin opens via `window.open`, so the bridge is
`window.opener.MixelParseApp`). Findings so far: −100/−150 spells (breaths) 0% resisted; no partial damage seen on
players. **Open: Mixelflop MR shows 119 in the app vs 80 in game** — check in game before trusting snapshots.

### Keys tab + Sky corpses — `renderKeysPanel` (index.html), `electron/ipc/skycorpse.js`
Keys per raider (bankers excluded): Trakanon Idol, Key of Veeshan (progress: Trakanon's Tooth + medallion pieces by
item ID 19956–19964 — all named "Piece of a medallion"), Sleeper's Key (talisman), Key to Charasis, Tooth of the
Cobalt Scar. Sky corpse = any death in "Plane of Air"; 7-day decay, 3 h rez; keys only when verified by an in-Sky
`/outputfile inventory` before dying or a corpse export (never carried forward). 24 h countdown banner
(`#skyCorpseWarn`). State in `%APPDATA%\MixelParse\sky-corpses.json`, 8-day log backfill on start.

### Raid parking
`RAID_PARK_TARGETS[].port` (Dain: Vial of Velium Vapors, Fear: Lizard Blood Potion) → status `portparked`.
Bound toons count only with Gate (CLR/DRU/SHM/NEC/WIZ/MAG/ENC) or a carried Vial of Swirling Smoke (`parkGateHow`).

### Auto-Detect (still watch-only)
- Right-click a row → SUGGESTED → MOBS UP IN <zone> → search all 87 bosses → `todEnqueue(…, when)` opens the kill
  dialog; session covering the kill preselected; new session dated to the kill; `lastKillAt` never moves back.
- Watcher tags each RAIDTICK with the zone (`_rtZone`, `_lastZoneInLog` fallback; OOC hearer wins); tail reads
  complete lines only.
- No log evidence → `rkdTimerGuess`: a boss whose spawn-timer ToD is 20 min before … 5 min after the tick = Weak.
- **Mobs up** (`rkdUpInZone`, stored `upZone/upStale/upV:2`): bosses of the zone's park loc that were in window or
  up < 24 h at the tick; Dead excluded; >24 h "up" = stale (count only).
- Pending ticks show as "⏳ Collecting evidence" for the 2-minute window; `rkdDedupe` merges duplicate rows.

### Spawn Timers
Unknown ToD → **Could be up** (open now, width unknown) / **Dead** (`dead:true`, status `k:'dead'`, never up).

### UI
Supplies panel (was Food, Drink & Coins). Top menu: Characters · DKP History · Plat Prices · Raid Kill Tracker ·
Raid Info · Keys · Farm Targets · Bankers.

## 4. Open items
- **Log-gap warning (designed, not built)**: a log that jumps >10 min straight into "Welcome to EverQuest!" without
  camp lines during a raid = crash/disconnect (Mixelmedic 00:50–01:17 lost the Lady Mirenilla kill entirely). Plan
  for when Auto-Detect goes live: never auto-add across a gap; fill from other chars' logs → spawn-timer ToD inside
  the gap ("Lady Mirenilla ToD 01:05 during your log gap — add?") → ODKP; one review prompt after relog.
- Auto-Detect hourly ticks (NToV/Sky/VP) and zone-clear attendance ticks (Fear) still show No boss — ODKP labels
  (after upload) are the authoritative source; consider showing the ODKP label as the suggestion.
- ToV and Western Wastes share one park loc (`wwtov`), so a ToV tick's Mobs up includes WW dragons.
- Mixelflop MR 119 (app) vs 80 (game) — owner to check in game.
- Older items from HANDOFF_v1.5.21 §4 (respawn timers for Takish/Vilefang/Vaniki, last-writer-wins timer board,
  approved features list) are still open.

## 5. Session data
`C:\Users\Owner\Desktop\MixelParse-Source\session-data-2026-09-30\scratchpad` — release scripts (rel122/160–165),
commit message files, survey/probe scripts (log line survey, resist rates, Sky deaths, tick context), the watcher
integration test `tailtest.js` (replays a real log through the real watcher in chunks), test fixtures.
Preview gotcha: the PWA service worker serves stale index.html in the browser pane — unregister it + clear
`caches` before testing (see any test in this session's transcript).
