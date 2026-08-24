# MixelParse — HANDOFF v1.5.3

**Session date:** 2026-08 (Ring 8 fetch fix · Gear Test Bench · ToD screen priority · kill-tracker header strip · /note quick actions)
**Version at end of session:** `1.5.3` (package.json bumped 1.5.2 → 1.5.3; in-app badge reads it at runtime)
**Prior handoff:** HANDOFF_v1.5.2.md (bind system + raid-parking integration + Velium stat fix — detail preserved there)

---

## ⚠️ READ FIRST — required actions before this build runs correctly

1. **No new SQL migrations this session.** The kill-strip `lastKillAt` stamp lives inside the existing `raid_sessions` jsonb — no schema change. If the 1.5.2 `bind_data` column was never confirmed, still run:
   ```sql
   ALTER TABLE guild_data ADD COLUMN IF NOT EXISTS bind_data jsonb;
   ```
2. **`package.json` is now `1.5.3`** — build produces `MixelParse-Setup-1.5.3.exe`. All of this session's work rides on 1.5.3 (no separate bump needed unless 1.5.3 already shipped).
3. **Live-verify the new /note quick actions** in-game: `/note sev new`, `/note dain add`, `/note statue fail`, `/note aa failnew` → confirm the toast fires and the kill/failtick lands in the right session (new vs. most-recent). Bare `/note sev` must still open the popup.
4. **ToD screen-priority caveat:** the popup float uses `alwaysOnTop('screen-saver')` — floats above windowed/borderless EQ, but **true exclusive-fullscreen** EQ can still occlude it (same limit as the session/map overlays). The taskbar flash is the fallback signal there.

---

## File placement map

| File (delivered) | Goes to |
|---|---|
| `index.html` | `src/index.html` |
| `main.js` | `electron/main.js` *(active entry — `require('./ipc/watcher.js')`; NOT the root `main.js` decoy)* |
| `preload.js` | `electron/preload.js` |
| `package.json` | repo root |

`watcher.js` was **not** touched this session (all /note quick-action logic is renderer-side). Active watcher remains `electron/ipc/watcher.js`; `mixelparse-watcher.js` is the decoy — never edit it.

Build: `npm run build` → `MixelParse-Setup-1.5.3.exe` (`artifactName` uses `${version}`).

---

## What shipped this session

### 1. Ring 8 auto-quake fetch fix (→ 1.5.3)
- **Root cause:** `wiki.project1999.com` sits behind Cloudflare; `ftFetchPage`'s bot-flavored UA (`MixelParse/1.3.5 …`) was getting a hard **non-200** (403/503), surfaced as the generic "— fetch failed." Page itself is fine and still parses.
- **main.js (`ftFetchPage`):** swapped to a browser UA + `Accept` / `Accept-Language`. Fixes the Ring 8 crawl **and** the Farm Targets crawl (same path).
- **index.html (`btAutoQuakeCheck`):** "Check now" now appends `r.error` → `— fetch failed: HTTP 403 / timeout / …` instead of a bare message, so future fetch failures self-diagnose.

### 2. Gear Test Bench (dev/admin harness)
- **Open:** Item Database modal → **🧪 Test Bench** (or `mpOpenTestBench()` in console).
- Drives the **real** character Stats render (`getEquippedItems → buildStatCards → line-~2385 breakdown`) via a **synthetic memory-only char** (`⚙ Test Bench`) — set class/level/base stats, add items per slot (pick from `itemDB` **or type a raw name**), optional per-item cache mode (`none` / `mirror DB` / `empty {}`).
- **Resolution audit** table (live): name-as-typed, length, stray-char flag, `itemDBGet` hit/miss, `itemDBGet(trim)` hit/miss, cache hit/miss, resolved WIS/HP → any row that dashes here dashes in the real breakdown.
- **Reproduces:** the stale-cache `{}` shadow (`empty` mode) and name-key mismatches (free-text). The bench char is **excluded from Supabase persistence** (filtered in `_seedCharSaveHashes` + `saveToSupabase`).

