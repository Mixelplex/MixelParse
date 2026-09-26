# MixelParse — Handoff v1.5.14 (2026-09-26)

Supersedes `HANDOFF_v1.5.8.md` (kept for history — its 1.5.8/1.5.9 detail is still accurate).
Start here, then read the code. Git history is the source of truth for what changed.

## Standing rules (from the user — also in Claude memory)
- **Never push `main` or a `v*` tag without the user's explicit all-clear.** Pushing main redeploys Pages; a tag triggers a public release + auto-update for the guild.
- **Standing OK to install test builds** on the user's PC: first check the newest `eqlog_*` files for raid activity (RAIDTICK / ENRAGED / tells the raid in the last hour). If clear → close MixelParse (CloseMainWindow, then force) → `dist\MixelParse-Setup-<ver>.exe /S` → verify `app.asar` contains the new code → relaunch.
- Never run a dev `npm start` copy alongside the installed app.
- Desktop app is the focus; the website/PWA is not. `admin.html` is a public troubleshooting tool by design.
- Gear Planner rules are intended — don't flag: max-only linear haste (Rogue 7.0/%, 41% goal), STA scored via HP, NO DROP excluded from Biggest Upgrades / Upgrade Path.
- Don't enter credentials. The user signs in to GitHub / Supabase and runs SQL themselves.
- Writes to the **shared** `item_db` table affect every user — ask first.

## Version status
| Version | State | Commit(s) |
|---|---|---|
| 1.5.8, 1.5.9, 1.5.10 | **Published** (tags on origin) | — |
| 1.5.14 | **Published 2026-09-26** (1.5.11–1.5.13 were local test builds, rolled in) | c2cc4c8 … 27e184f |

**Versioning rule (user, 2026-09-26):** don't bump the version per test build — rebuild/reinstall at the current unpublished version; bump once when publishing.

