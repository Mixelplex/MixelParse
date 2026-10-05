# MixelParse — Handoff v1.7.6 (2026-10-05)

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
| 1.7.2 | Auto-Detect: faction hit = ToD on every tick; boss speech = Weak evidence; guild-chat tick attended when your char logged the boss's lines in that zone |
| 1.7.3 | ODKP auto-sync (DKP History + item prices, Credit Check ledger); faction right-click; DKP History wiki links; quakes removed; balance counts double-credited ticks |
| 1.7.4 | Live auction window; your DKP in the header; Guild DKP list; buyer DKP / RA + main names + raid detail in DKP History; date + raid-name fixes |
| 1.7.6 | (published as 1.7.6 — the 1.7.5 build was cancelled by a GitHub Actions outage and its tag left unused) Raid Parking on the Castle Alliance level policy update; Auto-Detect "under level" note + No kill, no credit; auction window rebuilt (closes on Gratss); header DKP follows the Credit Check ledger |

Release template: `session-data-2026-10-03/scratchpad/rel175.js` + `rel175-content.js` (built by `rel175-gen.js`; the What's New item can hold an HTML table) (same shape as rel166–rel173).

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

## 4c. 1.7.2 (2026-10-04) — Auto-Detect evidence, current rules
- **Ranks** (`RKD_RANK`): slain / boss-named faction 4 · enrage 3 · landing / rampage 2 · call / **boss speech (say)** 1.
  Strong = top rank ≥ 3, or real (non-speech) Weak evidence + a boss-less kill-faction hit. Weak = rank 1–2, or the
  zone's spawn timer (attended raid-zone tick, one boss ToD −20…+5 min). Pick = top tie with comparable evidence (a boss
  with real evidence beats one that only spoke). ToD = slain / boss-named faction → else the **first boss-less faction
  hit at/after the boss's last fight line** (calls excluded; not the same second as a named trash kill; not a hit that
  is already the previous tick's ToD) → else the tick.
- **Boss speech**: watcher `RE_RT_SAY` — NPC speech has no comma ("Fright says 'JAEJEE'"; Fear golems call their
  target, CT / Vulak / Nagafen say "You will not evade me <name>", Vindi "Only the strong will survive"). Rank 1, the
  90 s next-pull rule applies, never promoted to Strong by a faction hit, loses ties to real evidence.
- **Guild-chat ticks** count as attended (`r.inZone`) when the character that heard it logged the boss's own lines
  (non-call) in its zone. Tonight's Fright failtick (Mixelplex in Fear, guild-chat RAIDTICK) → Weak Fright, prompted.
- **Scan logs** moves a row's ToD from 'tick' to the kill time for the same boss (also answered rows; btNoteTod for
  auto-added / confirmed kills within 14 days).
- **Tried and dropped (don't redo without new data):** "in a raid zone + heard the tick = attended" (+101 evidence-less
  prompts from parked / boxed chars in WW / Cobalt Scar / Karnor's, −11 labels); OOC calls in your zone as proof
  (+1 wrong, −1 label); "contested target" via the Castle roster (owner: rabbit hole; Eluare is an ODKP placeholder
  record, actually an & Co raider — "not Castle" ≠ "not our raid").
- Replay vs 1.7.1: Strong unchanged; ~12 No boss → Weak (9 right, mostly failed attempts); 98 ToDs move to the death.

## 4d. 1.7.3 (2026-10-05) — ODKP integration
- **Castle's OpenDKP API is public and read-only**: `https://api.opendkp.com/clients/castle/…` — `/dkp` (1,701 chars:
  CurrentDKP + 30/60/90/life RA), `/characters` (roster, ParentId = main), `/characters/{id}`, `/characters/{id}/dkp`
  (an account's full ledger — identical to the dkp-details export), `/items?page&ItemsPerPage` (all item sales,
  newest first, 5000/page works), `/raids?page&ItemsPerPage`, `/raids/{id}` (ticks, items, credited characters),
  `/adjustments`, `/auctions`, `/accounts/{name}/characters`. **Never use `/status` (account holder's name + email)
  or `/clients/castle` (login config).** main.js `odkp:get` only allows the read paths above (`ODKP_PATH`).
- **Sync** (index.html "ODKP auto-sync"): items 15 s after sign-in and every 2 h — 1-row head check, full pull only for
  a new TransactionId; `buildDkpLookup` (shared with the CSV upload) → dkpLookup / dkpMeta {src:'odkp'} →
  saveDkpToSupabase + `odkpApplyPrices` (applyDkpToItemDB only once `_itemDBCloudLoaded`; owner approved the item_db
  price writes). Ledger as soon as characters exist (charNames(): all character tabs minus bankers / excluded) →
  the account holding most of them (`ParentId`) → `/characters/{main}/dkp` → CSV text → `parseDkpDetailsCsv` →
  odkpTicks / odkpTicksMeta {mainName, acctSize, odkpSig} → `odkp_personal` (per user). Credit Check header shows
  the sync state (waiting for characters / not on ODKP / syncing / synced · <main>'s account).
- **Balance fix**: `parseDkpDetailsCsv` sums Values before the TickId de-dup (Frown 8/16 Dozekar was credited to
  Folic + Fled; ODKP counts both).
- Owner declined locking down `bot_timers` (the ODKP site is public anyway) — don't raise it again.
- **Next (owner approved, 2026-10-05)**: 1) balance + RA next to buyers in DKP History, 2) Guild DKP list, 3) DKP + RA on
  character tabs, 4) raid / tick detail + "ticks Auto-Detect saw that ODKP didn't credit", 5) main/alt names everywhere.

