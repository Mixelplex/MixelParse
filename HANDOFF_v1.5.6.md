# MixelParse — HANDOFF v1.5.6

**Session theme:** Mobile/PWA — turned the web build into an installable Progressive Web App, did a mobile layout pass, sorted out GitHub Pages deployment, and reworked the Skyshrine gem tracker to be account-wide.
**Version at end of session:** `1.5.6` (package.json). Note: the **Skyshrine holdings** changes below are staged on this tree but were **not yet version-bumped** — bump to 1.5.7 when you cut the next build if you want them stamped.
**Prior handoff:** HANDOFF_v1.5.4.md (cert fix · spellbook · manual weights · customizable consumes · networth audit — detail preserved there).

---

## ⚠️ READ FIRST

1. **The PWA is not fully live yet — one deploy blocker remains.** GitHub Pages serves the **`docs/`** folder, and a `github-actions[bot]` **"deploy src to docs"** workflow mirrors `src/ → docs/`. **That workflow only copies the HTML files** (`index.html`, `admin.html`). So `manifest.json`, `service-worker.js`, `icon-192.png`, `icon-512.png` **never reach `docs/`**, and the service worker 404s on the live site. **FIX NEEDED:** edit `.github/workflows/*.yml` to copy the whole folder (json/png/js), or hand-copy those four files into `docs/` each push. Until then, the site loads but isn't installable.
2. **No SQL migrations.** All Skyshrine data (the manual "done" checklist) already lives in `base_stats.skyshrine`. Nothing new to migrate.
3. **The PWA files are web-only** — they belong in the Pages-published folder (`docs/`), **not** in the Electron bundle. The desktop `.exe` is unaffected by them.
4. **URL is case-sensitive:** `https://mixelplex.github.io/MixelParse/` — capital M, capital P. Typing it lowercase on a phone 404s. Hand out a tappable link, not typed text.
5. **GitHub Desktop broken-ref fix** (hit this session): if push fails with `bad object refs/remotes/origin/HEAD`, run in the repo: `del ".git\refs\remotes\origin\HEAD"` then `git remote set-head origin -a`.

---

## File placement map

| File | Desktop build | Web / PWA (GitHub Pages) |
|---|---|---|
| `index.html` | `src/index.html` | `docs/index.html` (via the bot) |
| `admin.html` | repo root | `docs/admin.html` (via the bot) |
| `manifest.json` | — (inert in Electron) | **`docs/`** ← not reaching it yet |
| `service-worker.js` | — | **`docs/`** ← not reaching it yet |
| `icon-192.png` / `icon-512.png` | — | **`docs/`** ← not reaching it yet |
| `package.json` | repo root | — |

You edit `src/`; the bot deploys to `docs/`; Pages serves `docs/`. Same `index.html` runs both as the Electron app and the PWA.

---

## What shipped this session

### 1. PWA conversion (→ 1.5.5)
The web build is now an installable Progressive Web App. **The decoupling was already done** — an audit found all **58** `window.MixelParseApp` touchpoints already guarded (`if(window.MixelParseApp && …)`, "web mode" fallbacks), so the app already loaded web-safe. Only the scaffolding was missing:
- **`manifest.json`** — `id: "mixelparse"`, `display: standalone`, parchment/gold theme, relative paths (`start_url:"./"`, `scope:"./"`) so it works at the `/MixelParse/` subpath and survives a repo rename.
- **`service-worker.js`** — network-first for the HTML shell (fresh build when online, opens offline), cache-first for CDN libs/fonts, and **Supabase always straight to network** (live data, never cached). Bump `CACHE_VERSION` on any shell change.
- **`icon-192.png` / `icon-512.png`** — placeholder MP monogram in the app palette; swap for real art anytime.
- **`index.html`** — added the manifest link, iOS home-screen metas, and an SW registration **guarded by `!window.MixelParseApp`** so it runs only in a browser, never in Electron (and never on `file://`). Desktop behavior is byte-for-byte unchanged.