### Session 2026-09-26 (published in 1.5.14)
- Kill Tracker: repeat spawns for any boss (＋ per row; `/note` / kill modal add #2, #3 via `ktRecordBossState`).
- Credit Check: `ccMatchAll` one-to-one tick matching (kill prefers kill-value tick); ODKP labels resolve any roster name, backticks, truncation (`_odkpRosterName`); sessions dated local (`localYmd`, `sessionFixDate`, old date kept in `date0` for ack keys); reverse audit = unclaimed ticks, noise filtered.
- Hourly / HoT Farm / BnP ledger (`ccTickLedger`, per raid night 6am–6am, ±1 night offset).
- Auto-Detect: watcher `scanRaidTicks` (all logs, one batch) + `rkdImportScan`; ODKP CREDIT column (`rkdOdkpMatches`: ±15 min, second pass exactly ±1h same-boss); tracker column counts repeat spawns. On the user's data: 307 in-zone ticks, 281 credited, 15 not (Aug 13 raid, Midayor 8/20, Prog 9/5…); Auto-Detect boss agrees with ODKP 162/166.
- Faydedar added (Tier Eight 0.3+0.2, 7d ±8h). `/note`: timestamp stripped (`_noteBody` — fixed /note Quake!/set/timer and the "Oct"→CT bug), whole-word longest-first matching (`_noteBossMatch`).
- Admin → Credit Check suite rewritten (engine tests + LIVE run).
- Open from the review: missing respawn timers for Guardian of Takish (12h30m), Vilefang (1 day), Vaniki (122h); shared spawn-timer board is last-writer-wins (can lose guildies' updates); parkAck reset after a quake isn't saved; Magi P'Tasa sits in the "ToV Pulling" role list (DKP rule — ask the user). Next step offered: one-click "add to session" for Strong Auto-Detect suggestions.
- Release CI: `release.yml` (contents: write) builds + publishes and sets notes from `release-notes.md`; `release-notes.yml` re-syncs notes when that file changes on main.

## Environment (clean-install PC)
- Node 24 LTS, Git, gh (gh NOT logged in; git pushes use Git Credential Manager). `npm ci` done.
- Build: `npx.cmd electron-builder --win --publish never` (winCodeSign cache fix already applied — see v1.5.8 handoff).
- Syntax check for the big inline-script HTML files: `node tools/mp-check.js src/index.html` (also run on `src/admin.html`). Also scan for stray control characters after scripted edits.
- **Editing tip:** `src/index.html` is huge with long single-line functions. Use exact-anchor replacements (Edit tool, or a Node script that asserts the anchor occurs exactly once). Shell heredocs mangle `\n`, `\s`, `\b` — write helper scripts to files instead.
- Browser preview: launch config `src-preview` serves `src/` on port 5599. To test admin with app state, load admin.html in an iframe from index.html with `A = window.parent` (window.open is blocked in the pane).

## Session data saved outside git
`C:\Users\Owner\Desktop\MixelParse-Source\session-data-2026-09-26\`
- `scratchpad\` — full copy of the old session's scratchpad (11,342 files):
  - `itemdb-morning.json` — **pre-incident item_db snapshot** (before the 1.5.9 damage). `restore-7-items.sql` — restore SQL for the 7 damaged rows.
  - `wikifetch.js` (batched P99 wiki API fetcher, 50 titles/request, cached in `wikicache\`), `audit-*.js` (items, buffs, bags, bosses, quests), `gearac.js` / `wikiac.js` (gear AC per slot vs DB vs wiki), `atk.js`, raid auto-detect backtest scripts + JSON.
- `eqemu-research\` — `cm2013.cpp` (EQEmu `client_mods.cpp` as of Dec 2013: old `CalcAC` + `acmod` AGI table), `src-ac.js` (that formula ported to JS), `caster.js` (caster-variant search).
- `temp-helpers\` — small one-off edit scripts from this session (not needed; kept for reference).

---

## 1.5.12 — in-game AC / ATK (details)
- **Skills from logs:** watcher `scanSkillsAllLogs()` reads every log (+ `Logs\archive`, .txt/.old) for `You have become better at X! (N)` and keeps the max per skill. Runs 6 s after sign-in; admin can call `window.rescanSkills()`. Live `skillUp` events after that. Stored per character in `characters.base_stats.skills` (logs, only ever raises) and `skillsManual` (typed on the Stats tab COMBAT SKILLS row — wins over logs). Both are in the explicit save/load field lists (same lesson as deity).
- Logs can miss skills that never rose in the logged period (e.g. Mixelboom Offense/1H Blunt, Mixelmez Offense/Piercing; Mixelreaper Defense logs 200 vs 210 in-game) → user types them.
- Formulas in `index.html` after `calcMana`: `acAgiBonus`, `calcDisplayAC` → `{value, exact, why, parts}`, `calcDisplayATK`, `weaponSkillFor`, `charSkill`, `skillsApply`, `combatDisplayFor(name)` → `{ac, atk, inputs}`. Tables: `WORN_EFFECT_STATS`, `ITEM_WORN_EFFECT`, `CASTER_AC_CLASSES`.
- Stat sheet AC/ATK rows show these values with "≈" + tooltip breakdown when not exact.
- Admin: **Combat Check** tab (inputs, formula parts, type in-game values → diff, rescan button); Calcs suite has 8 in-game reference cases (`COMBAT_REFS`). Expected today: 0 fail, 4 warn.
- Fixed in passing: stat sheet crashed for a character with nothing in the primary slot.

## AC/ATK exactness project — PAUSED after Phase 1
Plan: Phase 1 source research (done) → Phase 2 in-game screenshots (user) → Phase 3 fit + lock in as tests → Phase 4 publish.

### Phase 1 findings
1. **Reaper "L≤50" gap was a bad test reference, not a level rule.** Hammered Golden Loop is **AC −15** (wiki confirms; he wears two). Reference used gearAC 200; correct is 170 → formula gives **846 = in-game exactly**. The app already reads −15 from the DB.
2. **ATK formula confirmed from source**: EQEmu `Client::GetTotalATK` uses exactly our constants — `worn×1.342 + offense×1.345 + (STR−66)×0.9 + primarySkill×2.69`, min 10, + spell ATK. Remaining ATK gaps are **input** problems.
3. **Mixelmedic ATK −14**: no ATK items/effects in his gear. 13.45 = exactly 10 Offense or 5 × 1H Blunt → his skill values were probably stale at reading time. Needs a Skills-window screenshot.
4. **Caster AC still open** (Boom +9, Mez +3 with our formula). Their gear AC matches the wiki item-by-item, so it's the formula. EQEmu 2013 caster branch (`def/4 + gearAC + 1 − 4`, spells/Iksar added after ×1000/847) fits **worse** (−40 / −59; its own comment says it's wrong). P99's server code is private and differs. None of 24 simple variants fits both → needs Phase 2 data.
5. **AGI bonus above 137:** EQEmu's table rises gradually (L40+: 138→51 … 240+→65); ours returns a flat 65. Ours matches Shank (145) and Flop (212) exactly, so **keep ours**; note it's only confirmed at L40+.
6. **Possible DB issue:** Spiked Seahorse Hide Belt showed AC 0 (wiki: 10) in a snapshot taken 2026-09-25 00:22. It's one of the 7 incident items that 1.5.10 self-heals, so **check the live row first** (Admin → Wiki Check → one item). Fix only with the user's OK.

### Phase 3 changes agreed but NOT yet applied
- `COMBAT_REFS` in `admin.html`: Mixelreaper `gearAC:200` → `170`.
- `calcDisplayAC`: drop the "level 50 and under" caveat; keep "≈" only below level 40 (AGI tiers untested there) and for casters.

### Phase 2 — screenshots still needed (Inventory window, all buffs off, one change per pair)
1. Mixelboom baseline · 2. Boom minus one AC-only item · 3. Boom minus one AGI item
4. Mixelmez baseline · 5. Mixelmedic baseline **+ Skills window** · 6. (optional) Mixelshank with Ragebringer removed

---

## Other open items (carried)
- **Session auto-start on fresh PC — WATCH** (watcher tails every `eqlog_*`; confirm toast on a toon with no inventory file; watch mule auto-starts / CPU).
- **Raid kill Auto-Detect — WATCH-ONLY trial** (Kill Tracker → 🎯 Auto-Detect). Next: collect a few raids → decide on pre-filled ToD prompts for Strong, pick-list for Pick/Weak.
- Backstab scoring rework — user's decision pending (wiki: damage doesn't depend on delay; app divides by delay).
- User's remaining wiki recommendations #4–8 (from the 1.5.9 recap).
- Consolidate smart routing · watcher de-level message · Fist Wraps override · LORE flags (Regal Band, Spirit Wracked Cord) · leveling bands/guide · spellbook checker · DKP normalization · WinEQ2 24H2 crash.
- `Upload.txt` / `session-upload.zip` are for web-chat handoffs only; working locally, read the repo directly.