### 3. ToD popup screen priority
- **main.js:** new IPC `tod:surface` (`isMinimized→restore`, `showInactive`, `setAlwaysOnTop(true,'screen-saver')`, `flashFrame(true)` — **no focus steal**) and `tod:release` (drops always-on-top + flash). Same float level as `sessionWindow`/`mapWindow`.
- **preload.js:** bridged `todSurface` / `todRelease`.
- **index.html:** `_todShowNext` surfaces on show; `_todAdvance`/`_todSkipAll` release when the queue empties → the popup **stays above EQ until acted on** (no more "minimize the whole app to find it"). Web build no-ops (optional-chained).
- **Footgun removed:** the backdrop click on both the tick and boss modals used to call `_todAdvance()` (silently discarding a ToD). Backdrop click now does nothing — dismissal is explicit via Dismiss/Skip.

### 4. Kill-tracker quick summary (header strip)
- **`#ktKillStrip`** — an **absolutely-positioned** header layer (`left:58%`, grows right, `overflow:hidden`) so it never reflows the networth, title, or nav; sits clear of the Session/This Week toggle. Chips newest-first, newest highlighted green, capped **3 + "+N more"**.
- **Gate:** `_stripKillSession()` picks the most-recent raid session within **24h** with ≥1 killed boss (checks `lastKillAt` → `startedAt` → `date`); hides otherwise. `lastKillAt` is stamped on every killed mark (tracker `ktSetBossState` + both ToD writers).
- **Refresh hooks:** `ktUpdateBadge`, `saveSessionsToSupabase`, `renderKillsPanel`, `loadKillsFromSupabase` (startup).
- Position is a single `left:` value if it needs nudging.

### 5. ToD `/note` quick actions (no-prompt)
- **`_handleNotesUpdate`** strips a trailing `new|add|fail|failnew` word (must be a separate trailing word; `failnew` matched before `fail`), matches the boss on what's left, and routes to the new modal-free **`todDirectNote(target, action)`** instead of the popup.
  - `new` → **new** session, killed · `add` → **most-recent** session, killed · `fail` → most-recent, failtick · `failnew` → new session, failtick.
- **Behavior (per decisions):** creates a session if none exists; "most-recent" = latest `startedAt` (incl. current active), and that session becomes `activeSession`; **no roles, no tab jump, no popup** — feedback via toast + the header kill strip. Bare `/note sev` popup and `btNoteTod` spawn-timer advance are untouched. `/note set …` still parses first (no conflict).
- **Help:** the `/note INFO` reference gained a gold-accented **"Quick actions — skip the popup"** block documenting all four suffixes.

### 6. "Tuna" / "KT" items not showing — RESOLVED (self-resolved)
- Reported by a beta tester; could not repro locally (Alex lacks that gear, and we have no tester access). It **self-resolved** on the tester's side — cause unknown (most likely a stale/blank cache or behind `item_db` sync that an `applyDBToChar`/re-import pass overwrote). If it recurs, the **Gear Test Bench** now pins the failing layer in one screenshot.

---

## Architecture rules reaffirmed this session

- **Active entry is `electron/main.js`** (`require('./ipc/watcher.js')`) — the root `main.js`/`preload.js` are decoys. Never edit the decoys or `mixelparse-watcher.js`.
- **Reuse the real render path, don't re-implement.** The Test Bench drives `getEquippedItems`/`buildStatCards` via synthetic data rather than duplicating them — keeps it a true repro and avoids the index/admin mirroring burden.
- **Header chrome is all absolutely-positioned** (top-bar, `#networthDisplay` at `left:62%`, version badge, title block). New header elements must be their own absolute layer so nothing reflows.
- **No-prompt paths must not read modal DOM.** `todAddToSession`/`todStartNewSession` read the popup's dropdown + role checkboxes; the quick-action path uses `todDirectNote` (params only) instead.
- Anchored Python `rep()` patches with hard-fail on mismatch; `node --check` on extracted inline `<script>` blocks after every edit; deliver individual files via `present_files`, never zips; discuss before building.

---

## Open items / next session

- [ ] **Live-verify** the five shipped items (esp. /note quick actions + ToD float above EQ + kill-strip position on the real window).
- [ ] **DB-first stat-shadow fix** — *proposed, awaiting go.* Flip `buildStatCards` + breakdown from `charGear[name] || itemDBGet(name)` to `itemDBGet(name) || charGear[name]` so a statless cache entry can't shadow the DB. Lower priority now Tuna/KT self-resolved, but still valid hardening.
- [ ] **Manual weighted stats vs. Raider/Solo profiles** — decide one line or two (roadmap).
- [ ] Confirm `bind_data` column (carried from 1.5.2) if not already done.

