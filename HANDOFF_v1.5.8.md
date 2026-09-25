# MixelParse — Handoff v1.5.8

## Version status
- **1.5.8 PUBLISHED 2026-09-24** — https://github.com/Mixelplex/MixelParse/releases/tag/v1.5.8 (built by CI, notes from `release-notes.md`). Installed on the user's PC.
- Release flow now: bump version + update `release-notes.md` and the in-app `WHATS_NEW` constant → merge `origin/main` (Pages bot commits) → push main → push tag. `release.yml` has `contents: write` and sets the release-page notes; `release-notes.yml` re-syncs notes when the file changes on main. Don't push or tag without the user's all-clear.
- What's New splash shows once per version (`mp_whatsnew_seen`); Feedback shows a public "Already suggested" list via the `suggestions_public` view (id, created_at, subject, message — no emails). Admin panel still lists full submissions.
- Test flow: `npx electron-builder --win --publish never` → silent-install `dist\MixelParse-Setup-1.5.8.exe /S` over the user's copy (standing permission). Never run a dev `npm start` copy alongside the installed app.
- Note: releases v1.5.6/v1.5.7 were built from the old PC's uncommitted tree, so both tags point at stale commit `4e86dca`. The published 1.5.7 installer predates the 9/15 `index.html` edits — those ship in 1.5.8.

## Environment (clean-install PC, 2026-09-24)
- Node 24 LTS, Git, gh installed. `npm ci` done. Stray `build` dependency removed.
- Git pushes authenticate via Git Credential Manager (`gh` itself is not logged in).
- **electron-builder gotcha:** the winCodeSign cache fails to extract (macOS symlinks need admin). Fix: extract the downloaded `.7z` into `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0` excluding `darwin`. Already done on this PC.

## Supabase schema
Run by user 2026-09-24:
```sql
alter table guild_data add column if not exists price_overrides jsonb default '{}'::jsonb;
alter table guild_data add column if not exists consolidate_excl jsonb default '[]'::jsonb;
alter table guild_data add column if not exists consolidate_banker_excl jsonb default '[]'::jsonb;
```

---

## Shipped this session (1.5.8)

### Networth — manual price overrides — DONE (user-tested)
- ✎ on Priced and No-WTS rows sets a per-unit pp price; replaces the PigParse price in networth only (not session loot / itemDB.plat / admin Networth Audit).
- "manual" badge (tooltip shows market price); "Manual Prices" summary card; ÷ hidden on manual rows.
- Clear via **Use market price** button or entering 0.
- Per-user: localStorage `mp_price_overrides` + `guild_data.price_overrides` mirror.

### Native-dialog input freeze — DONE (needs soak)
- Electron/Windows bug: after `alert()`/`confirm()` inputs stop accepting keystrokes until the window re-focuses. New `window:refocus` IPC (main.js/preload.js) + alert/confirm wrappers in `index.html`, `admin.html`, `map.html`.
- `mpPromptNumber`: text input (commas OK), inline validation (no alerts), optional extra button.

### Gear Planner scoring — DONE (awaiting user check)
- `effectiveGain(cur, cand, totals, cardSlot)` scores against the **card slot**, not the item's stored `_slot` → RANGE-tagged daggers in MH/OH no longer skip the ROG/MNK ×0.15 suppression or get ranged DPS scoring. 2H card unchanged.
- Gear Test Bench (`admin.html`): breakdown rows apply the same ×0.15 (with badge) so they sum to WEIGHTED SCORE.

### Session auto-start on fresh PC — **WATCH**
- Root cause: `watcher.js` only tailed logs for characters with a `Name-Inventory.txt` in the EQ dir, computed once at startup. Clean PC had 5 → all other toons produced no login/XP/kill/loot events.
- Fix: every `eqlog_*_P1999Green.txt` is seeded to EOF at startup and tailed when it grows; logs created mid-run read from the top. Startup zone scan still limited to inventory-file chars. Installed build tracks 163 logs.
- Verified with a simulated fresh-PC harness only. **Watch in real play:** logging in on a toon with no inventory file (e.g. Mixelshank) should toast "Session auto-started". Also watch for: sessions auto-starting on mules/idol bots (now possible for every toon, same as the old PC), and any watcher CPU cost from polling ~160 logs every 2s.

