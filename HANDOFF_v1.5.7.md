# MixelParse — Handoff v1.5.7

## Version status
- Files are still stamped **1.5.6**. **Not yet bumped to 1.5.7** — stamp `index.html`, `admin.html`, `watcher.js`, and `package.json` when cutting the build.
- Everything below is staged on the tree, unbumped. Also still unbumped from 1.5.6: the Skyshrine account-wide holdings work.

## Files touched this session
- **`index.html`** — the bulk: Gear Planner scoring, item-data flags, Outfitter, the new Consolidate view, the new Leveling tab, and the watcher `levelUp` handler.
- **`admin.html`** — haste un-suppression mirror in `gcScoreItem`.
- **`watcher.js`** — level-up ding parsing.

## Supabase schema (optional — cross-device sync only)
Consolidate exclusions already persist via localStorage. For cross-device sync, add:
```sql
alter table guild_data add column if not exists consolidate_excl jsonb default '[]'::jsonb;
alter table guild_data add column if not exists consolidate_banker_excl jsonb default '[]'::jsonb;
```
Without these, exclusions still work locally; the Supabase mirror just no-ops (error is swallowed).

---

## Shipped this session

### Gear Planner / scoring
- **Priceless/Primal Velium weapons now register weapon DPS.** Added wiki-verified `_skill` to the 17 `ITEM_STAT_OVERRIDES` entries — without it, the class weapon-skill filter in `weaponDpsScore` returned 0 for restricted classes (Rogue/Monk). Also fixes 2H routing and dedup. **Closes the 1.5.6 "Priceless weapon DPS not registering" known bug.**
- **Weapon procs now score.** `ITEM_EFFECT_OVERRIDES` extended: Combust (Massive Heartwood Thorn), Feast of Blood (Mrylokar's Dagger of Vengeance/Blood, Zeriphra's Dagger of Blood). The crawler left these effect fields blank, so their biggest DPS source scored zero.
- **Haste un-suppressed.** Effective haste (up to the 41% cap) is now scored at full weight instead of the 0.15 pure-DPS stat suppression, in `effectiveGain` (index) and `gcScoreItem` (admin). Over-cap haste still scores 0 via the existing clamp.

### Item data flags — `applyPricelessPrimalFlags` (runs in `_rebuildItemDBIndex`)
- **Priceless/Primal Velium set → NO DROP + LORE**, except Fist Wraps (NO DROP only — dual-wielded, so can't be LORE). Name-matched (`/^(priceless|primal) velium\b/i`).
- **Hardcoded NO DROP**: Di'Zok Signet of Service, Regal Band of Bathezid, Spirit Wracked Cord (normalized name match, punctuation/case-insensitive).

### Outfitter
- Seeds class/race/level from the active character; **freezes on the first manual pick** so a twink plan survives tab switching.
- Holder attribution prefers the character you're viewing (fixes crediting an alt's copy when your own toon already wears it — impossible for LORE anyway).
- EQUIPPED badge is **green** (already on you) / **red** (on an alt, must strip).
- Pickup route excludes the toon you're building for.

### NEW: Consolidate view (top-nav)
Sweeps tradeable gear out of mains' banks onto bankers.
- NO DROP excluded (immovable — shown as "stays"). LORE distributed one-per-banker; a copy that can't be placed is flagged **LORE clash**.
- **Item affinity**: all copies of an item pool onto the banker already holding the most of it, spilling to the next-best when it fills.
- **Bag-capacity model**: `BAG_SLOTS` (wiki name→slots table) + `bankCapacity()` walker over 8 P99 bank slots — `free = Σ bag caps − items-in-bags + empty top slots`. Enforced with spill; unplaced split into **"no room"** vs **"LORE clash"**. Banker chips show `free/cap`; footer shows `used → projected/cap`.
  - **NOTE:** I first tried reading the inventory file's 5th column as the container Slots field — in this export it is **not** a reliable container-size field (it carries positive values for ordinary gear), which flagged every item as a bag and emptied the list. Reverted; capacity is now **table-only** by bag name.
