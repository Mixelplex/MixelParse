# MixelParse — Handoff v1.6.6 (2026-10-02)

Supersedes `HANDOFF_v1.6.5.md`, which is kept for history. Its §3 still describes accurately the resist recorder, the
Keys tab and Sky corpses, raid parking, Auto-Detect's evidence, zone and Mobs up, and the Unknown ToD statuses.
Start here, then read the code. Git history is the source of truth.

---

## 1. Standing rules (owner — also in Claude memory)

### Pushing
- **Push or tag only on the owner's all-clear.** "push it" or "publish" means the full release flow in §2.
- **Pushing works through allow rules** in `.claude/settings.local.json` (git-excluded). They match exactly
  `git push origin main`, `git push origin v*` and `git tag v*`.
- **Run each of those as its own command.** Chained with `;` they don't match, and auto mode refuses them.

### Test builds
- **Installing test builds is pre-approved**, but run `node tools/raid-check.js` first, as its own step. Exit 1 means a
  raid.
- **The check only lists characters whose log had a line in the last 15 min.**
  - A character that was fighting and then went quiet can mean a crash. If the owner is visibly playing another
    character that isn't raiding, it's fine; ask if unsure.
  - On 2026-10-02 Mixelmez dropped off the list after midnight enrage lines while the owner was on Mixelems.
    "Do you not see me on Mixelems?": it was safe.
- **When the owner says "install", do it.**
- **Don't bump the version for test builds**; bump only to publish. Never run `npm start` alongside the installed app.

### Other rules
- The desktop app is the focus.
- The Gear Planner rules are intended; don't flag them.
- Ask before writing to Supabase `item_db`.
- Never enter credentials.
- **Clickies ignore item class lists.** The Class line limits equipping only.
- **Plane of Sky pays DKP but is never parked for.** The log zone name is "Plane of Air".
- **The resist recorder stays watch-only.**
- **Auto-Detect:** Watch mode never writes anything. Active mode does exactly what §3 describes; don't widen it without
  the owner asking.

## 2. Versions this session
| Version | What |
|---|---|
| 1.6.6 | Auto-Detect Watch / Active mode (Strong auto-add, Weak confirm, Pick / No-boss "which boss?"), /note double-count guard, nearest-tick skip |

**Release flow:** `session-data-2026-10-02/scratchpad/rel166.js` is the template. It:
- replaces `WHATS_NEW`;
- prepends `release-notes.md`;
- bumps the version in `package.json` (1 place) and in `package-lock.json`, **top-level and `packages[""]` only**.

Then:
1. Commit with `git commit -F <file>`; PowerShell 5.1 breaks commit messages that contain double quotes.
2. Run `git fetch` and `git merge origin/main`. CI pushes "deploy src to docs" commits.
3. Push main, create the tag, and push the tag, as three separate commands.
4. Check the build at `https://api.github.com/repos/Mixelplex/MixelParse/actions/runs?per_page=12` and
   `/releases/latest`; the release should have the exe, the blockmap and `latest.yml`.

## 3. Auto-Detect Watch / Active (index.html, the block starting "Auto-Detect modes (owner, 2026-10-01)")

### The switch
- **Where it is:** a WATCH MODE | ACTIVE MODE switch replaces the old "WATCH-ONLY" label at the left of the
  Auto-Detect header.
- **Where it's saved:** per PC, in localStorage `mp_rkd_mode` (`watch` is the default). That lives in
  `%APPDATA%\MixelParse\Local Storage` and survives relaunches, updates and uninstall; nothing in the app clears it.
- **The sub-option:** "Ask me about unsure ticks (Weak · Pick · No boss)" appears under the switch only while Active is
  on. It's stored in `mp_rkd_confirm`; anything but `'0'` counts as on, so it defaults to on.
- **The tally:** `mp_rkd_confirm_stats` counts auto, undone, confirmed, dismissed, failtick and noted. The ACTIVE MODE
  tooltip shows it.