## 4e. 1.7.4 (2026-10-05) — guild DKP + live auctions
- **Guild DKP snapshot** (index.html "Guild DKP from ODKP"): `/dkp` + `/characters` with the item sync (sign-in + 2 h),
  cached in localStorage `mp_odkp_guild` {chars by lowercase name: dkp, class, rank, level, RA ticks, mainId; accts by
  main id}. Helpers `odkpC`, `odkpAcctOf`, `odkpWho` ("Fentin (Frown)"), `odkpBal`. Used by DKP History sale rows
  (balance + RA, main names, ISO dates formatted, raid link → `odkpRaidModal` from `/raids/{id}`), the **Guild DKP**
  view (DKP History tab toggle `dkpView`; one row per account, search any character), and the **header** ("⚔ Your DKP"
  beside Est. Market Value in `renderNetworthBar` → `odkpHeaderDkp`; "updated" = ODKP's AsOfDate). The tab-bar chip was
  replaced by the header block. DKP / RA are per ODKP account.
- **Live auction window**: watcher `auctionSignal` (in `raidEvidence`, so also the 6 h backfill) forwards `auctionLine`
  only within 15 min of an officer's "~[Item] - BID IN /AUC" (trade chatter never leaves the watcher). Main app
  `aucOnLine`: an auction is open until 5 min with no bid (bidding runs past "Closing in 2m30s"; nothing marks the close);
  bids parsed by `aucParseBid` (item name + one number + optional toon: "Item 5", "Item5", "5 Item", "Item 3 toon");
  re-posted identical bids collapse. State → `auction:push-state` → `src/auction.html` (frameless, always on top,
  `showInactive` on pop so EQ keeps focus; "pop up" toggle = localStorage `mp_auc_autopop`). Outbid toast in the main
  app. Log replay: top bid = ODKP winner (by account) 90%, price 86%, both 84% (1,646 auctions).
- **Not yet observed live** (owner: "we will need to test it out"): the pop-up timing, focus behaviour over EQ, and
  multiple simultaneous auctions in a real raid.

## 4f. 1.7.6 (2026-10-05) — Castle level policy
- **Policy table** (index.html `CASTLE_LVL` + `castleLvlReq(boss, cls)`, beside `PARK_EXC_GROUPS`), keyed by BOSS_ROSTER
  target, from the owner's pasted "Castle Alliance – Level Requirements Policy Update": 60 = ToV 7-day targets, city leads
  (Dain, Yelinak, Tormax), Statue / AoW / Tunare / Zlandicar, and with NO class exceptions Klandicar, Sontalak, all VP;
  58 = ToV practice / HoT (incl. minis), Vindi, Velketor, Wuoshi, Kelorek, Vaniki, Ring War, ST, Kunark bosses, and
  Fear / Hate when competitive (`farm:55`); 50 = Naggy, Vox; unlisted 55. Class exceptions CLR 52 / BRD 55 / MAG 55
  everywhere else. Judgement calls told to the owner: Magi P'Tasa 58 (HoT), Takish unlisted → 55, Sky not parked.
- **Raid Parking** (`RAID_PARK_TARGETS`): floors raised to match (all former 55 rows → 58 or 60, ToV 58 → 60, VP exc
  → none); every row now uses the `yellow` exception group except Klandicar / Sontalak / VP. Row names unchanged
  (park ignores key off them — "Dain Frostweaver IV" typo kept on purpose).
- **Auto-Detect note**: `rkdFinalize` stores the tick character's level + class (`_rkdCharLvl`, live ticks only);
  `rkdLvlWarn(r)` → "⚠ lvl N — under level (X)" under the character in the Auto-Detect table and appended to the
  Active-mode toasts. Information only — never changes tier, never blocks an auto-add. Scanned / older rows get none.
- **Header DKP fix**: `odkpHeaderDkp` uses the Credit Check ledger balance (`odkpTicksMeta.dkp.balance`) when it's the
  same account and newer than ODKP's `/dkp` AsOfDate (the summary trails the ledger); every ledger sync — auto,
  "no change" (sets `checkedAt`) or the Credit Check button — also re-pulls the guild list and redraws the header.
- **No kill, no credit** (right-click only — owner: no prompt button): `rkdSetNknc(id,on)` sets `r.confirm='nknc'`
  (undoes an Active auto-add first, drops a queued prompt for the tick). `rankOf` skips `nknc` and `dismissed` rows, so a
  round-2 kill isn't "#2"; Credit Check shows "no credit expected". Case: Sontalak 10/4 (wipe 19:31, tick 19:37, kill +
  faction 20:05, tick 20:07). A wipe tick is normally Weak, so Active never auto-adds it.
- **Auction window rebuilt** after the first live raid (owner: too small, overwhelming): `--fs` 18 (A−/A+, localStorage
  `auc_fs2`), top bid hero + runner-up + your own bid (`SHOW=1`), one row per bidder+toon, RA removed, closed auctions
  folded into a "CLOSED" list, item names → wiki (apostrophes escaped — they broke the onclick). Renders only when the
  HTML changes (a 1 s rebuild ate clicks); the ⏱ count-up fills `.tm` spans. Window 520×800 default, bounds saved to
  userData/auction-window.json. **Close rule** (owner: "can't be closed until the officer has gratz it out"):
  `RE_AUC_GRATS` "~Gratss <name> on [Item] (N DKP)!" sets `gratsAt` + `winners` (more grats for the item add winners —
  2 Trakanon's Teeth 10/5; ROT = rotted; roll lines too); bids after it are ignored; `AUC_STALE` 30 min of no activity
  = missed grats. Watcher always forwards grats lines and keeps other /auction lines 45 min after the last opening.

## 5. Open items
- ~~`bot_timers` readable with the anon key~~ (owner: leave it).
- **(was) `bot_timers` is readable with the public anon key** (no sign-in). The owner was given
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
