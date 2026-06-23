# MixelParse Handoff — v1.1.9 (Not yet built)

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

### This session (v1.1.8 continued)

7. **Stat sheet haste display** — `upgRefreshStatSheet` now recomputes `proj.haste` as `Math.max()` across a per-item haste map rather than doing arithmetic delta. Fixes phantom haste values when swapping non-haste items while a haste item is equipped elsewhere.

8. **Proc damage fallback bug** — `PROC_DB[effect] || 35` → `PROC_DB[effect] !== undefined ? PROC_DB[effect] : 35` in both `weaponDpsScore` (index.html) and `_wdps` (admin.html). Utility procs stored as 0 in PROC_DB (Avatar, Haste, Root, Fear, Ensnare, etc.) were falling through to the 35-damage fallback because 0 is falsy. Primal Velium Fist Wraps was showing ~21 dps instead of the correct ~13.1 dps.

---

## Carry-Forward Notes

### Unresolved

**2H auto-detect for Supabase-only items (Meljeldin, Bane of Giants):** Still not resolved. The `twoHander` flag is persisted in `charMeta` — once manually toggled it sticks. But fresh loads still default wrong. Options:
1. Add Meljeldin to the item DB CSV with proper `_skill` field
2. Check Supabase `item_db` table for `_skill` field
3. UI hint when a weapon with dmg+delay sits in PRIMARY with no OH and unknown skill

### Gear Planner Scoring
- `CLASS_STAT_WEIGHTS` for Magician, Necromancer, Wizard still unvalidated against P99 wiki
- Bard finding: CHA may be overweighted vs DEX — exists in local audit notes, not yet merged into delivered report
- Weapon `dmg` weights are proposals — not yet validated against observed in-game data
- `_calcBonus` display sub-row in admin.html `gcCompare` still uses old formula (cosmetic only, does not affect scoring). Could be updated to use `window.lucyDmgBonus` for consistency.

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