### What happens on a tick
`rkdFinalize` calls `rkdActOnTick(row)` once the 2-minute evidence window closes. The gates:
- the mode is Active and the row hasn't been handled yet (`r.confirm` unset);
- the tick is **live**, under 10 minutes old, so scans and replays never act;
- `_rkdAttended(r)`: you heard it in OOC, a shout or raid chat (guild chat alone doesn't count);
- `_rkdRecordedCount(boss, tod||ts) === 0`: the kill isn't in the tracker already, for example from a /note.

What each tier does:
- **Strong → `rkdAutoAdd`.**
  - It records the kill on `_rkdSessionAt(when)`, the session covering that night. If there's none, it creates a new
    session dated to the kill.
  - A loaded working copy (`ktLoadSession`) of that session is marked too, so a later Save doesn't drop the kill.
  - It sets the spawn-timer ToD with `btNoteTod`, which is newer-wins like /note.
  - It marks the row `confirm:'auto'`, `autoSession` and `autoLabel`, and shows a toast.
  - Right-click → `rkdUndoAuto` removes the kill, including a #N extra spawn. It leaves the ToD.
- **Weak:** the normal kill dialog opens with `auto:true`, headed "AUTO-DETECT — CONFIRM KILL", with the evidence
  lines.
- **Pick / No boss:** `showRkdPickModal`, headed "WHICH BOSS?", offers the suggested candidates, the mobs up in the zone
  and a search over all bosses. `rkdPickBoss` then opens the kill dialog for the chosen boss.
- **Prompt resolution:**
  - **Confirm:** `rkdAutoResolved` → `confirmed`, and sets the ToD.
  - **Not a kill:** `todAutoDismiss` → `dismissed`.
  - **Failtick:** → `failtick`, with no ToD.
  - **Skip All:** marks every queued auto prompt `dismissed`.
- **Auto prompts don't call `todSurface`**, so they never pull the window over EQ. A toast says one is waiting.
- **Re-check before display:** `_todShowNext` drops a queued prompt as `noted` if the kill was recorded while it waited.

### Guards
- **/note after an auto-add.** In the /note handler, `_rkdAutoAddedNear(boss, ms)` (±30 min) turns the /note into a
  toast plus a ToD update instead of recording a #2. `fail` and `failnew` still go through.
- **Nearest-tick skip.** `_rkdKillNear(ms, selfId)` skips a Pick or No-boss prompt only when a session's `lastKillAt`
  falls within 20 min before to 5 min after the tick **and** this tick is the one nearest that kill. The owner's
  concern: "We have killed 2 mobs within 2 mins". The first version ("any kill within 20 min") swallowed 6 real kills
  in the replay.
- **Known limit:** sessions only store `lastKillAt`, so earlier kills that night can't explain a tick. This errs
  toward asking, which is the safe direction.

### Row markers
The tracker column shows "auto-added", "auto-add undone", "confirmed by prompt (picked boss)", "prompt: not a kill",
"prompt: failtick" or "/noted before the prompt".

## 4. Log replay (2026-10-02) — what Active would have done
Method:
1. `session-data-2026-10-02/scratchpad/simscan.js` replays every log through the current `watcher.js` `raidSignal`,
   tracking the zone per tick. It writes `sim-scan.json` and copies `Downloads/dkp-details (3).csv` as `sim-odkp.csv`.
2. Serve both through the `scratch-mock` launch config (port 5611).
3. In the preview, back up `rkdLog`, `odkpTicks` and `btState`, then set `btState={}` and `btLoaded=true`. Today's
   timers say nothing about past nights.
4. Run `rkdImportScan(ticks, evidence)`, then set `odkpTicks = parseDkpDetailsCsv(csv).ticks` and run
   `rkdOdkpMatches()`. Classify with the Active rules, then restore the backups.

Results: 736 ticks over 97 raid nights (May 6 – Oct 1). 247 were guild chat only and are ignored.

| Tier | Ticks | Result against ODKP |
|---|---|---|
| Strong (auto-add) | 261 | **221 right, 6 wrong**, 11 with a label that isn't a boss name (look right), 14 no ODKP credit, 9 after the export |
| Weak (confirm) | 67 | 57 right, 2 wrong, 5 paid as hourly, 3 not checkable |
| Pick / No boss (which boss?) | 161 | 65 real kills, 79 hourly or attendance ticks, the rest not checkable |

- **By evidence type:** slain was right 37 of 37, faction hit 10 of 10, enrage 174 of 180.
- **All 6 wrong Strong adds were enrage calls:** another named mob enraged near the real kill. Examples: Tormax during
  Dread, Dagarn during Kelorek Dar, Sevalak during Cazic Thule, Nevederia during Cekenar.
- **The 11 unclear Strong labels:**
  - Bazzt Zzzt kills that ODKP pays as "Plane of Sky (QueenBee kill)";
  - labels `odkpTickTargets` can't parse, such as "09-24 Vulak kill", "Vkill3", "VindiAM_09_01" and
    "Crusade 2 (Triggered Faydedar)".
- **The Pick list rarely had the right boss** (2 of 59 under the old count), because the replay ran without spawn
  timers. Live, Mobs up should do better.

## 5. Open items
- **Offered, not decided:**
  - Enrage-only Strong could prompt instead of auto-adding. That removes all 6 wrong adds but adds about 180 prompts.
    A middle option: prompt only when another named mob enraged within a few minutes.
  - Skip the "which boss?" prompt on hourly ticks: 79 of 161 in the replay. Check the tick wording first.
- `odkpTickTargets` misses labels like "09-24 Vulak kill", "Vkill3", "VindiAM_09_01" and "Crusade (Triggered X)".
- Undo leaves the spawn-timer ToD in place.
- Not yet observed live: Active mode on a real raid night. The tally will show it.
- **Carried from v1.6.5:**
  - log-gap warning (designed, not built);
  - ODKP labels as suggestions for hourly and zone ticks;
  - ToV and Western Wastes share one park location;
  - Mixelflop MR shows 119 in the app vs 80 in game;
  - the older items in v1.5.21 §4.

## 6. Side trip
The owner asked for every proc weapon: a private Artifact, "P99 Proc Weapons", at
https://claude.ai/artifact/PzdsondSKFss1oR5gMyBXo.
- It lists 299 weapons from the Sept 29 `item_db` snapshot, plus each proc's effect from `spells_us.txt`. Effect ids
  are columns 86–97, base 20–31, max 44–55, duration 17, resist type 85, resist modifier 147.
- The generators are `procs.js`, `procdata.js` and `proc-template.html` in the session-data folder.
- The owner closed it as a tangent; nothing is pending.

## 7. Session data
`C:\Users\Owner\Desktop\MixelParse-Source\session-data-2026-10-02\scratchpad` holds:
- `rel166.js` and `commit166.txt`;
- the Active-mode source block `rkdActive.js`, with `applyActive.js`;
- `simscan.js`, the log replay;
- the proc-weapon generators and page.

Previous sessions: `session-data-2026-09-26`, `-09-29` and `-09-30`.

**Preview gotchas:**
- The PWA service worker serves a stale `index.html`. Unregister it and clear `caches`.
- The login screen covers the panels, so test through `javascript_tool`.
- Stub `saveSessionsToSupabase` and `btSave` before exercising kill flows, so nothing reaches the shared database.
