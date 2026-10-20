-- Community herding on attention (card A7, see docs/bias-indicators-design.md, S2):
-- do Stocktrails users discover the same stocks on the same days more than chance?
--
-- Per US Eastern day: how many users were active (viewed anything), and per
-- ticker how many of them looked at it for the FIRST time ever that day. The
-- client turns this into a Lakonishok-Shleifer-Vishny style measure (the share
-- of active users making a first look at a stock, against that stock's own
-- average share, minus what binomial chance gives). Aggregates only, with the
-- same k-anonymity floor as the other community RPCs: a ticker needs first looks
-- from at least 3 users in the window, and a day at least 5 active users.

create or replace function public.community_first_looks_daily(p_days int default 180)
returns table(day date, active int, looks jsonb)
language sql stable security definer set search_path to 'public'
as $$
  with v as (
    select user_id, ticker, (to_timestamp(ts / 1000.0) at time zone 'America/New_York')::date as d, ts
    from public.intraday
    where not deleted and ticker is not null
  ),
  first as (
    select user_id, ticker, min(ts) as ts from public.intraday where not deleted and ticker is not null group by 1, 2
  ),
  fl as (
    select f.ticker, (to_timestamp(f.ts / 1000.0) at time zone 'America/New_York')::date as d, f.user_id
    from first f
    where f.ts >= extract(epoch from now() - make_interval(days => p_days)) * 1000
  ),
  ok as (
    select ticker from fl group by 1 having count(distinct user_id) >= 3
  ),
  act as (
    select d, count(distinct user_id)::int as active
    from v
    where v.ts >= extract(epoch from now() - make_interval(days => p_days)) * 1000
    group by 1
    having count(distinct user_id) >= 5
  ),
  k as (
    select fl.d, fl.ticker, count(*)::int as n
    from fl join ok on ok.ticker = fl.ticker
    group by 1, 2
  )
  select a.d, a.active, coalesce(jsonb_object_agg(k.ticker, k.n) filter (where k.ticker is not null), '{}'::jsonb)
  from act a left join k on k.d = a.d
  group by a.d, a.active
  order by a.d;
$$;
revoke execute on function public.community_first_looks_daily(int) from public, anon;
grant execute on function public.community_first_looks_daily(int) to authenticated;
