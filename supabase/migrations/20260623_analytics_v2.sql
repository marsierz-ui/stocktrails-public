-- GROUP 2 (schema migration) + GROUP 5 (position_taken, target_price columns).
-- All additive and nullable; existing RLS policies are untouched. Idempotent:
-- safe to run more than once.

-- 1/2. New columns on events + intraday (intraday also gets portal_path).
alter table public.events
  add column if not exists scroll_depth real,
  add column if not exists focus_switches smallint,
  add column if not exists sector text,
  add column if not exists industry text,
  add column if not exists market_cap bigint,
  add column if not exists market_cap_bucket text,
  add column if not exists week52_position real,
  add column if not exists sentiment_prev text,
  add column if not exists sentiment_changed_at timestamptz,
  add column if not exists position_taken boolean,
  add column if not exists target_price real;

alter table public.intraday
  add column if not exists scroll_depth real,
  add column if not exists focus_switches smallint,
  add column if not exists sector text,
  add column if not exists industry text,
  add column if not exists market_cap bigint,
  add column if not exists market_cap_bucket text,
  add column if not exists week52_position real,
  add column if not exists sentiment_prev text,
  add column if not exists sentiment_changed_at timestamptz,
  add column if not exists position_taken boolean,
  add column if not exists target_price real,
  add column if not exists portal_path text;

-- 3. CHECK constraints (guarded so re-running does not error).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'events_scroll_depth_chk') then
    alter table public.events add constraint events_scroll_depth_chk
      check (scroll_depth is null or (scroll_depth >= 0 and scroll_depth <= 1));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'events_week52_chk') then
    alter table public.events add constraint events_week52_chk
      check (week52_position is null or (week52_position >= 0 and week52_position <= 1));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'events_mcbucket_chk') then
    alter table public.events add constraint events_mcbucket_chk
      check (market_cap_bucket is null or market_cap_bucket in ('nano','micro','small','mid','large','mega'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'intraday_scroll_depth_chk') then
    alter table public.intraday add constraint intraday_scroll_depth_chk
      check (scroll_depth is null or (scroll_depth >= 0 and scroll_depth <= 1));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'intraday_week52_chk') then
    alter table public.intraday add constraint intraday_week52_chk
      check (week52_position is null or (week52_position >= 0 and week52_position <= 1));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'intraday_mcbucket_chk') then
    alter table public.intraday add constraint intraday_mcbucket_chk
      check (market_cap_bucket is null or market_cap_bucket in ('nano','micro','small','mid','large','mega'));
  end if;
end $$;

-- 4. Indexes.
create index if not exists events_ticker_sector_idx on public.events (ticker, sector);
create index if not exists events_market_cap_bucket_idx on public.events (market_cap_bucket);
create index if not exists intraday_ticker_portal_path_idx on public.intraday (ticker, portal_path);
