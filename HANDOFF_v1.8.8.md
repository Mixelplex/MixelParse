# MixelParse — Handoff v1.8.8 (2026-10-26)

Read this first, then CLAUDE.md, then the code. HANDOFF_v1.7.6.md is the previous one; its rules and how-tos still hold
unless this file says otherwise.

## 0. State at hand-off (2026-10-26, ~3 AM)
- **Published:** 1.8.9 (main + tag pushed). Releases 1.7.27 → 1.8.9 all came from one long session (see §2).
- **1.8.9** (released with this file):
  - Kill Tracker keeps its drawn page on a tab switch when nothing changed (`tabSig('kills')`, the minute is part of it).
  - Parking: only someone physically in the zone counts as parked. Gate / port shows as "nobody parked · can gate / port in: X". Badges read "⚓ Not parked · can gate" / "🧪 Not parked · can port" (`btParkedInLoc`, `btParkReach`).
- **Scheduled task:** "MixelParse daily log review (2 AM)" runs locally every day at 2:00 AM Eastern (`C:\Users\Owner\.claude\scheduled-tasks\mixelparse-daily-log-review\SKILL.md`).
  - It's read-only and writes `MixelParse-Source\daily-log-review\YYYY-MM-DD.md`.
  - Its prompt lists fixed items not to re-report. Update that list when you fix something it reported.
- **Knowledge base:** `MixelParse-Source\knowledge\p99-mechanics-from-logs.md`, game facts measured from the logs, each with sample size and script. Check it before answering mechanics questions and append new findings.

## 1. Standing rules (in CLAUDE.md and Claude memory)
- Never push main or a v* tag without the owner's explicit all-clear. Push as three separate commands (main, tag, tag push).
- `node tools/raid-check.js` before an install.
  - Exit 1 means a raid OR someone played in the last 5 min; the relaunch opens over EQ.
  - The owner has said restarts are fine "whenever"; still mention it when someone is playing.
- Relaunch via Explorer (`Start-Process explorer.exe '"…\MixelParse.exe"'`). A copy started from the tool shell dies later.
- No scratch files in the repo (it's public). Scripts and analysis go in `MixelParse-Source\session-data-2026-10-08\` or `daily-log-review\`.
- Never write Supabase `item_db` without asking. Never enter credentials. Don't automate in-game advertising.
- Don't try to get around the P99 wiki's Cloudflare check. The app reads the wiki through a window where the owner passes it (§3).

## 2. Versions (1.7.27 → 1.8.8)
- **1.8.0–1.8.3:** Selling tab (Bankers → Selling, PigParse checks, Discord format); Projected DKP window with Add / Modify / Remove; Treasure guide.
- **1.8.4:** Leveling path card (Solo/Group, pins, logged-in clock); PL helper tag confirmation; Auto-Detect hourly hints (ToV/Sky/VP No-boss = hourly?); per-boss parking mute; Projected DKP fixes (multi-day sessions, charged entries).
- **1.8.5:** con-colour XP in the leveling path; PL helper Auto ignores party XP.
- **1.8.6:** PL power-leveller mode (follows the levelled player's tags); con factors fitted to 159 levels (`lvldConMod` 1 / 0.8 / 0.5 / 0.25); `src/log-loot.js` (measured drop rates + coin per active hour) in Farm Targets; melee miss % in the path; Submit logs "All".
- **1.8.7:** top bar 11 → 5 (Characters · Raids · Market · Raid Kill Tracker · Inbox; group bar `NAV_GROUPS`, `navGo`, `navGroupSync`; Flowers under Characters); speed (Auto-Detect ~1250 → 225 ms, Credit Check ~500 → 180 ms, Farm top 60, Gear Planner / Farm keep the drawn page via `tabSig`); faction-zone group kills (`TURNIN_KILL_MS`); `<Slowed>` calls.
- **1.8.8:** wiki through a window (Cloudflare); wiki change report; startup redraw coalescing (`refreshSoon`, `_invRefreshSoon`, `renderCityBarsSoon`, `setFaction(...,quiet)`); no-slain group kills (`_groupHitMob`, `_lastGroupHit`, 20 s, no NPC speech); BFG no main-hand bonus (`WEAPON_NO_MH_BONUS`); Popple Dop 36–39 (hand-added at the end of `src/mob-levels.js`).

## 3. Things that work differently now
- **P99 wiki:** every app request gets 403 `cf-mitigated: challenge`.
  - `electron/main.js` `wikiFetch(url, interactive)` reads through a hidden BrowserWindow with partition `persist:p99wiki`. If the check appears and `interactive` is true, the window shows and the owner passes it; the stored pass keeps later reads quiet.
  - `executeJavaScript` is raced against timers (`_wikiJs`) because it can hang during Cloudflare's redirect.
  - Only user-started actions are interactive; the weekly auto-check returns `'cloudflare'`.
- **Measuring speed on real data:** `%TEMP%\MixelParse-debug.lnk` starts the installed app with `--remote-debugging-port=9223`. Scripts in `session-data-2026-10-08\`:
  - `cdp-tabs.js "<js>"` runs JS in the page.
  - `cdp-profile.js "<js>" N` CPU-profiles it.
  - `cdp-startup.js` / `cdp-startup2.js` give startup lag and the longest stall.
  - `cdp-wiki.js` runs JS in the wiki window.
  - **Always** relaunch normally afterwards to close the port.
  - When the window is hidden (owner in game), rAF and timers are throttled. Measure synchronously, without awaits.
- **Log mining:** `daily-log-review\census.js`, `mine-all.js` + `mine-report.js` (one pass over ~9 M lines, ~15 s); `loot-rates.js`, `gen-log-loot.js` (rebuilds `src/log-loot.js`); `proc-will.js`, `proc-rate.js`, `con-calib*.js`.

## 4. Open items
- **Startup:** a few 0.3–0.6 s hiccups remain, mostly `renderTable` running a handful of times as other data arrives.
- **Gear Planner:** weighting melee by the measured hit share lowered wiki agreement (47 → 43 / 76), so it was left out. Revisit only with the wiki lists.
- **Feature flags per user:** discussed (Supabase `feature_flags` table + `featureOn()`), not built.
- **US DST ends Nov 1:** the 1–2 AM hour repeats in the logs. Worth replaying the watcher over it once the lines exist.
- **Popple Dop:** wiki level is only "Below 40". Refine if the wiki gets a number.
