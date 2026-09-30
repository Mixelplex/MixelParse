# MixelParse — Handoff v1.5.20 (2026-09-29)

Supersedes `HANDOFF_v1.5.14.md` (kept for history — its 1.5.12–1.5.16 detail, the AC/ATK project notes and the
2026-09-26 session notes are still accurate). Start here, then read the code. Git history is the source of truth.

---

## 1. Standing rules (from the owner — also in Claude memory)
- **Never push `main` or a `v*` tag without the owner's explicit all-clear.** Main redeploys Pages; a tag publishes a
  GitHub release that every guild member auto-updates to.
- **Standing OK to install test builds** on the owner's PC. First check the newest `eqlog_*` files for raid activity
  (RAIDTICK / "Raid Tick" / tells the raid in the last ~30–60 min). If clear: stop MixelParse (it sits in the tray;
  `Stop-Process -Force` is normal) → `dist\MixelParse-Setup-<ver>.exe /S` → verify strings in
  `%LOCALAPPDATA%\Programs\MixelParse\resources\app.asar` → relaunch. If a raid is on, build but don't install; say so.
- **Don't bump the version per test build.** Rebuild at the current version; bump only when publishing.
- Never run `npm start` alongside the installed app.
- Desktop app is the focus, not the website/PWA. `src/admin.html` is a public troubleshooting tool by design.
- Gear Planner rules that are intended (don't flag): max-only linear haste, STA scored via HP, NO DROP excluded from
  buy lists.
- **The P99 wiki is the source of truth for weapon rankings** (owner, 2026-09-28): "people way more engaged in this
  content have run the numbers — our job is to make it make sense." Calibrate to it; explain residual misses.
  Warriors are excluded from that calibration on purpose (their picks are about threat and HP).
- Auto-Detect stays **watch-only** until it survives a couple of quakes / natural spawns live — no auto-add.
- Ask before writing to the shared Supabase `item_db` table. Never enter credentials (the owner signs in to
  GitHub / Supabase and runs SQL).
- No Discord self-bot / token login / automated use of the owner's Discord account — ruled out.
- Rejected ideas (don't re-suggest): auction watcher (Discord has one), raid night recap and exact gear preview
  (already exist), splitting index.html.

## 2. Version status
| Version | State | What |
|---|---|---|
| ≤1.5.16 | Published | see `HANDOFF_v1.5.14.md` |
| 1.5.17 | Published 2026-09-28 | Gear Planner Build/Target/Tradeable/🔒 locks/Proc% sort, 67 weapon proc fixes, utility proc values, worn regen, Watch List count option, Combat Skills row hidden |
| 1.5.18 | Published 2026-09-29 | Weapon ranking calibrated to the P99 wiki (details §3.1) |
| 1.5.19 | Published 2026-09-29 | Auto-Detect: guild-prefixed ticks, faction-hit + rampage/flurry evidence (§3.2) |
| 1.5.20 | Published 2026-09-29 | Guild DKP update + dated boss values (§3.3). Release run confirmed started; 1.5.19's finished OK |
| **local** | **Unpublished** | weight / encumbrance check + coins (§3.4), park-warning fix (§4). Installed on the owner's PC as a 1.5.20 test build. Publishing = 1.5.21 |

Release flow (owner's all-clear only): bump `package.json` + `package-lock.json` (3 occurrences), replace the
`WHATS_NEW` object in `src/index.html` (version, date, features, fixes), prepend a section to `release-notes.md`
("Everything from X and earlier is included:" then the old text), add a row here, commit, `git fetch` +
`git merge origin/main` (CI pushes "deploy src to docs" commits), `node tools/mp-check.js src/index.html`,
`git push origin main`, `git tag vX.Y.Z` + `git push origin vX.Y.Z`. `release.yml` builds/publishes;
`release-notes.yml` syncs notes. `gh` is NOT logged in — check runs via
`curl https://api.github.com/repos/Mixelplex/MixelParse/actions/runs?per_page=4`. Don't poll CI.

**For 1.5.21 What's New / release notes:** "Carried weight on the Stats tab — Weight row shows current / Max WT
(= STR), amber when close, red ⚠ when over; hover for the heaviest items and what to bank or move into a
weight-reduction bag. Coins: type them once on the Coins row; loot, splits, sales and purchases from your logs keep it
current (copper/silver only if you keep them); also a Coins column on the Food & Drink panel. Fix: the 'no toon parked' warning now matches the Raid Parking tab
(a character you don't have a tab for no longer counts as parked)."

---

## 3. This session (2026-09-28 → 29)

### 3.1 Weapon scoring, calibrated to the wiki (1.5.18) — `src/index.html`, near `PROC_DB` (~line 1644) and `weaponDpsScore` (~1830)
- **Proc units**: `procDps = ppm×procDmg/600` (damage per 0.1 s, same units as the swing ratio; ×10 = real DPS).
  Was /60 — 10× too heavy; buried SK 2H BiS under proc weapons. Weapon cards show real dps again.
- **`PROC_DOTS`**: every DoT proc from its wiki spell page, `[perTick, ticks, direct, targetOnly]`, max per-tick and
  max duration. Value per proc = direct + total × (1−e^−x)/x, x = procs expected within one duration (re-procs only
  refresh). Examples: Soul Consumption 50×5 (was 100), Boiling Blood 36×18 (was 36), Dawncall 125×6 **undead only**.
  Self-harm buffs (Berserker Madness, Call of Bones) excluded. Generated by `dotaudit.js` + `dottable.js`.
- **Proc level gate**: a proc above the character's level scores 0 (`WEAPON_PROC_LEVEL` — Innoruuk's Curse 50 —
  plus `_procLevel` from `WEAPON_PROC_FIXES`).
- **`PROC_BUFFS`** `{Avatar:[6 min, {Rogue:10, Monk:6, _:3}]}`: long self-buff procs valued by uptime
  (1−e^(−procs/min × minutes)) × dps-equivalent, not per proc. Rogue 10 is what makes Primal Velium Spear beat
  Massive Heartwood Thorn; SK needs < 5 so Primal Velium 2H stays under Palladius.
- **`WEAPON_BASH_2H`** {Innoruuk's Curse} + `BASH_2H_DPS = 2` (wiki: it can bash despite being 2H; bash base =
  skill/10 ≈ 20 at SK 200 ≈ 2 dps before stun/interrupt). Puts Inny above Narandi's Lance, below Petrified.
- **Hybrid 2H** (`HYBRID_2H_CLASSES` PAL/SHD/BRD/RNG): stats count × `HYBRID_2H_STAT_MULT = 0.005` in
  `effectiveGain` (was: stats ignored — since 1.2.0). Result SK L60: Palladius > Petrified > Inny > Narandi (wiki).
- **BUG FIXED — 1H damage bonus**: `lucyDmgBonus(delay, level, is2h)` — a 1H at delay ≥ 25 was getting the 2H table
  (+28 at L60 instead of +11). Affects all classes (Warriors too — it was a plain bug).
- **Backstab**: `backstabDps(dmg, lv)` = wiki Game Mechanics formula — max = floor(dmg × (skill×0.02+2)) × 2 ×
  maxExtra/100 (210/245/265/285 by level), min 1.5×lv from L51, ~10 s cooldown, average of min/max —
  × `BACKSTAB_WEIGHT = 0.3` (misses, positioning, mitigation). Was max(90, 4.5×dmg)/delay per swing.
  Also used as the opportunity cost for a rogue main-handing a non-piercer.
- **`WEP_STAT_MULT`** `{Rogue:0.05, Monk:0.005, Ranger:0.005}` — weapon-slot stat fraction (Ranger bows included);
  replaces the flat ROG/MNK 0.15. Rangers and Monks pick weapons almost purely on damage (wiki).
- **`NOT_IN_GAME`**: 37 items the wiki tags `{{Does Not Exist}}` (GM-event artifacts: Oakwynd 175/20 bow, Pride of the
  Legion, Crystal Claw of Veeshan, The Lifeguide …) never enter Gear Planner candidates.
- `BASH_2H_DPS`, `HYBRID_2H_STAT_MULT`, `BACKSTAB_WEIGHT` are `let` so the preview harness can sweep them.
- `window._upgGain` = the planner's own `effectiveGain`, exposed after a render (for ranking checks).
- **Wiki fit** (rank among all usable weapons, Velious raiding): ROG Mrylokar #1, PV Spear #4 > MHT #6; RNG Baton of
  Flame #110 → #5, War Bow of Rallos Zek #1 > Primal Velium bow #2; SK/PAL tops as wiki; WAR unchanged
  (Pride of the Legion gone). Adjacent-pair agreement: ROG 13→14/22, RNG 12→15/27, MNK 7→13/17.
- **MONK: the wiki monk lists are written worst-first** (owner, 2026-09-29). Pre-Planar, Pre-Raid and Raiding read
  reversed; Planar reads normally (Wu's Fist > Whitened Treant Fists); Kunark too mixed to tell. Read reversed:
  Gharn's Rock > Fist of Nature > Hammer of Battle; offhand Wurmscale > Baton > Sap/Dragonrib.
- **Known residual misses** (can't fix without breaking better-supported orders): SK L55 Soul Leech > Ashenbone Axe,
  PAL L55 Truvinan > Theologian Claymore, Monk 2H Facesmasher (more stats) > Shovel (dps 1.952 vs 1.977).
  Lower-tier wiki lists read like option lists, not strict ranks (Kunark ranger list opens with Jade Mace 9/18);
  pairwise agreement tops out ~60%. Hasted weapons (Claw of Lightning, Tolan's) rank by the character's existing
  haste (intended max-only haste), so calibration leaves them out.
- **admin.html mirrors**: `lucyDmgBonus(…, is2h)`, backstab formula ×0.3 (`_bsDps`), hybrid 2H ×0.005 and
  `_WEP_STAT_MULT_GC` in `gcScoreItem` are mirrored. **NOT mirrored in admin `_wdps`**: `PROC_DOTS`, `PROC_BUFFS`,
  bash, proc-level gate, `NOT_IN_GAME`, Target/Build logic. Admin stale test "damage bonus applies only to MH"
  updated to the (dmg+bonus)/delay model. Weapon DPS + Upgrades suites pass standalone; Custom Weights needs the app.
- Builds feature (Balanced / Max proc / Leveling): owner judged it low-use (2026-09-28). If revisited, the missing
  piece is absolute procs/min and proc dmg/min (current → with item) in the stat sheet and per candidate.

### 3.2 Auto-Detect (1.5.19) — `electron/ipc/watcher.js` `raidSignal()` (~line 925) + `src/index.html` `rkd*` (~11719)
- Misses reported: **Zlandicar** (2026-09-28, kill 17:04:31) and **Avatar of War** (2026-09-29, ~03:18).
- Zlandicar: the tick "Castle & Co. RAIDTICK - …" was never parsed — `RE_RT_TICK` allowed only a ≤4-char prefix.
  Survey of every log: 1,048 of 2,692 RAIDTICK channel lines missed. New pattern allows guild-name prefixes
  (Castle / &|and|n Co / "X Y Department" / short tag), "RAID TICK", RAIDTICKK; rejects questions (`?`) and chat
  words as prefix (need/who/was/…). +935 ticks; only 2 dropped (both questions). Test: `ticktest.js`.
- New evidence kinds: **faction** = "Your faction standing with X … got worse" (rank 4 = kill, time-of-death source)
  — ignored unless the same boss has other evidence (trash in Permafrost / Skyshrine hits Vox / Yelinak faction:
  backtest had 11 "Vox kills" in one day); **fight** = "X goes on a RAMPAGE / executes a FLURRY of attacks on …"
  (rank 2) — only if under way 90 s before the tick (a boss pulled right before a tick is the next pull).
- Ties are "ambiguous" only when the runner-up has ≥ 1/3 the evidence count.
- `RKD_RANK {slain:4, faction:4, enrage:3, land:2, fight:2, call:1}`, `RKD_BASIS` labels, `_rkdRaw()` shared.
- 6-month replay (`scansig.js` → `serve/sig-*.json` → preview `rkdImportScan`): all 255 previously attributed
  ticks keep their boss; +68 in-zone attributed (40 enrage, 18 rampage/flurry, 5 slain, 2 faction, 2 call,
  1 landed); ambiguous 19 → 7. Zlandicar = strong (faction hit, ToD 17:04:31); AoW = weak (rampage/flurry).
- Existing installs: Kill Tracker → Auto-Detect → **⛏ Scan logs** backfills ("No boss" rows re-evaluated, unseen
  ticks added). Still watch-only. Limits: needs a tick; guild-chat-only ticks when you're elsewhere have no local
  evidence.

### 3.3 Guild DKP update (1.5.20) — `BOSS_ROSTER` (~line 10050), `BOSS_ROLES` (~10210)
- Severilous + Gorenaire: Tier Five → **Four** (2.5 + 1.2, race FTE **25** — assumed Tier Four race value from
  Dracoliche; announcement only said "reward racers more", Tier Five was 15; camp 5).
- Klandicar, Sontalak, Zlandicar: Tier Four → **Three** (4 + 1.5, camp 8, no race FTE — same as Yelinak).
- Roles: PR Trainout 0.5 → 1; Low HP Train 1 → 2; Bonewalk 1 → 2 (announcement says "outside of minis" — the app
  has one Bonewalk role, Dozekar only); LTK Coth / Pets 1 → 2.
- **`BOSS_VALUE_HISTORY` + `bossValueOn(b, date)`**: boss kill values are looked up live, so raids dated before
  **2026-09-29** keep the old values in `sessionDkpTotal`, the session list totals and Credit Check
  `ccExpectedValue(target, date)` (else old kills would flag "credited 3.7, expected 5.5"). Role credits are stored
  with their value when recorded — no history needed. **Assumption: effective = announcement day** — change `until`
  if the guild says otherwise. Kill-row values inside a loaded *old* session still show current values (cosmetic).
- Open question for the owner: Bonewalk for minis (separate role at 1?), and whether 25 is the right Sev/Gore race FTE.

### 3.4 Weight / encumbrance check (LOCAL, unpublished — `9ca1d34`)
- **Rule, verified in game on Mixelems** (Curr WT 90 → 89 after moving Deep Cavern Toadstool ×15, Louie's ×15,
  Bloodstone ×20, ×18 into the 100% Darkwood Trunk; both readings exact):
  - a **stack weighs ONE item's WT whatever its count** (full-stack weights would have predicted −19);
  - a bag's weight reduction applies to its contents (bag itself full weight);
  - spell scrolls 0.1 (the wiki pages are spell pages with no WT line);
  - **coins: 40 coins = 1** (EQEmu: coins/4 tenths) — needed to reach 90 (334 coins = 8.3);
  - the display **rounds down**; Max WT = STR (buffed, capped 255).
- Mixelboom (53) fits within 1–2, but his inventory file postdates those screenshots and only his platinum is
  known, so it isn't a clean test. His earlier "deposit 100 pp, still 53" reading contradicts coin weight —
  unresolved; Mixelems is the reference.
- `src/item-weights.js` (new, 277 KB, loaded by `<script src="item-weights.js">`): `window.ITEM_WT` (11,120 items,
  tenths, 0 included so unknown ≠ weightless) and `window.BAG_WR` (49 bags). Generated from the wiki cache by
  `genweights.js`. Covers 770/835 carried rows across the owner's characters (rest weigh 0.0).
- `carriedWeight(charName)` (before `applyBaseStats`): excludes Bank/SharedBank, strips trailing `*` (summoned),
  returns `{tenths, wt, rows (heaviest first: worn / in-bag with reduction / bag shells), unknown, fullBags}`.
- Stats tab → POOLS & COMBAT → **Weight** row: `wt/maxWt` (amber ≥ 90%, red ⚠ over), "+coins" note, tooltip with the
  6 heaviest items, "Over by N — you move slower until you're back to X", and a move/bank suggestion that names
  every 100% bag the character carries (bags themselves excluded from suggestions).
- **Coins** (added 2026-09-30, local): P99's `/outputfile inventory` has no coin lines, and banking / destroying
  coins isn't logged. So the user types coins once (Stats tab → Coins row ✎ → `charMeta[name].coins = {pp,gp,sp,cp,ts,small}`,
  persisted in base_stats like `plan`) and every coin line after that is added: watcher `coinLine()` parses loot
  ("from the corpse"), splits ("as your split"), merchant sales / trades ("You receive … from X") and purchases /
  trainers / trades ("You give … to X"); zero unparsed coin lines in three characters' logs. Command `scanCoins`
  {chars:{name:sinceMs}} sums live/.old/archive logs after the typed time (queued if busy) → `coinScanResult`;
  live `coinLine` messages add after the scan (`coinLog[name].upTo` prevents double counting). `coinsFor(name)`.
  Copper/silver from the logs are only added with "I keep copper & silver" ticked (owner: most players destroy them);
  typed copper/silver always count. Weight row adds floor(coins/4) tenths. Verified: typed 40/202/55/37 → 90/115 exact;
  scan since 23:42 → +61p +129g +185s +172c (33 lines). Re-enter after using the bank.
  Also shown per character as a **Coins** column on the Food & Drink panel (`fdCoinChip`; "set on Stats" until typed).

---

## 4. Open items — full list

### Fixed 2026-09-30 (local)
- **"No toon parked" banner ignored Terror / Fear**: `btParkedInLoc` counted ANY roster character whose last zone matched,
  including log-only characters with no level/class (Gatherintods in Plane of Fear, Drachenburgh / Shakesburgh in the
  Feerrott — not the owner's toons, no character tabs). Now it uses `parkTargetStatus` (eligible toon parked or bound)
  for the location's `RAID_PARK_TARGETS`, same as the Raid Parking tab. Note: the parking roster still includes every
  log-only character (`knownWatcherChars`) as "?"-status candidates — they no longer suppress warnings.

### Small fixes (recommended next)
1. **Missing respawn timers**: Guardian of Takish 12h30m, Vilefang 1 day, Vaniki 122h (`BOSS_RESPAWN`, ~line 10160).
2. **Shared spawn-timer board is last-writer-wins** — `btEnsureLoaded` loads once, `btSave` writes the whole board,
   so a guildmate's update can be overwritten. Needs a merge-on-save (re-read, merge per boss by newest ToD) or
   per-boss rows.
3. **parkAck reset after a quake isn't saved.**
4. Magi P'Tasa sits in the "ToV Pulling" role list — DKP rule question for the owner.

### Approved features, not started
5. **Resist check** — each character's resists vs a raid target's needs; easiest upgrades from gear owned across chars.
6. **Corpse tracker** — deaths from logs: where / when / decay timer / rez window; corpse items count as inventory.
7. **Keys & flags board** — VP key, Sleeper's Tomb, ToV access … across characters (optionally guild).
8. **Loot alerts** — toast when a loot line matches a Watch List item or a Gear Planner pick.
9. **XP per hour by camp** — XP/hr per zone/camp at the character's level (complements the Leveling Guide).
10. **Tradeskill tracker** — levels from log skill-ups, components across mules, what can be made next.
- Not picked (2026-09-28): quest turn-in finder, epic progress tracker, zone companion.

### On hold / watching
- **Spawn timers from Discord — ON HOLD.** The timer bot's owner agreed to think about a read-only feed (JSON link /
  webhook / announcement channel / sheet). Nothing to build until they answer.
- **Auto-Detect — watch-only trial.** After a quake night, compare its log with what was tracked. Next step when
  trusted: pre-filled ToD prompts for Strong, pick-list for Weak/Ambiguous.
- **Session auto-start on a fresh PC — watch** (toast on a toon with no inventory file; mule auto-starts / CPU).

### AC / ATK (paused, see v1.5.14 handoff §AC/ATK)
- 12/13 AC refs exact. Open: caster buff AC, level < 20, spell ATK / no-weapon ATK edge cases (Plex −4, Mez +6).
- Still-wanted screenshots: Boom minus one AC-only item, Boom minus one AGI item, Mixelmedic + Skills window,
  optional Mixelshank without Ragebringer. Possible DB issue: Spiked Seahorse Hide Belt AC 0 vs wiki 10 — check
  the live row first; fix only with the owner's OK.

### Carried from older handoffs
- Owner's remaining wiki recommendations #4–8 (from the 1.5.9 recap).
- Consolidate smart routing · watcher de-level message · Fist Wraps override · LORE flags (Regal Band, Spirit
  Wracked Cord) · leveling bands/guide · spellbook checker · DKP normalization · WinEQ2 24H2 crash.
- `Upload.txt` / `session-upload.zip` are for web-chat handoffs only.

### Code debt noticed this session
- admin `_wdps` doesn't mirror `PROC_DOTS` / `PROC_BUFFS` / bash / proc-level gate / `NOT_IN_GAME` (§3.1).
- `PROC_DB` values for non-DoT procs were never audited against the wiki the way DoTs were (only DoTs got
  `PROC_DOTS`). A direct-damage audit (`dotaudit.js` style) would be cheap.
- `NOT_IN_GAME` comes from the local wiki cache (items fetched so far). Re-run the scan after the cache grows.
- Kill-row DKP inside an old loaded session shows current values (totals are dated correctly).

---

## 5. Environment, tools, data
- Node 24, Git (pushes via Git Credential Manager), `gh` not logged in. `npm ci` done.
- Build: `npx.cmd electron-builder --win --publish never` → `dist\MixelParse-Setup-<ver>.exe`.
- Syntax: `node tools/mp-check.js src/index.html` (and `src/admin.html`); `node --check electron/ipc/watcher.js`.
- **Editing**: `src/index.html` (~1.3 MB) has long single-line functions — use exact-anchor replacements (Edit tool,
  or a Node script asserting the anchor occurs exactly once; normalize CRLF and restore). `watcher.js` is CRLF.
  **Shell heredocs and `node -e` strip backslashes (`\b`, `\s`, `\d`)** — write scripts with the Write tool.
- Preview: `.claude/launch.json` (git-excluded) — `src-preview` serves `src/` on 5599; `test-data` serves
  `session-data-2026-09-29/scratchpad-main/serve` on 5600 with CORS. Starting `test-data` moves the tab to 5600 —
  navigate back to 5599. The app's login screen covers the page (don't sign in); call functions from JS instead.
  Servers get stopped by the app after a while — `preview_start` again.
- **Wiki ranking harness** (`serve/harness.js`): in the 5599 tab, `eval(await fetch('http://localhost:5600/harness.js').then(r=>r.text()))`,
  then `_meleeCheck([...])`, `_buildRows`, `_sweep2(cls, m, k)`, `_fullRank(cls, tier, slot, hand)`, `_raidReport()`,
  `_pairsReal([...])`. It loads `itemdb-now.json` into `itemDB`, renders a fake "Wikitest" character and scores with
  `window._upgGain`. Wiki lists: `meleebis.json` (ROG/MNK/RNG), `hybbis.json` (SK/PAL/RNG/BRD/WAR), `rmwbis.json`.
  Note: `_mbis.Monk` must be reversed for Pre-Planar / Pre-Raid / Raiding before judging.
- **Auto-Detect replay**: `rkdsim.js <log> "<from>" "<to>"` prints raid signals using the live watcher code;
  `scansig.js <watcher.js> <out>` mimics a 6-month scan → `serve/<out>.json`; feed to `rkdImportScan` in the preview.
- **Weight**: `wtfit.js <Char> <pp> <gp> <sp> <cp> [slots moved to a 100% bag]` checks the rule against an
  inventory file; `genweights.js` regenerates `src/item-weights.js`.
- Wiki fetcher + cache: `session-data-2026-09-26/scratchpad/wikifetch.js` (`fetchPages([...titles])`, cached in
  `wikicache/`, 11.5k pages).

### Session data outside git
- `C:\Users\Owner\Desktop\MixelParse-Source\session-data-2026-09-26\` — previous sessions (item_db snapshots,
  restore SQL, wiki cache + fetcher, audit scripts, EQEmu research). See v1.5.14 handoff.
- `C:\Users\Owner\Desktop\MixelParse-Source\session-data-2026-09-29\` — this session:
  - `scratchpad-main\` — harness/replay/weight/tick scripts above, `dots.json` (DoT audit), `procdots.txt`,
    `notingame.json`, `serve\` (itemdb-now.json, wiki BiS lists, sig-old/new.json, two inventory copies),
    `edit20–45.js` (the exact edit scripts applied, in order), `rel119.js` / `rel120.js` (release scripts to copy).
  - `scratchpad-early\` — earlier 2026-09-28 scripts: proc audit (`procdata*`, `proctables.txt`), BiS prep,
    weight v1–v3, Mixelems DEX planning, AC/ATK scripts (boom/mez/reaper/caster).

## 6. Characters referenced (owner's)
Mixelems (CLR 31, leveling toward specters at 40, DawnFire — Banish Undead proc), Mixelreaper (SHD 48),
Mixelboom, Mixelmez, Mixelmedic (raids; Castle & Co), Mixelshank (ROG), Mixelplex, Mixelflop.
Guild: Castle & Co (ticks usually "CA RAIDTICK …" or "Castle & Co. RAIDTICK …"; kills credited in ODKP).
