# MixelParse — Handoff v1.5.8

## Version status
- `package.json` is **1.5.8**. **Built and installed locally only — NOT published.**
- Local `main` is ahead of `origin/main`; nothing pushed, no `v1.5.8` tag. Do not push or tag until the user gives the all-clear (pushing `main` redeploys the Pages site; pushing a `v*` tag triggers `release.yml` → public release + auto-update).
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
