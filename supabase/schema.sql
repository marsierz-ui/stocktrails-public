-- Attention Tracker - Supabase schema (Option B).
-- Run in Supabase: SQL Editor -> paste -> Run. Safe to re-run.
-- Model: every row keyed by user_id = auth.uid(); RLS isolates users; admins
-- (profiles.is_admin) can read everyone; updated_at drives last-write-wins.

-- ---------- profiles (table first, so helpers can reference it) ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  email text,
  name text,
  is_admin boolean default false,
  created_at timestamptz default now()
);

-- ---------- helpers (must exist before policies/triggers use them) ----------
-- admin check (security definer so it can read profiles regardless of RLS)
create or replace function public.is_admin() returns boolean as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$ language sql stable security definer set search_path = public;

-- last-write-wins guard, shared by all data tables
create or replace function public.keep_newer() returns trigger as $$
begin
  if new.updated_at <= old.updated_at then return old; end if;
  return new;
end; $$ language plpgsql;

-- Server-assigned sync cursor. updated_at is stamped by the device that wrote
-- the row, so it says nothing about when the row reached the cloud; clients pull
-- on synced_at instead (see supabase/migrations/20260813_server_sync_cursor.sql).
-- Runs after the *_lww trigger (alphabetical order), so a write LWW rejected
-- arrives here as an unchanged row and must not move the cursor.
create or replace function public.stamp_synced_at() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new is not distinct from old then return new; end if;
  new.synced_at := now();
  return new;
end; $$;

-- user_meta also carries best-effort adoption columns that every sync rewrites;
-- only the synced payload (config + updated_at) may move the cursor.
create or replace function public.stamp_user_meta_synced_at() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE'
     and new.config is not distinct from old.config
     and new.updated_at = old.updated_at then return new; end if;
  new.synced_at := now();
  return new;
end; $$;

-- auto-create a profile row on signup
create or replace function public.handle_new_user() returns trigger as $$
begin
  insert into public.profiles (id, email, name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', new.email))
  on conflict (id) do nothing;
  return new;
end; $$ language plpgsql security definer set search_path = public;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- profiles RLS ----------
alter table public.profiles enable row level security;
drop policy if exists profiles_self_sel on public.profiles;
create policy profiles_self_sel on public.profiles for select using (id = auth.uid() or public.is_admin());
drop policy if exists profiles_self_upd on public.profiles;
create policy profiles_self_upd on public.profiles for update using (id = auth.uid());
-- ...but only over email and name. is_admin sits in the row this policy lets a
-- user write, and it gates the admin SELECT policies below plus every admin_*
-- and world_* RPC - so without a column restriction any signed-in user could
-- update their own row to is_admin = true and read every other user's data.
-- The trigger is a second lock in case a later blanket grant reopens the first.
-- See supabase/migrations/20260906_profiles_admin_lockdown.sql.
revoke update on public.profiles from anon, authenticated;
grant update (email, name) on public.profiles to authenticated;
-- Invoker, not definer: inside a definer function current_user is the owner and
-- the check below could never fire (migrations/20261017_definer_hardening.sql).
create or replace function public.profiles_guard_admin() returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  if new.is_admin is distinct from old.is_admin
     and current_user in ('anon', 'authenticated') then
    raise exception 'is_admin is not client-writable';
  end if;
  new.id := old.id;
  new.created_at := old.created_at;
  return new;
end; $$;
drop trigger if exists profiles_guard_admin on public.profiles;
create trigger profiles_guard_admin before update on public.profiles
  for each row execute function public.profiles_guard_admin();

-- ---------- events ----------
create table if not exists public.events (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  id text not null,
  ticker text, ts bigint, source text, url text, sentiment text,
  price_at_event double precision, views int,
  updated_at bigint not null, deleted boolean default false,
  synced_at timestamptz not null default now(),
  primary key (user_id, id)
);
create index if not exists events_user_upd on public.events(user_id, updated_at);
create index if not exists events_user_synced on public.events(user_id, synced_at);
alter table public.events enable row level security;
drop policy if exists events_own on public.events;
create policy events_own on public.events for all using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists events_admin_sel on public.events;
create policy events_admin_sel on public.events for select using (public.is_admin());
drop trigger if exists events_lww on public.events;
create trigger events_lww before update on public.events for each row execute function public.keep_newer();
drop trigger if exists events_synced_at on public.events;
create trigger events_synced_at before insert or update on public.events for each row execute function public.stamp_synced_at();

-- ---------- intraday ----------
create table if not exists public.intraday (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  id text not null,
  ticker text, ts bigint, source text, url text, sentiment text,
  price_at_event double precision,
  updated_at bigint not null, deleted boolean default false,
  synced_at timestamptz not null default now(),
  primary key (user_id, id)
);
create index if not exists intraday_user_upd on public.intraday(user_id, updated_at);
create index if not exists intraday_user_synced on public.intraday(user_id, synced_at);
alter table public.intraday enable row level security;
drop policy if exists intraday_own on public.intraday;
create policy intraday_own on public.intraday for all using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists intraday_admin_sel on public.intraday;
create policy intraday_admin_sel on public.intraday for select using (public.is_admin());
drop trigger if exists intraday_lww on public.intraday;
create trigger intraday_lww before update on public.intraday for each row execute function public.keep_newer();
drop trigger if exists intraday_synced_at on public.intraday;
create trigger intraday_synced_at before insert or update on public.intraday for each row execute function public.stamp_synced_at();

-- ---------- user_meta (overrides / customPortals / settings) ----------
create table if not exists public.user_meta (
  user_id uuid primary key default auth.uid() references auth.users on delete cascade,
  config jsonb,
  updated_at bigint not null,
  synced_at timestamptz not null default now()
);
alter table public.user_meta enable row level security;
drop policy if exists meta_own on public.user_meta;
create policy meta_own on public.user_meta for all using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists meta_admin_sel on public.user_meta;
create policy meta_admin_sel on public.user_meta for select using (public.is_admin());
drop trigger if exists meta_lww on public.user_meta;
create trigger meta_lww before update on public.user_meta for each row execute function public.keep_newer();
drop trigger if exists meta_synced_at on public.user_meta;
create trigger meta_synced_at before insert or update on public.user_meta for each row execute function public.stamp_user_meta_synced_at();

-- ---------- feedback ----------
create table if not exists public.feedback (
  id bigserial primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  text text, url text, screenshot text,
  created_at bigint, status text default 'new', category text, issue_url text,
  admin_note text
);
alter table public.feedback enable row level security;
drop policy if exists feedback_ins on public.feedback;
-- admin_note / category / issue_url / status are admin-owned (20261017_feedback_insert_lockdown.sql)
create policy feedback_ins on public.feedback for insert with check (
  user_id = auth.uid()
  and admin_note is null and category is null and issue_url is null
  and coalesce(status, 'new') = 'new'
);
drop policy if exists feedback_sel on public.feedback;
create policy feedback_sel on public.feedback for select using (user_id = auth.uid() or public.is_admin());
drop policy if exists feedback_upd on public.feedback;
create policy feedback_upd on public.feedback for update using (public.is_admin());

-- ---------- make yourself admin (run once, after your first sign-in) ----------
-- update public.profiles set is_admin = true where email = 'you@example.com';