### 2. Mobile layout pass (→ 1.5.6)
All inside the existing `@media (max-width:767px)` block — **desktop CSS untouched**. Fixes for the cramped phone view:
- `body{overflow-x:hidden;max-width:100vw}` — kills the phantom horizontal scroll / empty right gutter.
- `#factionBarsRow` → stacks the three city panels (Skyshrine/Kael/Thurgadin) vertically, full width.
- `#networthDisplay` → `position:static` so the networth stops absolute-overlapping the header buttons.
- `#ktKillStrip` → hidden on mobile (it pinned to `left:58%` and overlapped).
- `#watchlistBar` / `.watchlist-rows` → wide matrices scroll inside their own card.
- Still TODO on mobile: the **Skyshrine table** and a few other wide tables want a card-ify pass (see open items).

### 3. Skyshrine gem tracker — account-wide holdings (staged, unbumped)
The Skyshrine subtab now answers "do **we** have the mats, how many, who, and where" instead of only checking the selected toon's own bags.
- **`itemHoldings(itemNames)`** — totals an item across **every loaded inventory** (mains + bankers), returning `{total, holders:[{char,count,wheres}]}` with Bank/Bag/Equipped buckets. Uses the same smart-quote match as `charHasItem`; **excludes `isExcludedChar` toons**.
- **`ssHoldCell(itemNames, need, budget)`** — renders count · who · where inline, colored green (≥need) / amber (some) / red (none). `need` = 3 for gems, 1 for tattered.
- **Column scoping (important, learned the hard way):**
  - **Have It** (finished reward) → **per-character** (`charHasItem`, this toon only). The reward is no-drop, character-bound; showing another toon's completed piece was noise.
  - **Have Tattered** + **Have Gem** → **account-wide** (shared mats).
- **Shared mat pool** — the two wrist rows draw from **one budget** (`ssBudget` per render). With 3 opals: Wrist 1 = ✔ ×3, Wrist 2 = ✘ 0 left. Earlier rows claim their share; later rows see only the remainder. (Scope: budget is per-tab, not across characters — see open items.)

---

## Architecture / lessons this session

- **GitHub Pages:** serves from `docs/` (or root); **case-sensitive** paths; HTTPS automatic (required for service workers). The `<username>.github.io/<repo>/` URL always leads with the account name (`mixelplex`) — only a custom domain removes it.
- **`src → docs` deploy bot** exists but is **selective** (HTML only). Any non-HTML asset you add needs the workflow widened, or it silently never publishes.
- **PWA is web-only surface area.** The manifest link + SW registration added to `index.html` are inert in Electron (SW guarded by `!window.MixelParseApp`, manifests ignored, `file://` blocks SWs). So one `index.html` serves both homes with no desktop regression.
- **Component scoping matters in trackers:** account-wide is right for shared mats (gems, molds), wrong for character-bound rewards. When adding "who has X" anywhere, decide per-column whether the answer is about *this toon* or *the account*.
- Same discipline as always: mobile changes stay inside the media query; anchored Python `rep()` patches with hard-fail on count mismatch; `node --check` every inline `<script>` after every edit; one file per deliverable via `present_files`; discuss before building.

---

## Open items / next session

- [ ] **Fix the `src → docs` workflow** to copy `manifest.json`, `service-worker.js`, and `*.png` (or the whole folder). **This is the blocker** for a real "Add to Home Screen" install and for the SW to stop 404ing on the live site. Paste the `.yml` and it's a one-line fix.
- [ ] **Mobile card-ify the wide tables** — the Skyshrine subtab table especially (7 columns), plus any others that still need a horizontal scroll on a phone. The layout pass fixed the top-level views; per-tab tables are the remaining polish.
- [ ] **Skyshrine cross-character mat allocation** — the shared-pool budget is currently **per-tab**. Two clerics viewed separately each see the same 3-opal stack as enough for their wrist 1. A true account-wide reservation across every toon's Skyshrine needs is a bigger feature; flagged, not built.
- [ ] **Verify Skyshrine gem *names*** against the wiki if a real held gem ever shows ✘ — the scope bug is fixed, but gem-name accuracy per class was never audited.
- [ ] Optional: **custom domain** (e.g. `mixelparse.com`, ~$12/yr) to drop the `mixelplex.github.io/MixelParse/` path and username.

