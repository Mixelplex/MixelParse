# MixelParse Session Handoff — v44

## Current Version
**1.0.29 (built)**. Next build: **1.0.30**.

## File Placement
| File | Destination |
|---|---|
| `index.html` | `src/` |
| `admin.html` | `src/` |
| `setup.html` | `src/` |
| `main.js` | `electron/` |
| `preload.js` | `electron/` |
| `watcher.js` | `electron/ipc/` |
| `mixelparse-watcher.js` | watcher root |
| `package.json` | repo root |

## Supabase Migration Required
```sql
ALTER TABLE guild_data ADD COLUMN IF NOT EXISTS price_exclusions jsonb;
```

## What Shipped This Session

### Networth — Persistent Price Exclusion List
- New `priceExclusions` global (stored as `price_exclusions jsonb` in `guild_data`)
- `loadPriceExclusionsFromSupabase()` / `savePriceExclusionsToSupabase()` — wired into `loadFromSupabase()`
- `buildNetworthData()` now returns an `excluded` bucket; excluded items skip price lookup
- Networth modal: 🚫 button on each priced row (uses `data-name` attribute + delegated listener to avoid quote conflicts with item names); clicking excludes, saves, re-renders in place
- Excluded section at bottom of modal with `✕ restore` per item
- Admin panel Networth Audit: same 🚫 / restore buttons, calls `A.excludeFromNetworth()` / `A.unexcludeFromNetworth()` via `window.opener`
- Admin `loadNetworth()` also updated to use same `t≥2` troll price defense as index.html (was still on old single-window lookup)

### Kill Tracker — Clear Button
- Each kill tracker row now has a `✕` clear button, visible only when killed or failtick is set
- Clears state, unchecks radios, resets DKP display, removes itself
- Works on both main boss rows and Big 3 extra spawn rows
- Uses `data-bosstgt` / `data-spawnkey` attributes + delegated listener

### Kill Tracker — HoT Named Mobs (Tier Eight)
Single `HoT Minis` bucket replaced with 6 individual entries:
- Casalen, Grozzmel, Krigara, Midayor, Tavekalem, Ymmeln
- All at `dkp:0.3, baseDkp:0.2, raceFTE:null, campFTE:null`
- Essedera and Lepethida remain ONLY at Tier Five (they are not HoT minis)
- All 6 added to `_NOTES_BOSS_LIST`, note alias map, `ALIAS_MAP` (INFO panel), and `mixelparse-watcher.js`

### Kill Tracker — Hate Minis (Tier Seven)
Single `Hate Minis` bucket replaced with 7 individual entries:
- Avatar of Abhorrence, Coercer T'vala, Grandmaster R'Tal, High Priest M'kari, Lord of Loathing, Master of Spite, Mistress of Scorn
- All at `dkp:0.5, baseDkp:0.5, raceFTE:1.5, campFTE:1`
- AB / Magi / Lord of Ire remain as Big 3 at their existing tiers (unchanged)
- All 7 added to `_NOTES_BOSS_LIST`, note alias map, `ALIAS_MAP`, and watcher

### /note Alias Cleanup
- **Magi P'Tasa**: aliases trimmed to just `magi`
- **Avatar of Abhorrence**: just `abhor` (removed `avatar of abhorrence` to avoid collision with Avatar of War)
- **Coercer T'vala**: just `coercer`
- **High Priest M'kari**: just `mkari`
- **Lord of Loathing**: `loathing`, `lord of loathing`, `lord`
- **Master of Spite**: `spite`, `master of spite`, `master`
- **Mistress of Scorn**: `scorn`, `mistress of scorn`, `mistress`
- **UDB** (Undead Bard / Trakanon): added to all three alias locations — `udb`, `undead bard`

### Kill Tracker — Tick Submissions + HoT Speed Bonus
- New `activeSession.tickSubmissions[]` array: `{id, desc, value, qty, speedBonus, dkp, submittedAt}`
- Each hourly tick row has a `Submit` button (dimmed when qty=0); clicking snapshots qty×value, resets counter to 0
- New **HoT — SESSION** panel section with Speed Bonus checkbox (+1 DKP) and `Submit HoT Run` button
- `sessionDkpTotal()` updated to include `tickSubmissions`
- Raid report shows each tick submission as its own `Tick Sub` row with timestamp and `✕` delete button
- `ktSubmitTicks(desc, value)`, `ktSubmitHoT()`, `ktDeleteTickSubmission(sessionId, subId)` — all on `window`

## Standing Rules (carry forward every session)
- Never guess EQ mechanics, item stats, proc values — always ask or verify from P99 wiki
- Run `node --check` after every watcher edit; validate JS before delivery
- Both `watcher.js` and `mixelparse-watcher.js` must stay in sync; `_NOTES_BOSS_LIST` in `index.html` must stay in sync with `NOTES_BOSS_LIST` in `mixelparse-watcher.js`
- Any scoring logic change in `index.html` must also be applied in `admin.html`
- Never write handoff or zip until explicitly requested
- Never package early; always confirm version before building
- Python heredoc scripts preferred over `str_replace` for strings with apostrophes or complex JS
- **File delivery rule**: always include explicit placement map (see top of this doc)
- `package.json` must always be included in deliverables

## Open Roadmap Items
- EQ log reader for automatic faction info updates
- Weapon stats for stat calc (melee/hybrid DPS scoring)
- Quest item flagging (P99 wiki crawl)
- Mobile-friendly responsive pass on `index.html`
- PigParse timer integration with SMS notification
- Custom timers with SMS notification
- Discord webhook alerts for timers
- Stat weight profiles: Raider vs Solo presets
- Best in Slot vs Realistic toggle