### Raid kill auto-detect — **WATCH-ONLY (in trial)**
- Kill Tracker → **🎯 Auto-Detect** tab. Records suggestions only; never touches sessions.
- Anchor: `RAIDTICK` at the start of a guild/OOC/raid/shout message, **any poster** (officers are too many + volunteers; non-guild trackers post in OOC only). OOC+guild copies within 90s = one tick.
- Boss = kill-tracker `BOSS_ROSTER` only. Evidence window: 10 min before the tick (never before the previous tick) → 2 min after. Rank: slain > ENRAGED > landing (`glances nervously about` tash / `looks very uncomfortable` malo / `yawns`,`slows down` slow — from P99 spell pages) > debuff callout. Callouts count only if the tick was also in OOC. Name matching strips leading "The", treats ` as ', whole-word only.
- Tiers: **Strong** (slain/enrage), **Weak** (landing/callout), **Pick** (tie — often real double kills, e.g. AoW+Statue), **No boss**.
- Backtest (scripts were in the session scratchpad, not the repo): Mixelmedic history vs 50 recorded sessions — strong 65/66, weak 12/20 (user says some weak "misses" were real unrecorded kills). Finds ~44% of kills in sessions where the cleric saw ticks; misses are out-of-range/parked or other zones.
- Next: collect a few raids in watch mode → decide on pre-filled ToD prompts for Strong, pick-list for Pick/Weak, optional "which kill?" for No-boss OOC ticks.

---

### P99 wiki audit — 1.5.9 (PUBLISHED 2026-09-25: https://github.com/Mixelplex/MixelParse/releases/tag/v1.5.9)
Audit scripts lived in the session scratchpad (batched wiki API fetch, 50 titles/request, cached).
- **HP/mana:** `calcHP` now uses the classic class level factor (5 + L·F/10 + STA·L·F/3000); L·F/3000 reproduces all 28 wiki STA→HP values. Old flat 12.1·L base under-counted every non-caster (L60 WAR −1,079). `calcMana` = classic integer formula (slope 11.26/pt @60, wiki ~11.27). **Verified in-game:** Mixelmedic (CLR 52, STA 117, WIS 255) HP 1677 / mana 3288 match exactly; mana half-zone starts above 200 (not EQEmu 199). A tank/hybrid reading would confirm their factors too. Hybrid mana (PAL/RNG/SHD/BRD) unverified.
- **Dual wield:** L50 skill caps added; matches all 10 wiki chances.
- **Backstab (not changed — user's call):** wiki: max = dmg × (skill×0.02+2) × 2 × maxExtra, ~10s cooldown. App scores `(4.5×dmg ÷ delay) × 0.6`; dividing by delay undervalues slow high-damage daggers (backstab frequency doesn't depend on delay).
- **Buffs:** 37/40 matched spell pages; fixed Brilliance, Insight, Berserker Spirit.
- **Food:** P99 is not race-based (removed HFL/BAR/OGR/TRL 2×); Monks 2×.
- **Bags:** tomes 4→10; 64 containers added; 132/132 match.
- **Bosses:** in-game names added for auto-detect (a dracoliche, Master Yael, Kelorek`Dar, Guardian Kozzalym, Spirit of Garzicor/Garzicor's Wraith, An Undead Bard).
- **Quests:** 890/890 reward stats, 182/182 NPCs, 669/672 items match; Lyran's Mystical Lute note fixed (Silverwing, VP).
- **Items:** 409-item sample 96% → 100%. Deity split out of `_races` (444 items; 60 "ALL Deity" items were unusable by everyone); 37 Bard instrument mods + 36 slots added (instrument scoring never fired before); 7 item corrections. `_races` now overrides like `_classes`.
- Also: High Elf item-import files were tagged Half Elf.
- **Deity:** per-character selector (Stats tab), saved in base_stats.deity; enforced in Gear Planner, Outfitter, Test Bench. Unset = deity gear shown.
- **Auto-detect startup catch-up:** 6 h window, event-time pruning, 3 s settle (recovered a missed Vulak kill).
- Not done: displayed AC/ATK/Endurance use raw sums (in-game shows computed values: AC 922 vs 456, ATK 606 vs 198 on Mixelmedic) — next formula project.

---

## Open items
- [ ] **Publish 1.5.8** when user gives the all-clear (push `main` + tag `v1.5.8`).
- [ ] **HP/Mana formula audit** — suspects: 200 INT/WIS mana breakpoint, 255 cap, SK mana from INT, base (class/race/level). Needs a couple of real in-game HP/mana values to check against.
- [ ] **Consolidate** — smart routing (idols → idol bot, Reaper items → Reaper bot); missing bags in `BAG_SLOTS`; stackables over-counted.
- [ ] **Watcher** — de-level (XP loss) message not handled/verified.
- [ ] Fist Wraps stat override · LORE flags for Regal Band / Spirit Wracked Cord.
- [ ] Leveling: densify bands on request; Befallen undead CLR/NEC/PAL tags; guide directory (Phase 2).
- [ ] Carried: Spellbook checker / Manual weighted stats / Raid Consumes / Networth Audit sign-off · `normItemKey` networth decision · DKP normalization Phase 1 · WinEQ2 24H2 crash · `resmon` diagnostic.

## Deprioritized
- Website / PWA / Pages workflow — **not the focus** (desktop app is). `admin.html` is a public troubleshooting tool by design.
