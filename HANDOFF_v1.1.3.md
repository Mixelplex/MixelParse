# MixelParse Handoff — v1.1.3

## Current state
- Shipped version: **1.1.3** (built)
- Next build: **1.1.4**
- Repo: `mixelplex/MixelParse`, local clone `C:\Users\Owner\Desktop\MixelParse-Source\MixelParse\`

## ⚠️ Open bug — top priority for next session

**`/note rw` writes `killState['Ring War'] = 'killed'`, but `'Ring War'` is no longer a `BOSS_ROSTER` entry.**

### What happened
This session restructured Ring War from a standalone checkbox-attendance tracker into 4 individual killed/failtick boss entries under Tier Nine (`RW Readiness`, `RW Wave 1`, `RW Wave 2`, `RW Wave 3` — see "What changed this session" below). That migration was completed and works correctly **for the 4 new checkpoint-specific aliases** (`/note rw1`, `/note rw2`, `/note rw3`, `/note rwready`).

**What was missed:** `_NOTES_BOSS_LIST` still has the original general-purpose entry:
```js
{ target:'Ring War', full:'Ring War', aliases:['ring war','rw','ring'] }
```
This fires the standard kill-confirmation TOD modal (via `todEnqueue`/`showTodModal`), and confirming it writes `session.killState['Ring War'] = 'killed'`. But since `'Ring War'` was removed from `BOSS_ROSTER` during the restructure, this literal-string kill state is now an orphan:

- `sessionDkpTotal()`'s `killDkp` calc **iterates `BOSS_ROSTER`**, not `killState` directly — so `killState['Ring War']` is invisible to it and contributes **0 DKP**.
- The session summary / history list builds its `killed` array **directly from `Object.entries(session.killState)`** (not gated by `BOSS_ROSTER` membership), so `'Ring War'` still shows up in the "Kills" line — with `0 DKP` next to it, because the dkp lookup against `BOSS_ROSTER` fails silently.

This is the bug in the screenshot: a session showing `KILLS — Ring War — 0 DKP`.

### Where the relevant code lives (index.html)
- `_NOTES_BOSS_LIST` — around line 4412, the `{target:'Ring War',...}` entry
- `todEnqueue` / `showTodModal` / `todAddToSession` / `todStartNewSession` — the general kill-modal flow that any `_NOTES_BOSS_LIST` match (including this one) goes through
- `sessionDkpTotal()` — around line 5778, `killDkp` reduce over `BOSS_ROSTER`
- Session summary/history rendering — around line 6310+, builds `killed`/`failtickTargets` from `Object.entries(s.killState)` without checking `BOSS_ROSTER` membership first

### Decision needed before fixing
Alex, when we pick this back up, we need to decide what `/note rw` (the plain alias, no wave number) should actually *do* now that Ring War isn't a single entity anymore. Options to consider:

1. **Remove the plain `/note rw` boss-modal entry entirely** from `_NOTES_BOSS_LIST`, since the 4 checkpoint-specific aliases (`rw1`/`rw2`/`rw3`/`rwready`) are now the real way to log Ring War attendance. `rw`/`ring`/`ring war` aliases would simply stop matching anything.
2. **Repoint `/note rw` to one specific checkpoint** (e.g. treat plain `/note rw` as shorthand for Wave 1, since that's typically the first thing logged when the event starts) — would need to route through `todRWHandle('wave1')` instead of the boss-modal flow.
3. **Keep the modal flow but fix the data layer** — guard `killDkp` and the summary `killed` array so any `killState` entry with no matching `BOSS_ROSTER` row is filtered out / ignored, so at minimum the 0-DKP orphan entry stops appearing. This wouldn't restore Ring War's old generic-attendance behavior, but it would stop polluting the session summary. Doesn't really give `/note rw` a purpose though — just stops it from doing something visibly broken.

My read: **option 1 is probably cleanest** given the new architecture — drop the generic `/note rw` modal trigger, since `rw1`/`rw2`/`rw3`/`rwready` now cover everything it used to do, more precisely. But this is Alex's call since it affects raid-night muscle memory (if people are already typing `/note rw` out of habit, that's worth weighing against the cleaner data model).

Whichever direction we go, we should also add a defensive filter in the summary/history `killed` array build so any future orphaned `killState` keys (manual data edits, old saved sessions, etc.) don't silently show `0 DKP` again — i.e. filter `killed`/`failtickTargets` against `BOSS_ROSTER.some(b=>b.target===k)` before display, not just in `killDkp`.

---

## What changed this session (for context)

### Ring War restructure (the big one)
Migrated Ring War from a standalone attendance-checkbox panel (`RW_CHECKPOINTS`/`rwChecks`, fully separate from kill/failtick) into 4 real `BOSS_ROSTER` entries under Tier Nine, each with normal Killed/Failtick radios and an expandable role panel:

| Target | Full name | Killed DKP | Failtick DKP |
|---|---|---|---|
| `RW Readiness` | Readiness (before RW starts) | 1 | 0 |
| `RW Wave 1` | Beginning of RW / Wave 1 | 0.8 | 0 |
| `RW Wave 2` | End of Wave 2 | 1.2 | 0 |
| `RW Wave 3` | End of Wave 3 | 2 | 0 |

Each checkpoint exposes **Ninja Looter (NL)** (+0.2 DKP) and **Turn in Reward** (+10 DKP) as optional roles (previously these were tagged to the single `'Ring War'` target; now tagged to all 4 checkpoint targets in `BOSS_ROLES`).

Removed entirely: `RW_CHECKPOINTS` const, `rwChecks` session field, `ktRWCheck()`, the dedicated split-panel Tier Nine renderer, and the `'Ring War'` special-casing inside `rolesForBoss()` and `ktBossRoleToggle()`.

### New `/note` checkpoint aliases (working correctly)
- `/note rwready` or `/note rw ready` → marks `RW Readiness` killed
- `/note rw1` or `/note rw wave 1` → marks `RW Wave 1` killed
- `/note rw2` or `/note rw wave 2` → marks `RW Wave 2` killed
- `/note rw3` or `/note rw wave 3` → marks `RW Wave 3` killed

These go through `todRWHandle(key)`, which maps `key` → target via `RW_CHECKPOINT_TARGET`, sets `killState` directly, force-saves, and calls `renderKillsPanel()` for a full re-render (no dependency on the panel already being open). Mirrored in both `index.html` (`_NOTES_RW_MAP`, client-side fuzzy match for the Electron/IPC path) and `mixelparse-watcher.js` (`NOTES_RW_MAP`, server-side match for the standalone WS path, broadcasts `{type:'todRW', key}`).

**This part is confirmed working** — only the legacy plain `/note rw` (general boss-modal alias) is broken.

### HoT Farm Ticks (earlier this session — confirmed working)
- Added −/+/SUBMIT counter row (was previously a non-functional flat submit button)
- Fixed DKP calc: `qty + (speedBonus ? 1 : 0)` — was previously `speedBonus ? qty : 0` (paid 0 unless Speed Bonus was checked)
- Added `/note hotfarm` / `/note hot` alias → `todHotFarmHandle()`, increments qty by 1

### Hourly Ticks / Buff and Park / Bot Loot panel (earlier this session — confirmed working)
- Added per-role Ninjalooter checkboxes (+0.2 DKP/tick) to the 3 hourly tick rows, mirroring the existing Buff and Park pattern
- Added SUBMIT buttons to Buff and Park and all 3 Bot Loot tiers (previously only had live counters, no discrete submission/reset)
- Fixed `ktHourlyAdj` — was doing a broken partial DOM patch that compared display text (post `(hourly)`-strip) against the raw data string, so it silently failed to update the UI or enable Submit even though the underlying qty was correct. Now does a full `renderKillsPanel()` like every other adj function.
- Fixed scroll position — the right panel has its own `overflow-y:auto` scroll context separate from `window.scrollY`; clicking +/− was resetting scroll to top on every re-render. Now captures/restores the right panel's own `scrollTop`.
- Renamed "Buff and Parks" → "Buff and Park" (display label + tick submission desc)
- Widened the right panel and tuned `.kt-role-desc`/`.kt-role-val` column widths so DKP value / −0+ / SUBMIT line up across all rows (Buff and Park, Bot Loot, Hourly Ticks, HoT Farm Ticks all share the same flex layout now)

### Boss aliases added
- Eashen: `+ eash`
- Lady Nevederia: `+ ladyn`
- Ashenbone Broodmaster: `+ brood`

(Mirrored in both `_NOTES_BOSS_LIST` in `index.html` and `NOTES_BOSS_LIST` in `mixelparse-watcher.js`.)

---

## Standing rules (unchanged, still apply)
- Never guess EQ mechanics, item stats, proc values, or formulas — verify from P99 wiki
- Run `node --check` after every edit (note: doesn't work directly on `index.html` due to inline `<script>` extraction issues with this file's size — extract the script block manually or do targeted brace/paren balance checks instead)
- `watcher.js` (Electron) and `mixelparse-watcher.js` (standalone) must stay in sync for watcher changes — **for `/note` alias work specifically, `index.html`'s `_NOTES_*_MAP` consts and `mixelparse-watcher.js`'s `NOTES_*_MAP` consts must mirror each other**, since the Electron path does client-side matching off raw text while the standalone path pre-matches server-side
- Any scoring/stat-weight change in `index.html` must also be checked in `admin.html`
- Never write handoff doc or package zip until explicitly requested
- Never package early; always specify exact version number; always provide full updated `package.json` with version already bumped
- File delivery rule: `index.html`→`src/`, `admin.html`→`src/`, `setup.html`→`src/`, `main.js`→`electron/`, `preload.js`→`electron/`, `watcher.js`→`electron/ipc/`, `mixelparse-watcher.js`→watcher root, `package.json`→repo root
- `package.json` always included in deliverables
