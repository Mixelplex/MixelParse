## 1.6.3

- **Auto-Detect: add any boss** — the right-click menu on Kill Tracker → Auto-Detect has a search box over every boss in the roster: type a few letters, press Enter (or click), and the usual kill dialog opens for that tick's time. Works on "No boss" ticks too; a hand-picked boss is labelled "picked by hand".
- **Auto-Detect: zone + Mobs up** — every tick shows the zone it was taken in, and a new **Mobs up** column lists that zone's bosses that were up at the tick per the spawn timers (also offered in the right-click menu). It's information, not a guess. When the logs show no boss but a boss's ToD on the spawn timers lands right at the tick (20 min before to 5 min after), that boss is suggested as Weak (spawn timer). Older ticks get their zone from ⛏ Scan logs.

Everything from 1.6.2 and earlier is included:

- **Auto-Detect → Kill Tracker** — right-click a suggested kill on Kill Tracker → Auto-Detect and choose **Add to Raid Kill Tracker**. It opens the usual kill dialog (roles, session, Start New Session, failtick) with the session from that night preselected, and a new session is dated to the kill so that day's boss values apply. For a "Pick" row you choose which boss. Auto-Detect itself still adds nothing on its own.

- **Raid consumes: Eye of Zomm** — the Stalking Probe check now counts any Eye of Zomm: a **Stalking Probe** (5× instant), **Holgresh Elder Beads** (unlimited, 4s) or a **Clay Bracelet** (instant). All three click from inventory for any class; Wizards and Magicians pass on their own spell. Characters holding the beads no longer show ◐ Mostly Ready, and the Watch List follows the same rule.

- **Keys tab** — every raider's zone keys: Old Sebilis (Trakanon Idol), Veeshan's Peak, Sleeper's Tomb, Charasis and the Tooth of the Cobalt Scar, read from your inventory exports. Veeshan's Peak shows your progress — Trakanon's Tooth and each medallion's pieces (x/3) — and a finished set says "turn in". Hover any cell for what's missing, where it drops and who to hand it to. "✓ bank" means the key is banked.
- **Plane of Sky corpses** — any death in Sky (Key Master, a duel, anything) shows on the Keys tab with a countdown to decay (7 days) and the 3-hour rez window, and a banner counts down the last 24 hours. Sky keys vanish when you leave the zone or log out, so the app only shows keys it has seen: type `/outputfile inventory` in Sky before you die, or with your corpse open. Otherwise the corpse says "keys unverified".
- **Shorter menu** — **Raid Info** now holds Raid Parking and Spawn Timers, and **Bankers** holds Consolidate, each as its own sub-tab.
- **Raid Parking** — Plane of Sky is no longer listed: it pays DKP, but no one parks there.

