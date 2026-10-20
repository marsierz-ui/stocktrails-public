-- Earnings release dates for the limited-attention indicator (card A8, see
-- docs/bias-indicators-design.md, S1): how long after a quarterly report does a
-- user first open the stock's financials or news?
--
-- Sources (the `earnings` edge function writes; clients only read):
--   sec    - SEC EDGAR 8-K filings with Item 2.02 (results of operations): the
--            history, US issuers only. timing from the filing's acceptance time.
--   nasdaq - the Nasdaq earnings calendar: upcoming and recent dates.
-- Non-US listings have no source yet and are reported as "not measured".
--
-- Not user data: readable by any signed-in user, written only by the service role.

create table if not exists public.earnings_dates (
  ticker      text not null,
  day         date not null,                -- US Eastern date of the release
  timing      text not null default 'unknown' check (timing in ('bmo', 'amc', 'during', 'unknown')),
  source      text not null,                -- 'sec' | 'nasdaq'
  captured_at timestamptz not null default now(),
  primary key (ticker, day)
);
create index if not exists earnings_dates_day on public.earnings_dates (day);
alter table public.earnings_dates enable row level security;
drop policy if exists earnings_read on public.earnings_dates;
create policy earnings_read on public.earnings_dates for select to authenticated using (true);

-- Which tickers the EDGAR history has been read for (one submissions file each).
create table if not exists public.earnings_backfill (
  ticker  text primary key,
  cik     text,
  done_at timestamptz not null default now(),
  found   int not null default 0
);
alter table public.earnings_backfill enable row level security;
drop policy if exists earnings_backfill_admin on public.earnings_backfill;
create policy earnings_backfill_admin on public.earnings_backfill for select using (public.is_admin());

-- The client asks for its own tickers. One row per ticker with a [day, timing]
-- array, so a long watchlist stays under PostgREST's 1000-row cap.
create or replace function public.earnings_for(p_tickers text[], p_from date default (current_date - 1100))
returns table(ticker text, dates jsonb)
language sql stable security definer set search_path to 'public'
as $$
  select e.ticker, jsonb_agg(jsonb_build_array(e.day, e.timing) order by e.day)
  from public.earnings_dates e
  where e.ticker = any(p_tickers) and e.day >= p_from
  group by e.ticker;
$$;
revoke execute on function public.earnings_for(text[], date) from public, anon;
grant execute on function public.earnings_for(text[], date) to authenticated;

-- The universe the edge function backfills: US-listed tickers (no exchange
-- suffix) viewed by anyone in the last 400 days, most-viewed first, not read yet.
-- Service role only: it reads every user's events.
create or replace function public.earnings_universe(p_limit int default 25)
returns table(ticker text)
language sql stable security definer set search_path to 'public'
as $$
  select e.ticker
  from public.events e
  where not e.deleted and e.ts >= (extract(epoch from now() - interval '400 days') * 1000)
    and e.ticker ~ '^[A-Z]{1,5}(-[A-Z])?$'
    and not exists (select 1 from public.earnings_backfill b where b.ticker = e.ticker)
  group by e.ticker
  order by count(*) desc
  limit p_limit;
$$;
revoke execute on function public.earnings_universe(int) from public, anon, authenticated;

-- Daily capture, weekdays 12:10 UTC (before the US open in both summer and winter time).
-- Same anon-key call pattern as the trending capture (20260925_trending_cron.sql).
create extension if not exists pg_net;
create extension if not exists pg_cron;
select cron.unschedule(jobname) from cron.job where jobname = 'earnings-capture';
select cron.schedule('earnings-capture', '10 12 * * 1-5', $$
  select net.http_post(
    url := 'https://unymnlguicuwllkuqglm.supabase.co/functions/v1/earnings',
    headers := '{"Content-Type": "application/json", "apikey": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVueW1ubGd1aWN1d2xsa3VxZ2xtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIwMzI0OTMsImV4cCI6MjA5NzYwODQ5M30.5YjbkKI7qyostBsFK2ILbeDIGPftKHbcfvl2oeNC8HM", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVueW1ubGd1aWN1d2xsa3VxZ2xtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIwMzI0OTMsImV4cCI6MjA5NzYwODQ5M30.5YjbkKI7qyostBsFK2ILbeDIGPftKHbcfvl2oeNC8HM"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 60000);
$$);
