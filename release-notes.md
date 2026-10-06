## 1.7.7

- **🌼 Flowers** — new Flowers tab in the top bar for the five Flowers of Functionality (Deck of Spontaneous Generation, Plane of Mischief): +50 resist clickies that work from inventory. One card per flower: the four cards it needs, how many your characters hold of each and who ("1 - Mixelboom"), who can combine now and who already has the flower. Card Prices shows PigParse prices for all 16 cards and what each flower costs in cards. Hover a card for where it drops.
- **⚖ Auctions on / off** — a checkbox under ⚖ Auctions in the header. Unticked ("Auction disabled") switches auctions off completely: no auction window, no pop-up, no outbid or Grats toasts, and the ⚖ Auctions button greys out.
- **Fix: Guardian of Takish** level requirement is now 60, the same as Tunare (was 55).

Everything from 1.7.6 and earlier is included:

- **Raid Parking: new Castle level requirements** — Raid Parking now follows the Castle Alliance level policy update; a character only counts as parked if it meets the new level.

  | Raid | Before | Now |
  |---|---|---|
  | ToV (7-day targets) | 58 | **60** |
  | Dain Frostreaver IV | 55 | **60** |
  | King Tormax | 55 | **60** |
  | Lord Yelinak | 55 | **60** |
  | Veeshan's Peak | 60 | **60, no class exceptions** |
  | Sleeper's Tomb | 55 | **58** |
  | Plane of Fear (competitive) | 55 | **58** |
  | Plane of Hate (competitive) | 55 | **58** |
  | Ring War | 55 | **58** |
  | Derakor the Vindicator | 55 | **58** |
  | Velketor the Sorcerer | 55 | **58** |
  | Wuoshi | 55 | **58** |
  | Kelorek'Dar | 55 | **58** |
  | Vaniki | 55 | **58** |
  | Trakanon | 55 | **58** |
  | Venril Sathir | 55 | **58** |
  | Gorenaire | 55 | **58** |
  | Severilous | 55 | **58** |
  | Talendor | 55 | **58** |
  | Faydedar | 55 | **58** |
  | Klandicar, Sontalak | 60 | 60 |
  | Statue + Avatar of War, Tunare, Zlandicar | 60 | 60 |

  Class exceptions (Cleric 52, Bard 55, Mage 55) now apply to every raid except Klandicar, Sontalak and Veeshan's Peak — before, most raids only had Cleric 52. Fear and Hate farm nights stay at 55; ToV practice, progression and Halls of Testing stay at 58.
- **⚖ Auction window, rebuilt** — bigger text (A− / A+ to size it), and each auction shows just the top 2 bids plus yours. The clock shows how long it's been running; an auction stays open until the officer's Gratss, then shows the winner(s) and folds into the Closed list. Click any item for its P99 wiki page. The window remembers its size and spot.
- **Auto-Detect level check** — a tick shows "⚠ under level" when the character you were on was below Castle's floor for that boss. A note only; it never changes the tick.
- **Auto-Detect: No kill, no credit** — right-click a tick for an attempt that wiped with no failtick before a round 2. Nothing is recorded, the round-2 kill counts as the first (not "#2"), and Credit Check stops flagging it.
- **Fix: Your DKP in the header** now matches the Credit Check and updates whenever the Credit Check syncs.

- **⚖ Live auction window** — pops up on its own when an officer opens an auction in /auction, without taking focus from EQ. One card per item: the clock, the item's DKP History prices, every bid with the bidder's current DKP and RA (⚠ red when they bid more than they have), and a "You've been outbid" alert. It only reads /auction; it never bids for you. ⚖ Auctions in the header opens it any time.
- **⚔ Your DKP in the header** — your ODKP balance next to Est. Market Value, with when ODKP last updated it. Hover for raid attendance; click for the Guild DKP list.
- **👥 Guild DKP** — DKP History → Guild DKP: every account's balance and 30 / 60 / 90-day and lifetime attendance. Search any character; an alt finds its main.
- **DKP History: who's buying** — each sale shows the buyer's current DKP and RA, alts show their main ("Fentin (Frown)"), and a click on the raid opens its ticks, items and who was credited.
- **Fix: DKP History dates** read normally again (1.7.3 showed raw timestamps).
- **Fix: raid names** no longer end in cut-off Discord links.

- **🔄 DKP straight from ODKP** — no more exports: DKP History (every item sale + the item DKP prices) and your Credit Check ledger sync themselves from Castle's ODKP at sign-in and every 2 hours. Credit Check finds your ODKP account from your characters and shows whose it is ("synced from ODKP · Frown's account (9 characters)"). ⟳ Sync from ODKP pulls now; CSV upload stays as a fallback.
- **Factions: right-click to set** — right-click any faction chip (Skyshrine, Kael Drakkel, …) to set that character's standing, or Not Set. A newer reading from your logs still wins.
- **DKP History: wiki links** — item names open the item's P99 wiki page in your browser.
- **Spawn Timers: quakes removed** — the Ring 8 quake check, /note Quake! and "up since quake" are gone; the Discord bot's timers replace them. Bosses with no ToD show as ❔ Unknown.
- **Fix: DKP balance** — a tick credited to two characters on one account is counted twice, as ODKP does; balances now match ODKP exactly.

- **Auto-Detect: faction hit = ToD** — when a kill-faction hit lands for the boss (the moment it dies), that is the ToD on every tick, not only on Weak ones. A kill ticked before the boss died now gets its real time. ⛏ Scan logs corrects ticks already in the list; auto-added and confirmed kills move their spawn timer too.
- **Auto-Detect: failed attempts show up** — a boss talking in your zone ("Fright says …", "… You will not evade me") counts as Weak evidence, so a failtick on a boss you were near is a Weak suggestion (and an Active-mode prompt with Failtick) instead of No boss. A tick posted only in guild chat counts as yours when your character logged that boss's own lines in the zone.

