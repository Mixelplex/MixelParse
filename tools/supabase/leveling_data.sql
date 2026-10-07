-- MixelParse 1.7.9 — shared leveling data (owner, 2026-10-06)
-- Each MixelParse desktop app scans its own characters' EQ logs and uploads one row per
-- (character, level, zone): hunting time, played time, solo / group XP messages, deaths and top mobs.
-- Every signed-in user can read every row (the Leveling tab compares the whole guild); users can only
-- write, change or delete their own rows. Run in Supabase → SQL Editor (safe to run again).

create table if not exists public.leveling_data (
  id             bigserial primary key,
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  char_name      text not null,
  class          text,
  race           text,
  level          int  not null check (level between 1 and 60),
  zone           text not null,
  hunt_ms        bigint not null default 0,
  played_ms      bigint not null default 0,
  xp_solo        int  not null default 0,
  xp_group       int  not null default 0,
  xp_quest       int  not null default 0,     -- XP lines with no kill (quest turn-ins)
  deaths         int  not null default 0,
  level_xp_total int  not null default 0,     -- kill XP messages for the whole level, all zones
  level_quest    int  not null default 0,     -- turn-in XP messages for the whole level
  level_done     boolean not null default false,
  mobs           jsonb not null default '{}'::jsonb,
  first_at       timestamptz,
  last_at        timestamptz,
  updated_at     timestamptz not null default now(),
  unique (user_id, char_name, level, zone)
);

-- safe to re-run: adds the turn-in columns to a table made from the first version of this script
alter table public.leveling_data add column if not exists xp_quest    int not null default 0;
alter table public.leveling_data add column if not exists level_quest int not null default 0;
-- 1.7.11: XP estimated from the P99 wiki's mob levels (mob level² per kill, group kills × 0.3)
alter table public.leveling_data add column if not exists xp_est      double precision not null default 0;
alter table public.leveling_data add column if not exists xp_known    int not null default 0;

create index if not exists leveling_data_level_idx on public.leveling_data (level);

alter table public.leveling_data enable row level security;

drop policy if exists "leveling_data read"   on public.leveling_data;
drop policy if exists "leveling_data insert" on public.leveling_data;
drop policy if exists "leveling_data update" on public.leveling_data;
drop policy if exists "leveling_data delete" on public.leveling_data;

create policy "leveling_data read"   on public.leveling_data for select to authenticated using (true);
create policy "leveling_data insert" on public.leveling_data for insert to authenticated with check (user_id = auth.uid());
create policy "leveling_data update" on public.leveling_data for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "leveling_data delete" on public.leveling_data for delete to authenticated using (user_id = auth.uid());

grant select, insert, update, delete on public.leveling_data to authenticated;
grant usage, select on sequence public.leveling_data_id_seq to authenticated;
