# MixelParse privacy

## Your EverQuest log files stay on your PC

MixelParse reads your EverQuest logs **on your own PC** to track raid ticks, kills, auctions, factions, corpses and the rest.
**Your log files are never uploaded by MixelParse on its own.**

## Submitting logs for review is OPTIONAL

If something looks wrong — a missed kill, a wrong tick, an auction that didn't show — you can choose to send your logs to the
MixelParse owner so the problem can be found and fixed: **⚙ Admin → 📤 Submit logs for review.**

- **Optional.** Nothing is sent unless **you** press **Submit**.
- **Tells are removed first.** Every private tell — to you or from you, including pet tells — is deleted from the copy on
  your PC **before** anything is uploaded. Your log files themselves are never changed.
- **Private storage.** Submissions are stored in a private, locked storage area (Supabase Storage, bucket `log-reviews`).
  **Only you and the MixelParse owner can read them** — not other players, not other guild members.
- **What's sent:** the logs of the characters and days you pick (minus tells), your description of the problem, your
  screenshot if you add one, and MixelParse's own records for those days (Auto-Detect history, raid sessions, loot,
  version).
- **What's never sent:** tells, passwords, your EverQuest account, or any other file on your PC.
- **Used for one thing:** finding and fixing problems in MixelParse.
- **Delete any time:** the Submit page lists your submissions with a **Delete** button, which removes the files and the
  record from storage. If the owner already saved a copy for review, ask and it will be deleted too.

## What MixelParse does save to your account

As it always has, MixelParse saves some of your own data to your MixelParse account so it follows you between PCs:
your settings, character roles (banker / hidden), raid sessions and the Raid Kill Tracker, boss timers, Gear Planner plans
and similar. Leveling summaries (time and XP per level and zone, no chat) are shared with the guild for the Leveling tab.

The access rules are in [`tools/supabase/log_reviews.sql`](tools/supabase/log_reviews.sql).
