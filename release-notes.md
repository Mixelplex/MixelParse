## 1.5.15

- **Credit Check layout** — back to a single kill table; the hourlies / HoT Farm / Buff & Park section is now optional (⚙ next to Export Report).

Everything from 1.5.14 is included:

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