### Known bugs to investigate
- [ ] **Priceless weapon DPS not registering in the Gear Planner** *(reported, not yet diagnosed)* — a weapon with no plat price ("priceless" / no PigParse data) isn't contributing its DPS/`dmg` weight to the Gear Planner's upgrade scoring. Likely the scoring path gates the weapon on having a price (or an item-DB entry) before applying `weaponDpsScore` × the `dmg` weight, so unpriced weapons score 0 on their damage. Start at `weaponDpsScore` and the `dmg`-weight application in `renderUpgradesPanel` (~line 2803, `const dmgW=weights.dmg`), and check whether an unpriced/priceless weapon ever reaches that branch.

### Carried forward (still open)
- The four **1.5.4 features still pending in-app test sign-off**: Spellbook checker, Manual weighted stats, Customizable Consumes, Networth Audit.
- **`normItemKey` → live `buildNetworthData`** decision (the audit quantifies the name-match undercount; applying it moves everyone's total).
- DKP normalization Phase 1 (de-risked, `normItemKey` exists); locked-EQ-log `resmon` diagnostic; WinEQ2 24H2 crash.

---

## Roadmap

**★ = 2026-08-18 additions · ✅ = shipped · 🟡 = shipped, pending test sign-off.**

### Mobile / PWA *(new track this session)*
- [x] ✅ **Installable PWA** — manifest, service worker, icons, guarded registration
- [x] ✅ **Mobile layout pass** — top-level views (header, city bars, watch list, tables)
- [ ] **Fix src→docs workflow** so the PWA assets deploy *(blocker)*
- [ ] **Mobile card-ify wide per-tab tables** (Skyshrine, etc.)
- [ ] **Web push** for spawn timers (needs a cloud-side timer trigger; solid on Android, best-effort on iOS)
- [ ] Optional **custom domain**

### Gear Planner / Stats
- [~] 🟡 ★ **Manual weighted stats** *(pending test)*
- [ ] **Stat weight profiles (Raider vs. Solo)** — *likely redundant now* · [ ] **BiS vs. Realistic** · [ ] **Resist set builder** · [ ] **Upgrade path sequencing** · [ ] **DB-first stat-shadow fix**

### Raid Consumes
- [~] 🟡 ★ **Customizable Raid Consumes (per-character)** *(pending test)*

### Per-character trackers / checklists
- [~] 🟡 ★ **Spellbook checker** *(pending test)*
- [x] ✅ **Skyshrine gem tracker — account-wide holdings** *(this session; excluded-toon filter + per-char reward + shared wrist pool)*
- [ ] **Key & flag tracker** · [ ] **Epic quest tracker** · [ ] **Quest item flagging**

### Economy / analytics
- [~] 🟡 ★ **Networth AUDIT** *(pending test)* · [x] ✅ **Kill tracker — quick summary**
- [ ] **Camp Economics** (blocked: session cap, timestamps, sparse XP%) · [ ] **Combat log DPS parser**

### Packaging
- [ ] **Companion app** (`MixelParse.exe`) — *note: the PWA now covers most of the "mobile companion" intent*

### Dev tooling / resolved
- [x] ✅ **Ring 8 cert-chain fix** · [x] ✅ **Gear Test Bench** · [x] ✅ **Custom Weights + Networth admin validators**

---

## Identifier index (this session's additions)

- **PWA:** files `manifest.json`, `service-worker.js`, `icon-192/512.png`; `index.html` head metas + `!window.MixelParseApp`-guarded SW registration; `CACHE_VERSION` in the SW.
- **Mobile:** all new rules inside `@media (max-width:767px)` — `#factionBarsRow`, `#networthDisplay`, `#ktKillStrip`, `#watchlistBar`, `.watchlist-rows`, `body{overflow-x:hidden}`.
- **Skyshrine:** `itemHoldings(itemNames)`, `ssHoldCell(itemNames, need, budget)`, `ssBucket(loc)`, `ssBudget` (per-render shared pool). Reward column uses `charHasItem` (per-char); gem/tattered use `ssHoldCell` (account-wide). Data still in `base_stats.skyshrine`.