### Carried forward (still open from prior handoffs)
- WinEQ2 crash on Win 11 24H2 (`STATUS_HEAP_CORRUPTION` in ntdll) — WinEQ2-free diagnostic inconclusive.
- Locked EQ log files: rotation reports "in use" with game closed (zombie eqgame.exe / companion tool suspected).
- `angry` paste alias (±3h36m window) unresolved.
- Ring War / Ring 8 / Ring 10 phase modeling deferred.
- Staff Sergeant Drioc missing from `CON_TARGET_MAP` (needs in-game `/con`).

## Roadmap

Canonical backlog, grouped by area. **★ = added 2026-08-18 · ✅ = shipped 1.5.3 cycle.** Checkbox = open.

### Spawn Timers / ToD
- [x] ✅ **ToD note — screen priority** — SHIPPED. Popup floats above EQ (`tod:surface`/`tod:release`, no focus steal) and stays up until acted on; backdrop auto-dismiss footgun removed.
- [x] ✅ **ToD note — add / new / fail** — SHIPPED as `/note <boss> new|add|fail|failnew` no-prompt quick actions (`todDirectNote`) + help docs. *(Manual in-app "add ToD" button still available as a future nicety if wanted.)*
- [ ] **PigParse timer integration** — with SMS notification.
- [ ] **Custom timers** — with SMS notification.
- [ ] **Discord integration for timers** — webhook alerts.

### Gear Planner / Stats
- [ ] ★ **Manual weighted stats** — user-set stat weights overriding class defaults. *Decide:* subsumes "Raider vs. Solo profiles" or sits alongside?
- [ ] **Stat weight profiles (Raider vs. Solo)** — presets + toggle; scope TBD.
- [ ] **Best in Slot vs. Realistic toggle** — true BIS (ND raid drops) vs. tradeable-only.
- [ ] **Resist set builder** — hit resist cap with minimum gear-score loss.
- [ ] **Upgrade path sequencing** — prioritized 3–5 upgrade order by score delta + accessibility.
- [ ] **DB-first stat-shadow fix** — flip cache/DB precedence in `buildStatCards`/breakdown (hardening; see Open items).

### Raid Consumes
- [ ] ★ **Customizable Raid Consumes (per-character)** — global default + per-char override `{hidden, added:[{item,qty}], qtyOverrides}` in the `characters` row; quantity targets; readiness via `getOverallStatus`. *Open:* where the "have" count comes from (inventory parse vs. manual); resolve added items through `itemDBGet`/`normItemKey`.

### Per-character trackers / checklists
- [ ] ★ **Spellbook checker** — learned vs. available spells/tomes per char. *Scope TBD:* data source.
- [ ] **Key & flag tracker** — per-char zone-access checklist.
- [ ] **Epic quest tracker** — per-char stage tracker, all 14 class epics.
- [ ] **Quest item flagging** — crawl wiki for quest ingredients, flag held components.

### Economy / analytics
- [ ] ★ **Networth AUDIT page** — line-by-line breakdown of what's mis-summing (zero/missing prices, troll-price defenses, stack divisors, excluded chars, price source).
- [x] ✅ **Kill tracker — quick summary** — SHIPPED. `#ktKillStrip` header strip (`left:58%`, grows right); newest-first chips capped 3 + "+N more"; 24h `lastKillAt` gate.
- [ ] **Camp Economics** — per-zone ROI leaderboard. *Designed/prototyped;* blocked on session cap, event timestamps, sparse XP%.
- [ ] **Combat log DPS parser** — DPS / healing / tanking from combat events.

### Platform / packaging
- [ ] **Mobile-friendly version** — *partially started* (`window._mob` + `@media(max-width:767px)`; only Plat Prices adapted).
- [ ] **Companion app** — standalone `MixelParse.exe` with onboarding.

### Resolved bugs
- [x] ✅ **Items from "Tuna" and "KT" not showing** — self-resolved (cause unknown; reproducible via Gear Test Bench if it recurs).

### Dev tooling (shipped)
- [x] ✅ **Gear Test Bench** — manual-equip harness driving the real Stats render + resolution audit; memory-only synthetic char.
- [x] ✅ **Ring 8 fetch fix** — browser UA in `ftFetchPage` + surfaced fetch error.

---

## Side note (non-code)
The **P99 solo rogue leveling guide** (`P99_Rogue_Solo_Leveling_1-60.md`) from the prior session is unrelated to the app and not part of the build.
