# MixelParse — Handoff v1.7.1 (2026-10-04)

Supersedes `HANDOFF_v1.6.6.md` (kept for history; its §3 still describes Auto-Detect Watch / Active mode accurately).
Start here, then read the code. Git history is the source of truth.

---

## 1. Standing rules (owner — also in Claude memory)
Unchanged from v1.6.6 §1: push / tag only on the owner's all-clear (three separate commands); test builds may be
installed after `node tools/raid-check.js` (exit 1 = raid; "install" from the owner = do it); no version bump for test
builds; desktop app is the focus; Gear Planner rules intended; ask before writing Supabase `item_db`; never enter
credentials; clickies ignore class lists; Sky pays DKP but is never parked; resist recorder watch-only; Auto-Detect
Watch never writes and Active does only what v1.6.6 §3 + §3 below describe.

New this session:
- **Roster / chat may only upgrade a tick, never downgrade one** (owner). Another guild typing RAIDTICK in OOC is
  "99% not happening".
- **ODKP lags up to a week**: ODKP pairing fixes are low value. ODKP exports are still fine as replay ground truth.
- **The bot sheet must not be published to the web** (owner of the sheet). Access is the service account below.

## 2. Versions this session
| Version | What |
|---|---|
| 1.6.7 | Auto-Detect: zone-aware evidence, faction-hit Strong, one fight per tick, /q marker, Scan logs re-judges, Dracoliche → Fear |
| 1.7.0 | Spawn timers live from the Discord timer bot (Supabase `bot_timers`); manual Log quake / Add ToD / Clear board removed |
| 1.7.1 | Bind look-back + bind age on Raid Parking; ❔ Unknown timers (no ToD / past window > 12 h); spawn-timer suggestions only for attended raid-zone ticks |

Release template: `session-data-2026-10-03/scratchpad/rel171.js` (same shape as rel166/rel167/rel170).

## 3. Auto-Detect changes (1.6.7) — index.html `rkdAttribute`, watcher.js `raidEvidence`
- **Zone-aware evidence.** The watcher tags every raid signal (ticks *and* evidence) with the zone its character was
  in (`_rtNoteZone` / `_rtZoneOf`; "Welcome to EverQuest!" = zone unknown until the next "You have entered"; the 6-h
  backfill replays zone lines too; Scan logs tags them). `_rkdEvInZone(e,t)`: for a tick heard in OOC / shout
  (`t.sameZone`), evidence logged in another zone doesn't count, and a boss whose `BT_PARK_LOC` differs from the
  tick zone's park loc doesn't count. Guild-chat ticks are not zone-filtered (the listener's zone says nothing).
  Fixed in the replay: 5/7 Fear tick called Tormax (was Dread), 7/30 Plane of Growth tick called Tormax (now Takish).
  The owner's framing: porting / `/q` character swaps / crash relogs carry one fight into the next tick.
- **Weak + kill faction hit → Strong.** Boss-less faction hits ("Kromzek", "DenizensofFear") are now kept in
  `_rkdEvidence` (boss null) along with boss-less named slain lines. A Weak top candidate with a faction hit in the
  zone between 3 min before and 2 min after the tick becomes Strong; ToD = the **first** hit, skipping hits in the same
  second as a named trash kill (6/19 Cleric of Innoruuk, 6/30 Nelaarn). Replay: 17 promotions, 2 wrong (6/17 Fright
  called as Dracoliche died; 7/3 Mirenilla on an hourly) — the owner accepted those as "weird examples".
- **One fight per tick.** `pvTail`: the previous tick's boss's lines in the 2 min after that tick belong to it (and a
  boss-less faction hit in that tail too, while that tick hasn't seen its own kill). Fixes 7/1 Nevederia → Cekenar.
  Excluding *all* later lines of the previous boss cost 14 right ticks (Sky Queen Bees, Vulak attempts) — don't.
- **Late kills are NOT moved back onto an earlier tick.** Kills 9–12 min after a tick were always followed by a new
  tick for them; pre-kill ticks had the kill within 2 min (23/23), which the post-window already catches.
- **/q marker.** The watcher broadcasts `raidLogin` (live, backfill, scan `logins`); a tick followed within 5 min by a
  login with no kill line is marked "/q or relog after the tick — kill not seen" (`r.qAfter`). Display only.
- **Scan logs re-judges** unanswered rows (no `confirm`) to a stronger tier; status line says "N re-judged stronger".
- **Dracoliche** is a Plane of Fear boss (`BT_PARK_LOC`), was filed under wwtov.
- Investigated and dropped: roster / chat kill-calls as evidence (tick text never names the boss; boss-naming chat
  near ticks was ~3 right / 6 misleading). Roster export + bot list saved in session data for later.

## 4. Bot timers (1.7.0) — index.html block "Castle Bot Timers (owner, 2026-10-03)"
- **Source:** Google Sheet "Castle Bot Timers" (`1F9cDtGYjtz3naC8bouac0hZfapSzMFjUTKfxZ3wpJIQ`, tab "Timers": Boss,
  Status, Window Opens/Closes (UTC), Last TOD (UTC), Skip Count, Updated (UTC); 148 rows, ~60 with a ToD), kept by the
  guild's Discord timer bot. The sheet owner shared it (Viewer) with a Google **service account**; the owner set up a
  Supabase Edge Function + schedule that copies it into **`public.bot_timers`** about **every 2 minutes**.
  Columns: `boss, status, window_opens, window_closes, last_tod, skip_count, sheet_updated_at, synced_at`.
  The function's source is not in the repo (the owner built it in the dashboard; `bot-timers-sync` answers 404,
  `sync-bot-timers` exists). The service-account JSON key is in Supabase secrets only — never in the app or repo.
- **App:** `btSheetSync` reads `bot_timers` at startup and every 5 min (`BT_SHEET_EVERY`), maps names with
  `btResolve` (aliases added: Gozz, Vaniki1) and `btApplySheet`: a sheet ToD newer than the board's replaces it
  (`src:'sheet'`, `base:` = the entry it replaced); a newer `/note`, quake or Dead mark wins; pastes are always
  replaced. **Sheet windows are never saved into the shared `guild_data.boss_windows` row** — `btSave` writes `base`
  (or nothing) instead, because every client reads `bot_timers` itself. Last copy cached in localStorage
  `mp_bt_sheet_cache`. `_rkdTodOf` treats `src:'sheet'` as an exact ToD. Status line on Raid Info → Spawn Timers
  ("N timers · bot sheet synced X ago", "sync stalled" after 20 min). Not-roster sheet names are listed
  (Phinigel, KoSouls, Ring War, Ring8, QueenCook, Scout, Vessel, angry).
- **Removed:** Log quake, Ring 8 "Check now", Add ToD, Clear board (+ btQuakeManual / btDoTod / btClear). The hourly
  Ring 8 auto-quake (`btStartAuto`), `/note` ToD / Quake! and right-click ToD remain. The tracker paste box remains
  (owner asked whether to keep it as a backup — not answered).
- Tried and dropped: an Apps Script relay in the owner's Google account (owner didn't like it), publish-to-web (not
  allowed), Claude in Chrome reads (one-off only).