- **Supplies panel** — the Food, Drink & Coins panel is now **Supplies** and adds a **Weight** column (carried / Max WT: amber when close, red ⚠ when over; hover for your heaviest items). Drag a character's name to reorder the rows (same order as your character tabs). Compact enough to sit beside two other panels.
- **Raid parking: port items** — a level-eligible character carrying a **Vial of Velium Vapors** counts as parked for Dain, and a **Lizard Blood Potion** for Plane of Fear (🧪 Can port). Items in the bank don't count.
- **Raid parking: gating home** — a character bound at a raid spot counts only if it can gate there: the Gate spell (CLR/DRU/SHM/NEC/WIZ/MAG/ENC) or a carried **Vial of Swirling Smoke**. Bound characters that can't gate are listed separately.
- **Carried weight fix** — weight reduction now applies to a bag's total, like the game: small items in 25% bags no longer round down to nothing.
- **Behind the scenes** — the app keeps a local log of spells resisted / landed on your characters (`resist-watch.jsonl` in the app's data folder) for future resist tools. Nothing is uploaded and nothing in the app uses it yet.

- **Carried weight** — the Stats tab shows your weight against Max WT (your STR): amber when close, red ⚠ when over. Hover it for your heaviest items and what to bank or move into a weight-reduction bag. Checked against the game: a stack weighs as one item, bag weight reduction applies to what's inside, 40 coins weigh 1.
- **Coins** — click a Coins chip on the **Food, Drink & Coins** panel (or ✎ on the Stats tab) and type your coins once. Loot, splits, merchant sales, purchases and trades from your logs keep it current, and coins count toward your weight. Copper and silver from loot are only added if you tick "I keep copper & silver". Banking isn't in the log — re-enter after using the bank.
- **Raid parking warning** — "no toon parked" now matches the Raid Parking tab: a character you don't have a tab for no longer counts as parked (Terror / Plane of Fear warns again).

- **Guild DKP update** — Severilous and Gorenaire move from Tier Five to Tier Four (race FTE 25). Klandicar, Sontalak and Zlandicar move from Tier Four to Tier Three, matching Yelinak.
- **Role values** — PR Trainout 0.5 → 1; Low HP Train, Bonewalk and LTK Coth / Pets 1 → 2.
- **Past raids keep their values** — raid nights before September 29 keep the old boss values, so session totals and Credit Check still match what ODKP paid at the time.

- **Auto-Detect catches more kills** — raid ticks posted with the guild name in front ("Castle & Co. RAIDTICK", "Castle and Co: Raid Tick", "CASTLE RAIDTICK") are recognized now. Before, about a third of ticks were never seen, so those kills had nothing to attach to. Run **⛏ Scan logs** once to fill in past raid nights.
- **Kill time from the faction hit** — for bosses with their own faction (Zlandicar and the other Velious dragons), "Your faction standing with … got worse" gives the exact second of the kill.
- **Long fights** — a boss's rampages and flurries count as evidence, so a tick posted mid-fight (Avatar of War) still finds its boss.
- **Fewer toss-ups** — two bosses only tie when both have real evidence; one stray line no longer makes a kill "ambiguous".
- **Trash faction hits ignored** — killing ordinary mobs in Permafrost or Skyshrine hits the Vox / Yelinak factions; that alone never counts as a boss kill.

- **Weapons ranked like the P99 wiki** — the Gear Planner's weapon picks were checked against the wiki gear lists and now follow them: Palladius > Petrified Heartwood > Innoruuk's Curse for Shadow Knights, Mrylokar's Dagger for Rogues, Baton of Flame and the War Bow of Rallos Zek for Rangers, Gharn's Rock for Monks.
- **Real DPS on weapon cards** — the dps next to a weapon is actual damage per second: swings, damage bonus and procs at your DEX. Proc damage was counting about 10× too much, which buried Shadow Knight two-handers under proc weapons.
- **Damage-over-time procs** — valued from their wiki spell pages. Many counted as a single tick (Boiling Blood 36 instead of 648; Soul Consumption 100 instead of 250). Dawncall counts against undead only.
- **Slow one-handers were overrated** — 1H weapons with delay 25 or more got the two-hander damage bonus (+28 instead of +11 at level 60).
- **Backstab** — follows the wiki formula and scales with dagger damage, so the higher-damage dagger wins.
- **Innoruuk's Curse can bash** — counted for Shadow Knights. Procs above your level no longer count (Soul Consumption starts at 50).
- **Avatar and stats on weapons** — Avatar (Primal Velium weapons) counts as a buff that stays up. Hybrid two-handers weigh stats a little instead of not at all; Rogues, Monks and Rangers judge weapons mostly on damage.
- **Items not in the game** — 37 items the wiki marks "Does Not Exist" (GM-event items like Oakwynd) are never suggested.

- **Gear Planner builds** — new toolbar options: **Build** (Balanced, Max proc, Leveling), **Target** (Any, Undead, Summoned) and **Tradeable only**. Max proc puts DEX first for your weapon's proc, even for casters and priests (e.g. a cleric with DawnFire against undead).
- **Lock gear you're keeping** — click 🔓 on any worn item in the Gear Planner to lock it; that slot stops getting suggestions everywhere in the planner. Your Build, Target and locks are saved with the character.
- **Sort by Proc%** — armor shows how many more procs its DEX gives; weapons show their proc damage per minute.
- **67 weapons had no proc** — procs missing from the item data are filled in from the P99 wiki for scoring (Baton of Flame, the Coldain Velium weapons, Dagarn's Tail and more). Buff and debuff procs (Avatar, Rage of Vallon, stuns, snares, tash…) now add value instead of zero, and worn regen (Fungal Regrowth) counts as HP.
- **Watch List counts, your way** — Watch List ⚙ → "When you have more than one": ✔³, ✔ (3), or just ✔.
- **Cleaner Stats tab** — the Combat Skills row is gone; skills are read from your logs automatically.

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
