-- GROUP F schema (F-PREREQ A/B/C + F1).
-- All additive/nullable. session_id uses a DEFAULT so no backfill is needed and
-- new rows are always non-null; pre-migration intraday rows keep NULL.

-- F-PREREQ A: user-agent fingerprint for multi-device detection.
alter table public.user_meta add column if not exists last_ua text;
-- Quick-fix: time spent on the dashboard (ms), reported in platform health.
alter table public.user_meta add column if not exists dashboard_ms bigint;

-- F-PREREQ B: per-session grouping on intraday (30-min idle gap, set by client).
alter table public.intraday add column if not exists session_id uuid default gen_random_uuid();
create index if not exists intraday_user_session_idx on public.intraday (user_id, session_id);

-- F-PREREQ C: price-fetch failure flag.
alter table public.events add column if not exists price_fetch_failed boolean default false;
alter table public.intraday add column if not exists price_fetch_failed boolean default false;

-- F1: first_event_at on profiles, set once by a trigger on the first events insert.
alter table public.profiles add column if not exists first_event_at timestamptz;

create or replace function public.set_first_event_at()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  update public.profiles set first_event_at = now()
  where id = NEW.user_id and first_event_at is null;
  return NEW;
end;
$$;

drop trigger if exists trg_first_event_at on public.events;
create trigger trg_first_event_at after insert on public.events
  for each row execute function public.set_first_event_at();
