-- Server-assigned sync cursor.
--
-- Clients pulled with `updated_at > cursor`, where updated_at is stamped on the
-- capturing device when the row is written, and cursor is that *other* device's
-- own wall clock at the start of its previous sync. A row captured at T and
-- pushed to the cloud after another device's cursor had already moved past T is
-- invisible to that device forever, so two installs signed into the same account
-- drift apart and never re-converge.
--
-- synced_at is stamped by the server when the row actually lands, so it orders
-- rows by arrival for every reader. Clients pull on synced_at; updated_at stays
-- the last-write-wins conflict key.

alter table public.events    add column if not exists synced_at timestamptz not null default now();
alter table public.intraday  add column if not exists synced_at timestamptz not null default now();
alter table public.user_meta add column if not exists synced_at timestamptz not null default now();

-- Trigger order is alphabetical, so the "..._lww" trigger runs first. For a
-- stale write it returns the old row, which arrives here as NEW; leaving
-- synced_at untouched then keeps a rejected write from re-notifying every
-- other device.
create or replace function public.stamp_synced_at() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new is not distinct from old then return new; end if;
  new.synced_at := now();
  return new;
end; $$;

-- user_meta also carries best-effort adoption columns (last_seen_session,
-- country, dashboard_ms, ...) that every sync rewrites with the same values.
-- Only the synced payload (config + updated_at) may move the cursor.
create or replace function public.stamp_user_meta_synced_at() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE'
     and new.config is not distinct from old.config
     and new.updated_at = old.updated_at then return new; end if;
  new.synced_at := now();
  return new;
end; $$;

drop trigger if exists events_synced_at on public.events;
create trigger events_synced_at before insert or update on public.events
  for each row execute function public.stamp_synced_at();

drop trigger if exists intraday_synced_at on public.intraday;
create trigger intraday_synced_at before insert or update on public.intraday
  for each row execute function public.stamp_synced_at();

drop trigger if exists meta_synced_at on public.user_meta;
create trigger meta_synced_at before insert or update on public.user_meta
  for each row execute function public.stamp_user_meta_synced_at();

create index if not exists events_user_synced   on public.events(user_id, synced_at);
create index if not exists intraday_user_synced on public.intraday(user_id, synced_at);
