-- 1. Trending, normalised by audience size.
--
-- world_trending() scored a ticker by today's views against its own trailing
-- 7-day average. As the user base grows, every ticker's views grow with it, so
-- the whole list drifts "hot" for reasons that have nothing to do with the
-- stock. The prior is now measured PER ACTIVE USER (each prior day's views of
-- the ticker divided by that day's active users, averaged over 7 days, quiet
-- days counting 0) and scaled to today's audience:
--   expected = prior views-per-user x active users today
--   score    = (views_today + 1) / (expected + 1)
-- With a constant audience this is the old score; with a growing one it no
-- longer rewards growth. avg_prior (the raw 7-day average) is kept for display.
-- The 3-user k-anonymity floor from 20260926_community_open.sql is unchanged.
drop function if exists public.world_trending();
create function public.world_trending()
returns table(ticker text, views_today bigint, users_today bigint, avg_prior numeric, score numeric,
              expected numeric, active_today bigint)
language sql stable security definer set search_path to 'public'
as $$
  with day0 as (select (extract(epoch from date_trunc('day', now() at time zone 'UTC')) * 1000)::bigint ms),
  iv as (
    select i.ticker, i.user_id, floor((i.ts - (select ms from day0)) / 86400000.0)::int d
    from public.intraday i
    where not i.deleted and i.ts >= (select ms from day0) - 7::bigint * 86400000
  ),
  act as (select d, count(distinct user_id) u from iv group by d),
  a0 as (select coalesce((select u from act where d = 0), 0) u),
  today as (
    select ticker, count(*) v, count(distinct user_id) u
    from iv where d = 0
    group by 1
    having public.is_admin() or count(distinct user_id) >= 3
  ),
  prior as (
    select iv.ticker, count(*)::numeric / 7 av, sum(1.0 / a.u) / 7 pu
    from iv join act a on a.d = iv.d
    where iv.d < 0
    group by 1
  )
  select t.ticker, t.v views_today, t.u users_today,
    round(coalesce(p.av, 0), 2) avg_prior,
    round((t.v + 1) / (coalesce(p.pu, 0) * (select u from a0) + 1), 2) score,
    round(coalesce(p.pu, 0) * (select u from a0), 2) expected,
    (select u from a0) active_today
  from today t
  left join prior p on p.ticker = t.ticker
  order by score desc, t.v desc
  limit 15;
$$;
revoke execute on function public.world_trending() from public, anon;
grant execute on function public.world_trending() to authenticated;

-- 2. Community attention per UTC day, for My Habits > Market correlation, which
-- compares the user's own attention-vs-NASDAQ correlation with the community's
-- (this replaces the admin-only "Attention vs NASDAQ" panel on World). Totals
-- only - no tickers, no countries - and the same per-day community total that
-- world_crowd_overlap already returns to every user, so no floor is needed.
create or replace function public.community_daily_attention(p_days int)
returns table(day date, users bigint, views bigint, dwell_ms bigint)
language sql stable security definer set search_path to 'public'
as $$
  select (to_timestamp(i.ts / 1000.0) at time zone 'UTC')::date as day,
         count(distinct i.user_id) users, count(*) views,
         coalesce(sum(coalesce(i.dwell_ms, 0)), 0)::bigint dwell_ms
  from public.intraday i
  where not i.deleted
    and i.ts >= (extract(epoch from now()) * 1000)::bigint - least(greatest(p_days, 1), 800)::bigint * 86400000
  group by 1
  order by 1;
$$;
revoke execute on function public.community_daily_attention(int) from public, anon;
grant execute on function public.community_daily_attention(int) to authenticated;