- **Raid Parking: bind age** — the Bound here line shows how old each bind is and where it came from ("/char today", "bind cast 11 days ago"), amber when over a week old.
- **❔ Unknown timers** — a boss with no ToD, or more than 12 hours past its window with no new ToD, shows as Unknown in amber, never green and never counted as up. Raid Parking shows "timer unknown" for those locations and lists the unknown bosses on cards like ToV / WW.
- **Fix: binds made while MixelParse was closed** — at startup each character's log is read back to its last bind (/charinfo, or a bind cast and its zone), so a missed rebind no longer leaves an old bind in place.
- **Fix: Auto-Detect spawn-timer suggestions** — only for ticks you were at, in a raid zone, and only that zone's bosses.

- **🤖 Spawn timers live from the Discord timer bot** — the Spawn Timers board follows the guild's Discord timer bot automatically: every ToD the bot records shows up in MixelParse within minutes, no tracker paste needed. A ToD newer than the board's replaces it; your own newer /note, quake or Dead mark still wins. The status line on Raid Info → Spawn Timers shows how many timers came in and when the bot last synced.
- **Everything uses the live timers** — Mobs up, the raid-parking warnings and Auto-Detect's spawn-timer checks all read the same bot timers, so a "which boss?" tick can be named from the bot's ToD.
- **Simpler Spawn Timers** — the manual Log quake, Add ToD and Clear board controls are gone. Quakes are still picked up automatically (Ring 8 wiki, hourly) and from /note Quake!, and right-click a boss to set a ToD.

- **Auto-Detect: zone-aware** — a tick only counts boss lines from the zone it was called in. Porting, a /q to another character or a relog no longer carries one fight into the next tick (a Kael Tormax rampage used to name the Dread tick in Fear).
- **Auto-Detect: faction hit confirms the kill** — a Weak tick (calls, rampage or spell landings on the boss) with a kill faction hit in the same zone between 3 minutes before and 2 minutes after the tick is now Strong; its ToD is the first faction line, skipping hits from a trash kill in the same second.
- **Auto-Detect: one fight per tick** — a boss's lines in the 2 minutes after its own tick belong to that tick and can't name the next one.
- **Auto-Detect: /q after the tick** — a tick followed within 5 minutes by a login (/q to another character, relog) with no kill line seen is marked "/q or relog after the tick — kill not seen". Its suggestion is unchanged.
- **Scan logs re-judges** — ⛏ Scan logs upgrades ticks you haven't answered yet when the current rules give a stronger suggestion; answered or auto-added ticks keep theirs.
- **Fix: Dracoliche** is listed under Plane of Fear (was ToV / Western Wastes) for Raid Parking, Mobs up and Auto-Detect.

- **Auto-Detect: Watch / Active mode** — a per-PC switch on the Auto-Detect tab. Watch (default) is unchanged: suggestions only. Active acts on live raid ticks you were at: Strong kills are added to the Raid Kill Tracker automatically and set the spawn-timer ToD (right-click the tick → Undo auto-add). With "Ask me about unsure ticks" on (shown under the switch), Weak suggestions open the kill dialog to confirm, and Pick / No-boss ticks ask which boss — suggestions, mobs up in the zone, or search — or Not a kill.
- **No double counting** — a /note within 30 minutes of an auto-added kill counts as the same kill. A tick for a kill you already /noted doesn't prompt; two kills a couple of minutes apart each get their own prompt.

- **Auto-Detect: Mobs up = potential spawns** — Mobs up and the right-click menu only offer bosses that could be up at the tick: in their window, or past it / up since a quake for under a day. Bosses marked Dead or not in window yet aren't listed; ones the spawn timers show up for more than a day (almost always a kill nobody recorded) are only counted as "+N stale". Any boss can still be added from the search box.

- **Spawn Timers: Unknown ToD (Dead)** — right-click a boss → Unknown ToD now offers **Could be up** and **Dead**. Dead is for a kill whose time you don't know: it shows as DEAD on the board and isn't counted as up (no parking warning, not in Auto-Detect's Mobs up). A quake, a ToD or a tracker paste replaces it.
- **Auto-Detect** — a new tick shows immediately as "⏳ Collecting evidence" until its suggestion is ready (about 2 minutes after the tick); Mobs up is shown in two columns.
- **Fix: loaded sessions** — Bot Loot / Tick Sub changes on a loaded session stay in the working copy until you Save; they used to change the saved session immediately.
- **Fix: Auto-Detect** — ticks heard on a character without an inventory file now show its zone; a log line EQ writes in two pieces can no longer lose a tick; duplicate tick rows are merged (fixes "#2 not recorded").
- **Fix: Admin → Resist Watch** works when Admin is opened from the app.

- **Auto-Detect: add any boss** — the right-click menu on Kill Tracker → Auto-Detect has a search box over every boss in the roster: type a few letters, press Enter (or click), and the usual kill dialog opens for that tick's time. Works on "No boss" ticks too; a hand-picked boss is labelled "picked by hand".
- **Auto-Detect: zone + Mobs up** — every tick shows the zone it was taken in, and a new **Mobs up** column lists that zone's bosses that were up at the tick per the spawn timers (also offered in the right-click menu). It's information, not a guess. When the logs show no boss but a boss's ToD on the spawn timers lands right at the tick (20 min before to 5 min after), that boss is suggested as Weak (spawn timer). Older ticks get their zone from ⛏ Scan logs.

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
