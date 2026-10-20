-- stockanalysis.com is now captured in full (every stock the site publishes a
-- views figure for, ~500 a day) instead of its top 20. The dashboard still pulls
-- only the top names per day through trending_daily(); a stock's share of the
-- day is taken against the day's FULL total, which comes from here.

-- The edge function's freshness check reads the newest captured_at; with ~500
-- rows a day that is no longer a trivially small scan.
create index if not exists trending_snapshots_captured on public.trending_snapshots (captured_at desc);

create or replace function public.trending_day_totals(p_days int default 180)
returns table(source text, day date, names int, views numeric)
language sql stable security definer set search_path to 'public'
as $$
  select s.source, s.day, count(*)::int, sum(s.views)
  from public.trending_snapshots s
  where s.day >= (current_date - greatest(p_days, 1))
  group by s.source, s.day
  order by s.source, s.day;
$$;
grant execute on function public.trending_day_totals(int) to authenticated;
