-- Community aggregates must not reveal one person's activity.
--
-- 1. world_crowd_overlap had no distinct-user floor: with one own view per day and
--    the 4-decimal cosine, a caller could solve for every other user's per-day,
--    per-ticker view counts. Same floors as crowd_stock_daily now: a day counts
--    only with 20+ active users, a (day, ticker) cell only with 5+ users.
--    community_views is that qualifying day's total views. p_days is clamped.
-- 2. network_community_daily and network_community_sentiment floored 3 users per
--    ticker over all time, then returned per-day cells that could hold one person.
--    Each cell now needs 3 users as well.
-- 3. community_daily_attention returned users, views and dwell for every day; a day
--    now needs 5 active users (the floor community_first_looks_daily uses).
-- 4. Cross-user RPCs that still had the default PUBLIC execute are limited to
--    signed-in users.
-- Return shapes are unchanged; clients treat a missing day or ticker as no data.

create or replace function public.world_crowd_overlap(p_days int)
returns table(day date, overlap numeric, my_views bigint, community_views bigint)
language sql stable security definer set search_path to 'public'
as $$
  with frm as (select (extract(epoch from now()) * 1000)::bigint - least(greatest(p_days, 1), 400)::bigint * 86400000 f),
  b as (
    select (to_timestamp(ts / 1000.0) at time zone 'UTC')::date d, ticker, user_id
    from public.intraday
    where not deleted and ts >= (select f from frm)
  ),
  act as (select d, count(*)::bigint v from b group by d having count(distinct user_id) >= 20),
  mine as (
    select b.d, b.ticker, count(*) n from b join act on act.d = b.d
    where b.user_id = auth.uid() group by 1, 2
  ),
  comm as (
    select b.d, b.ticker, count(*) n from b join act on act.d = b.d
    group by 1, 2 having count(distinct b.user_id) >= 5
  ),
  dp as (
    select m.d, sum(m.n::numeric * c.n) dot
    from mine m join comm c on c.d = m.d and c.ticker = m.ticker
    group by m.d
  ),
  nm as (select d, sqrt(sum((n::numeric) ^ 2)) mag, sum(n)::bigint v from mine group by d),
  nc as (select d, sqrt(sum((n::numeric) ^ 2)) mag from comm group by d)
  select nm.d as day,
    round(coalesce(dp.dot, 0) / nullif(nm.mag * nc.mag, 0), 4) overlap,
    nm.v my_views, act.v community_views
  from nm
  join nc on nc.d = nm.d
  join act on act.d = nm.d
  left join dp on dp.d = nm.d
  order by nm.d;
$$;

create or replace function public.network_community_daily()
returns table(ticker text, entry_ts bigint, entry_price double precision, days jsonb)
language sql stable security definer set search_path to 'public'
as $$
  with ok as (
    select ticker from public.events
    where not deleted
    group by 1
    having public.is_admin() or count(distinct user_id) >= 3
  ),
  ev as (
    select e.ticker, e.user_id, coalesce(e.views, 1) v, e.sentiment,
           (to_timestamp(e.ts / 1000.0) at time zone 'America/New_York') et
    from public.events e
    where not e.deleted and e.ticker in (select ticker from ok)
  ),
  d as (
    select ticker,
           (et::date + case when et::time >= time '16:00' then 1 else 0 end) as day,
           sum(v)::bigint views,
           count(*) filter (where sentiment = 'positive') pos,
           count(*) filter (where sentiment = 'negative') neg,
           count(*) filter (where sentiment is not null) lab
    from ev
    group by 1, 2
    having public.is_admin() or count(distinct user_id) >= 3
  ),
  entry as (
    select distinct on (e.ticker) e.ticker, e.ts, e.price_at_event
    from public.events e
    where not e.deleted and e.price_at_event is not null and e.ticker in (select ticker from ok)
    order by e.ticker, e.ts asc
  )
  select d.ticker, en.ts, en.price_at_event,
         jsonb_agg(jsonb_build_array(d.day, d.views, d.pos, d.neg, d.lab) order by d.day)
  from d join entry en on en.ticker = d.ticker
  group by d.ticker, en.ts, en.price_at_event;
$$;

create or replace function public.network_community_sentiment()
returns table(ticker text, ts bigint, sentiment text)
language sql stable security definer set search_path to 'public'
as $$
  with ok as (
    select ticker from public.events
    where not deleted
    group by 1
    having public.is_admin() or count(distinct user_id) >= 3
  ),
  d as (
    select e.ticker,
           (to_timestamp(e.ts / 1000.0) at time zone 'UTC')::date as day,
           count(*) filter (where e.sentiment = 'positive') pos,
           count(*) filter (where e.sentiment = 'negative') neg
    from public.events e
    where not e.deleted and e.sentiment is not null and e.ticker in (select ticker from ok)
    group by 1, 2
    having public.is_admin() or count(distinct e.user_id) >= 3
  )
  select d.ticker,
         (extract(epoch from d.day) * 1000)::bigint + 86399999 ts,
         case when d.pos > d.neg then 'positive'
              when d.neg > d.pos then 'negative'
              else 'neutral' end sentiment
  from d
  order by d.ticker, d.day;
$$;

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
  having public.is_admin() or count(distinct i.user_id) >= 5
  order by 1;
$$;

revoke execute on function
  public.network_percentiles(),
  public.network_community_index(),
  public.network_community_sentiment(),
  public.world_crowd_overlap(int),
  public.trending_daily(int, int),
  public.trending_status(),
  public.trending_day_totals(int)
from public, anon;
grant execute on function
  public.network_percentiles(),
  public.network_community_index(),
  public.network_community_sentiment(),
  public.world_crowd_overlap(int),
  public.trending_daily(int, int),
  public.trending_status(),
  public.trending_day_totals(int)
to authenticated;
