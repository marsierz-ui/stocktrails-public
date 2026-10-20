-- Third-party attention lists: a daily snapshot of who the rest of the internet
-- is looking at, so the Network index can be compared against crowds we do not
-- own.
--
-- Every source publishes a LIVE list and no history: stockanalysis.com/trending
-- is "pageviews today" and resets overnight, Reddit mention counts are a rolling
-- 24h window, Yahoo's trending list is rank-only and rewrites itself hourly.
-- None of them can be backfilled, so the series can only start the day capture
-- starts. The `trending` edge function writes one row per (source, day, ticker);
-- the day key is the US Eastern date because that is the trading day these lists
-- accumulate over and the day Yahoo's daily bars are stamped with.
--
-- Not user data: no RLS scoping by owner, readable by any signed-in user. Writes
-- only ever come from the edge function (service role, bypasses RLS).

create table if not exists public.trending_snapshots (
  source      text not null,             -- 'stockanalysis' | 'apewisdom' | 'stocktwits' | 'yahoo'
  day         date not null,             -- US Eastern date of the snapshot
  ticker      text not null,
  rank        int not null,              -- 1 = most attention that day, as the source ranked it
  views       numeric not null default 0,-- source-native magnitude (pageviews / mentions / watchers); 0 when rank-only
  captured_at timestamptz not null default now(),
  primary key (source, day, ticker)
);
create index if not exists trending_snapshots_day on public.trending_snapshots (day);

alter table public.trending_snapshots enable row level security;
drop policy if exists trending_read on public.trending_snapshots;
create policy trending_read on public.trending_snapshots for select to authenticated using (true);

-- One row per (source, day) instead of per ticker: PostgREST truncates a
-- response at 1000 rows, and per-ticker rows (4 sources x 10 names x N days)
-- would silently start dropping days after a few weeks. Per day the payload is
-- {"NVDA": [12413, 1], ...} = ticker -> [views, rank].
create or replace function public.trending_daily(p_days int default 180, p_top int default 10)
returns table(source text, day date, weights jsonb)
language sql stable security definer set search_path to 'public'
as $$
  with r as (
    select s.source, s.day, s.ticker, s.views, s.rank,
           row_number() over (partition by s.source, s.day order by s.rank) rn
    from public.trending_snapshots s
    where s.day >= (current_date - greatest(p_days, 1))
  )
  select r.source, r.day, jsonb_object_agg(r.ticker, jsonb_build_array(r.views, r.rank))
  from r
  where r.rn <= greatest(p_top, 1)
  group by r.source, r.day
  order by r.source, r.day;
$$;
grant execute on function public.trending_daily(int, int) to authenticated;

-- How fresh the newest snapshot per source is. The dashboard shows this so a
-- source that quietly stopped parsing reads as stale rather than as a flat line.
create or replace function public.trending_status()
returns table(source text, days bigint, last_day date, last_capture timestamptz)
language sql stable security definer set search_path to 'public'
as $$
  select s.source, count(distinct s.day), max(s.day), max(s.captured_at)
  from public.trending_snapshots s
  group by s.source
  order by s.source;
$$;
grant execute on function public.trending_status() to authenticated;