## 4b. 1.7.1 (2026-10-04)
- **Bind look-back** (watcher.js `bindBackfill`, on requestAll, once per run): each live log is read backwards in 4 MB
  chunks to its last bind signal — "You are currently bound in: X" (/charinfo) or "You feel yourself bind to the area."
  plus the last "You have entered" before it — falling back to the character's `.old` / `Logsarchive` files. ~0.5 s for
  171 logs. Live and look-back binds carry the LOG LINE's time; `setCharBind` keeps the newest. Cause: Mixelboom rebound
  in Western Wastes 9/22 while the app was closed; the 9/20 /charinfo "The Feerrott" made parking show him bound at
  Fear and the owner missed Dread. `loadBindDataFromSupabase` now merges binds that arrived before it (newest wins) and
  `saveBindDataToSupabase` does nothing until the load ran (it used to be able to overwrite the stored map with a
  partial one). Raid Parking's "Bound here" shows `parkBindAge` ("/char today", "bind cast 11 days ago", amber > 7 d).
- **Unknown timers** (owner's choice): `btStatusOf` → `'stale'` when more than `BT_UP_GRACE` (12 h) past the window;
  no ToD stays `'none'`; both are `btIsUnknown`. Board lists them as ❔ Unknown (amber) — the "No Timers" dropdown is
  gone. `btLocHeat` returns `'unknown'` when every mapped boss is unknown (Dead counts as 'soon'); `parkCoveredNow`
  is false for it (yellow tier, badge "❔ Covered · timer unknown"); cards with some unknown bosses show "❔ +N no timer".
  Mobs up uses the same 12 h for past-window bosses.
- **Spawn-timer suggestions** (`rkdTimerGuess`): only for attended ticks (`_rkdAttended`) in a mapped raid zone, and
  only that zone's bosses. `rkdRetryNoBoss` returns older unanswered "spawn timer" rows that fail this to No boss.
  Cause: a guild-chat tick heard by lvl 13 Mixelcoth in Nektulos Forest was "VS · Weak (spawn timer)".
- Zone names: "Permafrost Caverns" (zone line) vs "Permafrost Keep" (/charinfo) — not checked against parkNormZone.

## 5. Open items
- **`bot_timers` is readable with the public anon key** (no sign-in). The owner was given
  `alter table … enable row level security; create policy … for select to authenticated using (true);` — as of the
  1.7.0 push anon reads still worked. After it's run, confirm anon is refused AND `synced_at` keeps advancing (if the
  owner's function writes with the anon key, RLS would block it; revert = `disable row level security`).
- Paste box: keep or remove (owner to decide).
- The bot sheet gives exact ToDs with no lag — a better Auto-Detect check than ODKP. Tick-time ToDs were up to 2 min
  off vs the sheet; kill-line ToDs 0–4 s.
- Carried: ODKP label parsing ("09-24 Vulak kill", "Vkill3", …) — low value given ODKP lag; log-gap warning
  (v1.6.5); ToV / WW share one park loc; Mixelflop MR 119 vs 80; older items in v1.5.21 §4.

## 6. Session data
`C:\Users\Owner\Desktop\MixelParse-Source\session-data-2026-10-03\`:
- `characters-export.csv` (ODKP roster), `bots-raw.txt` / `bots.txt` (owner's bot list, 208 names),
  `castle-bot-timers-2026-10-03.txt` (sheet snapshot), `scratchpad/rel167.js`, `rel170.js`, commit messages.
- `scratchpad/simscan.js`: the log replay (now tags evidence zones and records logins) → `sim-scan.json`; serve it with
  the `scratch-mock` launch config (point it at the folder) and run the v1.6.6 §4 method; `chatscan.js` / `slainby.js`
  (roster / chat studies); `qtest.js` (a scripted /q swap through watcher.js); `jwttest.mjs` (service-account JWT check).