- **Containers excluded from the sweep** — you move loot, not the bags (`bagCapacity(it) > 0` ⇒ skip).
- **Reaper/idol bots**: "Destination bankers" toggle chips exclude special-purpose bankers (they hold Reaper-quest items / Shiny Brass Idols only, and shouldn't receive random gear). Persistent.
- **Item exclusion** (✕ to exclude, ↺ to restore), persistent (localStorage + `guild_data` mirror).
- Clean **table layout** (Item · From · → To · ✕), grouped by source toon.

### Watcher — live level updates
- `watcher.js` parses `Welcome to level N!` → broadcasts `{type:'levelUp', charName, level}` → app updates `charMeta[char].level` (case-insensitive match), re-renders Stats/Leveling, toasts. **New dings only** (tail-read, no backfill). De-level (XP loss) not handled — message not verified.

### NEW: Leveling tab (character subtab)
Interactive Per-Level Hunting Guide (P99 wiki), character-aware.
- **82 spots covering levels 1-60.**
- Filters: class chips (14), Solo/Group/Both mode, Level / XP-mod sort (XP-mod breaks ties by level), search, Reset, "My class" quick filter.
- **Level-relevant by default**: shows only camps for the active character's level (their level within the range, ±3 grace); **"All levels"** toggle opens the full 1-60 list. ◆ marks camps the character's level sits squarely inside. On All Characters (no level), everything shows.
- Undead camps tagged **CLR/NEC/PAL** (skeletons→clerics rule): Kurn's Tower, Kaesora, Tower of Frozen Shadow, Trakanon's Teeth spectral camps, Lower Guk #13, The Hole Undead Crypt, Dreadlands skeleton wall, etc.
- Filters reset on character switch.
- **Era section removed** — no value on an end-of-timeline server (Green is at Velious / Chardok-revamp era; everything's unlocked).

### Roadmap cleanup (dropped — no longer needed)
Stat weight profiles (Raider vs Solo) · Best-in-Slot vs Realistic toggle · Resist set builder · Upgrade-path sequencing · DB-first stat-shadow fix.

---

## Open items (this session)
- [ ] **Cut 1.5.7** — stamp `index.html` / `admin.html` / `watcher.js` / `package.json` (also captures the Skyshrine holdings staged in 1.5.6).
- [ ] **Gear Test Bench display reconciliation** — the breakdown rows and "why wins" show *full-weight* points while the WEIGHTED SCORE applies the ×0.15 ROG/MNK weapon-slot suppression, so the columns don't sum. The score is correct; the display is misleading (`buildBreakdown` never applies the multiplier).
- [ ] **RANGE-tag stat-suppression** — `effectiveGain` scores weapons at the item's stored `_slot` (which can be `RANGE`) instead of the card slot, so RANGE-tagged daggers dodge the 0.15 and inflate. `admin.html`'s `gcScoreItem` already keys off the card slot; bring `effectiveGain` in line (thread `dbSlot` through its call sites).
- [ ] **Leveling**: dataset is *curated* (~82 spots), not every wiki row — densify specific bands on request. Location kept as the wiki's Zone/Area/Monsters split. Phase 2 **guide directory** (class/zone/route guide links, class/era-filtered) not built. Befallen 2nd/3rd-floor undead not yet CLR/NEC/PAL-tagged. Could add an upper-bound / lookahead knob.
- [ ] **Consolidate**: capacity is only as complete as `BAG_SLOTS` (an unrecognized bag reads 0 and its space undercounts — conservative); stack-merging not modeled (each line = 1 slot, so it over-counts for stackables); bank top slots hardcoded to 8 (P99 classic); smart-routing (idols→idol bot) and an "empty containers only" exception not built.
- [ ] **Fist Wraps stat override** (so they're scorable when owned) — not built.
- [ ] **LORE flags for Regal Band / Spirit Wracked Cord** — only NO DROP was set.
- [ ] **HP/Mana formula audit** — the app's totals are reportedly off; likely suspects are the **200 INT/WIS mana breakpoint**, the **255 stat hard cap**, SK-mana-from-INT, and the base (class/race/level) component. p99planner.com's changelog is a ready-made checklist of these exact edge cases.
- [ ] **p99planner.com** — reviewed; skip their code and 3D. The one reusable idea was **PEQ/EQEmu gap-fill** for item fields the wiki crawl misses; deprioritized since the manual overrides already cover owned gear (revisit only if new missing-flag items keep surfacing).

## Carried forward (from 1.5.6)
- [ ] **Fix `src→docs` workflow** to copy `manifest.json`, `service-worker.js`, `*.png` — **PWA install blocker** (paste the `.yml`, it's a one-liner).
- [ ] Mobile card-ify wide per-tab tables (Skyshrine especially).
- [ ] Skyshrine cross-character mat allocation (shared-pool budget is per-tab, not account-wide).
- [ ] Pending in-app test sign-off: Spellbook checker · Manual weighted stats · Customizable Raid Consumes · Networth Audit.
- [ ] `normItemKey` → live `buildNetworthData` decision (moves everyone's total) · DKP normalization Phase 1.
- [ ] Locked-EQ-log `resmon` diagnostic (awaiting findings) · WinEQ2 24H2 crash.

## Roadmap backlog (not started)
Key & flag tracker · Epic quest tracker · Quest-item flagging · Camp Economics (blocked: session cap / timestamps / sparse XP%) · Combat-log DPS parser · Leveling guide directory (Phase 2) · Web push for spawn timers · Optional custom domain · Companion `.exe` (largely superseded by the PWA).
