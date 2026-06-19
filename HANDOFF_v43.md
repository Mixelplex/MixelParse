# MixelParse Handoff v43

## Session Summary
Continuation of v42 session. Networth troll price defense iterations, auto-fetch plat prices, CON regex KOS fix shipped.

## Current Version
**Shipped/built: 1.0.25** — Next build: **1.0.26**

## Files Changed This Session
| File | Destination |
|------|-------------|
| `index.html` | `src/` |
| `watcher.js` | `electron/ipc/` |
| `mixelparse-watcher.js` | repo root |
| `package.json` | repo root |

---

## Changes

### 1. Troll Price Defense — Transaction Count Filter
**Attempt 1 (v42):** Use `Math.min(a30, a60, a90)` across available windows. Didn't help — troll had listings across multiple windows.

**Attempt 2 (v43, 1.0.25):** Require `≥2 transactions` in a window before trusting its price. Single troll listings (t30=1) now fall through to "No WTS Data."

```javascript
const candidates = [
  [r.a30??-1, r.t30??0],
  [r.a60??-1, r.t60??0],
  [r.a90??-1, r.t90??0],
].filter(([price,cnt]) => price>0 && cnt>=2).map(([price]) => price);
if(!candidates.length) continue;
const price = Math.min(...candidates);
```

**⚠ KNOWN ISSUE — Fish Scales still inflating networth.**
The troll apparently has enough repeat listings that `t30 ≥ 2` is still satisfied. Next session needs a different approach — options:
- Raise the minimum transaction count (≥3 or ≥5)
- Cross-reference WTB price as a market floor sanity check
- Per-item manual exclusion list (user-maintained)
- Absolute price cap relative to item type / vendor value
- Flag items where WTS avg is > N× WTB avg as likely trolled

### 2. Auto-Fetch Plat Prices (shipped in v42, confirmed working)
- `fetchPlatData()` fires on app load (no await, background)
- Also auto-fires when Plat Prices tab opened if `platData` empty

### 3. CON Regex KOS Fix (shipped in v42, confirmed working)
- `scowls at you` now correctly captured as group 4 in RE_CON
- Both `watcher.js` and `mixelparse-watcher.js` in sync

### 4. Networth Modal — NO DROP Section Removed
- Removed NO DROP table from audit modal (just wasted space)
- Summary cards now: Est. Market Value / Priced Items / No WTS Data
- Priced items table max-height increased to 420px

---

## Known Issues / Next Session
- **Fish Scales troll price** — still inflating networth despite t30≥2 filter. Needs stronger defense next session.
- **Zlandicar** — not in CON_TARGET_MAP. Alex deferred — add if needed (CoV faction, Western Wastes dragon).

---

## Standing Rules (Reminder)
- File placement: `index.html → src/`, `watcher.js → electron/ipc/`, `main.js → electron/`, `package.json → repo root`
- Root-level `main.js`/`preload.js` are dead decoys
- Any scoring/stat weight change in `index.html` must also be applied in `admin.html`
- Both `watcher.js` and `mixelparse-watcher.js` must stay in sync for watcher changes
- Never guess EQ mechanics — confirm with Alex or cite wiki
- JS syntax validation after every edit: `node -e "new Function(...)"`
- Current shipped: **1.0.25** — Next build: **1.0.26**
