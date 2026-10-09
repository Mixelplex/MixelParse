-- MixelParse 1.7.16 — "Submit logs for review" (owner, 2026-10-09)
-- Any signed-in user can submit their EQ logs (tells removed, compressed), a description of the problem and an
-- optional screenshot, from ⚙ Admin → Submit logs for review. Submitting is OPTIONAL — nothing is sent unless the user
-- presses Submit. Every tell is removed on the user's PC before upload. The bucket is private: a user can read and
-- delete only their own submissions; only the owner's account can read all of them. See PRIVACY.md.
-- Files go to the private Storage bucket "log-reviews" under <user id>/<submission id>/; a row in log_reviews
-- describes each submission. Users see and add only their own; the owner's account reads everything (the
-- owner's MixelParse downloads new submissions to a folder on the owner's PC for review).
-- Run in Supabase → SQL Editor (safe to run again).

-- ── submissions ──
create table if not exists public.log_reviews (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  user_email    text,
  created_at    timestamptz not null default now(),
  app_version   text,
  chars         text[] not null default '{}',
  days          int,
  description   text not null default '',
  files         jsonb not null default '[]'::jsonb,   -- [{ path, char, bytes, raw_bytes, lines, tells_removed }]
  has_screenshot boolean not null default false,
  status        text not null default 'new',          -- new | downloaded | reviewed
  downloaded_at timestamptz,
  reviewed_at   timestamptz,
  owner_notes   text
);
create index if not exists log_reviews_created_idx on public.log_reviews (created_at desc);

alter table public.log_reviews enable row level security;
drop policy if exists "log_reviews insert own"  on public.log_reviews;
drop policy if exists "log_reviews read own"    on public.log_reviews;
drop policy if exists "log_reviews owner read"  on public.log_reviews;
drop policy if exists "log_reviews owner update" on public.log_reviews;
create policy "log_reviews insert own"   on public.log_reviews for insert to authenticated with check (user_id = auth.uid());
create policy "log_reviews read own"     on public.log_reviews for select to authenticated using (user_id = auth.uid());
create policy "log_reviews owner read"   on public.log_reviews for select to authenticated using ((auth.jwt() ->> 'email') = 'afschmitt1@gmail.com');
create policy "log_reviews owner update" on public.log_reviews for update to authenticated using ((auth.jwt() ->> 'email') = 'afschmitt1@gmail.com');
-- privacy: anyone can delete their own submission at any time (⚙ Admin → Submit logs for review → Your submissions)
drop policy if exists "log_reviews delete own" on public.log_reviews;
create policy "log_reviews delete own" on public.log_reviews for delete to authenticated using (user_id = auth.uid());
grant select, insert, update, delete on public.log_reviews to authenticated;

-- ── private file bucket (50 MB per file; logs are compressed and split if bigger) ──
insert into storage.buckets (id, name, public, file_size_limit)
values ('log-reviews', 'log-reviews', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = 52428800;

drop policy if exists "log-reviews upload own folder" on storage.objects;
drop policy if exists "log-reviews read own folder"   on storage.objects;
drop policy if exists "log-reviews owner read"        on storage.objects;
drop policy if exists "log-reviews owner delete"      on storage.objects;
create policy "log-reviews upload own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'log-reviews' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "log-reviews read own folder" on storage.objects for select to authenticated
  using (bucket_id = 'log-reviews' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "log-reviews owner read" on storage.objects for select to authenticated
  using (bucket_id = 'log-reviews' and (auth.jwt() ->> 'email') = 'afschmitt1@gmail.com');
create policy "log-reviews owner delete" on storage.objects for delete to authenticated
  using (bucket_id = 'log-reviews' and (auth.jwt() ->> 'email') = 'afschmitt1@gmail.com');
drop policy if exists "log-reviews delete own folder" on storage.objects;
create policy "log-reviews delete own folder" on storage.objects for delete to authenticated
  using (bucket_id = 'log-reviews' and (storage.foldername(name))[1] = auth.uid()::text);
