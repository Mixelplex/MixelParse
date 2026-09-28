## 1.5.17

- **Gear Planner builds** — new toolbar options: **Build** (Balanced, Max proc, Leveling), **Target** (Any, Undead, Summoned) and **Tradeable only**. Max proc puts DEX first for your weapon's proc, even for casters and priests (e.g. a cleric with DawnFire against undead).
- **Lock gear you're keeping** — click 🔓 on any worn item in the Gear Planner to lock it; that slot stops getting suggestions everywhere in the planner. Your Build, Target and locks are saved with the character.
- **Sort by Proc%** — armor shows how many more procs its DEX gives; weapons show their proc damage per minute.
- **67 weapons had no proc** — procs missing from the item data are filled in from the P99 wiki for scoring (Baton of Flame, the Coldain Velium weapons, Dagarn's Tail and more). Buff and debuff procs (Avatar, Rage of Vallon, stuns, snares, tash…) now add value instead of zero, and worn regen (Fungal Regrowth) counts as HP.
- **Watch List counts, your way** — Watch List ⚙ → "When you have more than one": ✔³, ✔ (3), or just ✔.
- **Cleaner Stats tab** — the Combat Skills row is gone; skills are read from your logs automatically.

Everything from 1.5.16 and earlier is included:

- **AC matches the game for every class** — checked against the in-game Inventory window on six characters (11 readings). Wizards, Magicians, Necromancers and Enchanters now count gear AC and Defense the way the game does; their AC was off before. AC below level 50 is no longer marked approximate.
- **Watch List counts** — the green ✔ stays in line with the rest of the column, with the count beside it when you have more than one: ✔ (3).

Everything from 1.5.14 and 1.5.15 is included:

- **Credit Check layout** — single kill table; the hourlies / HoT Farm / Buff & Park section is optional (⚙ next to Export Report).

## ✨ New

- **Auto-Detect checks your DKP credit** — every RAIDTICK you were in zone for is matched to your ODKP ticks by time: ✓ credited or ✗ not credited. **⛏ Scan logs** loads the last 6 months of raid nights from your logs, and "only not credited" shows just the gaps. (Upload your ODKP dkp-details export on Credit Check first.)
- **Hourlies, HoT Farm and Buff & Park in Credit Check** — an optional section (turn it on with the ⚙ next to Export Report) that compares what you tracked with what ODKP credited, night by night.
- **Repeat kills** — quakes and GM events can spawn a boss more than once a day. Use the ＋ next to any boss for #2, #3…; a second `/note` for the same boss adds another spawn instead of overwriting the first. Credit Check needs one ODKP tick per kill.
- **Faydedar** — added to the Kill Tracker (Tier Eight, 0.3 + 0.2), spawn timers (7 days ±8h), and `/note faydedar` / `fayd` / `fay`.
- **AC and ATK like the game** — the Stats tab shows AC and ATK the way the in-game Inventory window does, using combat skills read from your logs.
- **Watch List and Inventory quantities** — Watch List shows how many you have; Inventory totals follow your search and filters.

## 🔧 Fixes

- **`/note` in October** — notes are matched on what you typed, not the log timestamp. "Oct" would have turned every note into Cazic Thule from October 1. `/note Quake!`, `/note set` and `/note timer` work again.
- **`/note` picks the right boss** — whole names only: Severilous no longer lands on Sevalak, Mistress of Scorn on Essedera, or Avatar of Abhorrence on Avatar of War.
- **Credit Check matching** — Dagarn, Vilefang, High Priest M'kari and cut-off ODKP names now match; each ODKP tick counts once; raids started in the evening are no longer dated the next day.

## 💬 Feedback

Have an idea or found a bug? Use **Feedback** in the app's top bar.
