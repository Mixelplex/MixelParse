-- MixelParse 1.7.22 — shared merchant prices (owner, 2026-10-13: "add this to the leveling pull we get from our members")
-- Each MixelParse desktop app reads its own characters' EQ logs for what merchants offered for things they sold
-- ("Merchant tells you, 'I'll give you 9 platinum 4 gold for the Peridot.'") and uploads one row per item: the latest
-- offer, the lowest and highest seen, and how many times — item and price only, no chat. The loot value check uses
-- your own price first, then the guild's, then the P99 wiki's.
-- Every signed-in user can read every row; users can only write, change or delete their own rows (same rules as
-- leveling_data). Run in Supabase → SQL Editor (safe to run again).

create table if not exists public.vendor_prices (
  id          bigserial primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  item_name   text not null,
  cp          int  not null,                 -- latest merchant offer, in copper (1 pp = 1000 cp)
  lo          int  not null,                 -- lowest offer seen (CHA / faction move it)
  hi          int  not null,                 -- highest offer seen
  n           int  not null default 1,       -- how many offers seen
  last_at     timestamptz,                   -- when the latest offer was made
  updated_at  timestamptz not null default now(),
  unique (user_id, item_name)
);

create index if not exists vendor_prices_item_idx on public.vendor_prices (item_name);

alter table public.vendor_prices enable row level security;

drop policy if exists "vendor_prices read"   on public.vendor_prices;
drop policy if exists "vendor_prices insert" on public.vendor_prices;
drop policy if exists "vendor_prices update" on public.vendor_prices;
drop policy if exists "vendor_prices delete" on public.vendor_prices;

create policy "vendor_prices read"   on public.vendor_prices for select to authenticated using (true);
create policy "vendor_prices insert" on public.vendor_prices for insert to authenticated with check (user_id = auth.uid());
create policy "vendor_prices update" on public.vendor_prices for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "vendor_prices delete" on public.vendor_prices for delete to authenticated using (user_id = auth.uid());

grant select, insert, update, delete on public.vendor_prices to authenticated;
grant usage, select on sequence public.vendor_prices_id_seq to authenticated;
