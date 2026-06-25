# MixelParse Handoff — v1.1.8 (Not yet built)

## Version
**Current shipped: v1.1.6.**
**Current in-progress branch: v1.1.8** (not yet shipped — this is what's in the session zip).
Next build will be **v1.1.9** — bump `package.json` before delivering.

## File Placement (always state explicitly on delivery)
- `index.html` → `src/`
- `admin.html` → `src/`
- `main.js` → `electron/`
- `preload.js` → `electron/ipc/`
- `watcher.js` → `electron/ipc/`
- `mixelparse-watcher.js` → watcher root
- `package.json` → repo root

---

## Changes in v1.1.8 branch (accumulated across sessions, not yet shipped)

### From prior sessions (v1.1.7 → v1.1.8)

1. **Admin Gear Checker — TWOHANDER slot** — added to `GC_SLOT_ORDER`; `GC_SLOT_DISPLAY` entry added
2. **Weapon DPS scoring audit** — 7 bugs fixed in `admin.html`: mana softcap condition inverted, 2H damage bonus power curve, H2H factor, DW chance for OH proc, `_itemType` fallback, OH ratio multipliers, gcCompare bonus formula
3. **Haste tied-value bug** — `>=` → `>` in three places (index.html `effectiveGain`, admin.html `gcScoreItem`, admin.html `gcCompare`)
4. **`2×dmg` ratio bug** — removed erroneous `2×` multiplier from ratio formula in both files
5. **Lucy damage bonus table** — hardcoded full table in index.html; admin.html uses `window.lucyDmgBonus` when connected, falls back to power curve standalone
6. **`dmg` weight promoted** — first-class stat in `CLASS_STAT_WEIGHTS`; `CLASS_WEAPON_DPS_SCALE` / `WEAPON_DPS_SCALE` removed
7. **Stat sheet haste display** — `upgRefreshStatSheet` now recomputes `proj.haste` as `Math.max()` across a per-item haste map rather than doing arithmetic delta
8. **Proc damage fallback bug** — `PROC_DB[effect] || 35` → `PROC_DB[effect] !== undefined ? PROC_DB[effect] : 35` in both files. Utility procs stored as `0` (Avatar, Haste, Root, etc.) were falling through to 35-damage fallback

### This session (v1.1.8 continued)

9. **2H mode — MH/OH slots show (none)** — greyed-out PRIMARY/SECONDARY cards in 2H mode now render `(none)` instead of the equipped weapon name and stats. `buildTotals()` and `upgRefreshStatSheet` cur-baseline loop both skip PRIMARY/SECONDARY items when `is2hMode` is active, so their stats (including OH haste) no longer pollute scoring or the stat sheet.

10. **2H mode — 2H card default is empty** — when toggling into 2H mode with a 1H weapon in PRIMARY, the 2H card now starts empty (scores all candidates from zero). Previously it patched in the 1H as "equipped" on the 2H card. A 2H weapon already in PRIMARY is still correctly detected via `_skill` field and used as the baseline.

11. **Admin gcSearch — TWOHANDER slot finds PRIMARY items** — item search in the Gear Checker compare pane now maps `TWOHANDER` slot to `PRIMARY` for DB lookup, since all weapons are stored with `_slot=PRIMARY`. Previously typing "narandi" with TWOHANDER selected returned no results.

12. **Shadow Knight stat weights** — STR bumped 2.5 → 4.0, DMG bumped 8.0 → 9.0. `CLASS_STAT_WEIGHTS` lives in `index.html` only; `admin.html` reads it via `window.CLASS_STAT_WEIGHTS`.

13. **`base_stats` JSONB bloat fix** — load destructure now also strips `factionValues` and `questData` from `bs` so they don't leak into `charMeta[cn].baseStats`. Save now only spreads `{stats, resists, pools}` from `baseStats` instead of the full object (which accumulated duplicate nested keys across save/load cycles). This was the likely cause of daily character class/level/stats resets — the JSONB payload was growing each cycle and eventually causing silent upsert failures.

14. **`twoHander` now persisted** — saved into `base_stats` JSONB on every save, restored into `charMeta` on load. Previously the 2H toggle was lost on every app restart.

15. **Supabase save error logging** — `saveItemDBToSupabase` now logs per-batch errors with exact batch range and error message instead of swallowing them. Continues saving remaining batches after a failed batch rather than aborting.

16. **Item DB load pagination** — `loadItemDBFromSupabase` now uses `.order('item_name')` for deterministic pagination. Previously unordered pagination could return inconsistent item sets across loads.

17. **Payload size guard** — `saveToSupabase` now `console.warn`s if any character's `base_stats` exceeds 50KB before upsert. Helps diagnose future bloat issues.

---

## Carry-Forward Notes

### Unresolved

**2H auto-detect for Supabase-only items (Meljeldin, Bane of Giants):** `twoHander` flag is now persisted so it survives restarts once set. But fresh character loads still default to 1H mode. Options:
1. Add these weapons to the item DB CSV with proper `_skill` field
2. Check Supabase `item_db` table for `_skill` field on those entries
3. UI hint when a weapon with dmg+delay sits in PRIMARY with no OH and unknown skill

**Item DB row limit:** Supabase `item_db` table was previously capped at 9000 rows. The 6-22 CSV load succeeded (11,123 items confirmed in app). Monitor on next restart — if `itemDBSources` drops back to 9000, the free tier row limit is rejecting overflow rows and the DB should be migrated to a single JSONB blob in `guild_data` instead of individual rows.

### Gear Planner Scoring
- `CLASS_STAT_WEIGHTS` for Magician, Necromancer, Wizard still unvalidated against P99 wiki
- Bard finding: CHA may be overweighted vs DEX — exists in local audit notes, not yet merged
- Shadow Knight STR (4.0) and DMG (9.0) are new this session — not yet validated against in-game data
- `_calcBonus` display sub-row in admin.html `gcCompare` still uses old formula (cosmetic only)

### DPS formula — remaining known approximations
- **H2H 0.9722 factor** — sourced from P1999 damage calculator, not independently verified
- **Backstab**: fires "roughly every 8s" is a simplification
- **`_wdps` standalone fallback** in admin.html still uses power curve when no app is connected (intentional)

### gcScoreItem softcap approximation
`gcScoreItem` uses full `baseTotals` including current slot item for softcap boundary. Fixing requires passing current slot's item into scorer — more involved refactor, carry forward.

---

## Standing Rules (carry forward every session)

- Never rename `target` keys in `BOSS_ROSTER` without a data migration plan
- `_NOTES_RW_MAP` in `index.html` and `NOTES_RW_MAP` in `mixelparse-watcher.js` must stay mirrored; same for `_NOTES_BOSS_LIST` / `NOTES_BOSS_LIST`
- Any scoring logic or `effectiveGain` change in `index.html` must also be applied to `admin.html`'s parallel implementations
- Re-read file sections immediately before every edit (line numbers shift in large files)
- Run `node --check` after every edit; extract inline `<script>` blocks from HTML first
- Python heredoc scripts preferred over `str_replace` for strings containing apostrophes or complex JS
- Never guess EQ mechanics, item stats, proc values, or formulas — always verify or ask
- Scoped CSS classes preferred over modifying shared base classes
- Never package/deliver files until explicitly requested by Alex
- Never bump `package.json` version on file delivery — only bump when Alex requests a build

---

## Open Roadmap

1. **Quest item flagging** — crawl P99 wiki for quest ingredients, flag held inventory items as quest components
2. **Mobile-friendly version** — responsive layout/UX pass
3. **PigParse timer integration with SMS notification**
4. **Custom timers with SMS notification**
5. **Discord integration for timers** (webhook)
6. **Stat weight profiles** (Raider vs. Solo) — toggle in gear planner
7. **Best in Slot vs. Realistic toggle** — true BIS (ND raid drops) vs. accessible/tradeable only
8. **Companion app** — MixelParse.exe standalone Windows executable with onboarding
9. **2H auto-detect for Supabase-only weapons** — see Unresolved above
10. **Validate `dmg` weights** — run real comparisons through Gear Stat Checker and tune per-class values
11. **`gcScoreItem` softcap refactor** — pass current slot's item into scorer to subtract its stat contribution
12. **`_calcBonus` display sub-row in admin** — update to use `window.lucyDmgBonus` for consistency
13. **Item DB storage migration** — if row limit resurfaces, migrate from per-row `item_db` table to single JSONB blob in `guild_data`
