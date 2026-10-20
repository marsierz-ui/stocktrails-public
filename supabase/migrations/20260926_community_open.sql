-- Open the Community tab (formerly Network) to every signed-in user.
--
-- These RPCs were gated by public.is_admin() while Network was admin-only
-- (see 20260705_world_daily_network.sql). The guard is replaced by a k-anonymity
-- floor: for non-admins a ticker only appears once at least 3 distinct users
-- have viewed it, so no single user's research can be read back ticker by
-- ticker. Admins still see everything. network_percentiles returns only the
-- caller's own ranks plus the user count, so it needs no floor.
--
-- World (world_country_daily, world_country_top_stock_daily,
-- world_country_crowd_similarity) stays admin-only and is not touched here.

create or replace function public.world_trending()
returns table(ticker text, views_today bigint, users_today bigint, avg_prior numeric, score numeric)
language sql stable security definer set search_path to 'public'
as $$
  with day0 as (select (extract(epoch from date_trunc('day', now() at time zone 'UTC')) * 1000)::bigint ms),
  today as (
    select i.ticker, count(*) v, count(distinct i.user_id) u
    from public.intraday i
    where not i.deleted and i.ts >= (select ms from day0)
    group by 1
    having public.is_admin() or count(distinct i.user_id) >= 3
  ),
  prior as (
    select i.ticker, count(*)::numeric / 7 av
    from public.intraday i
    where not i.deleted
      and i.ts >= (select ms from day0) - 7::bigint * 86400000 and i.ts < (select ms from day0)
    group by 1
  )
  select t.ticker, t.v views_today, t.u users_today,
    round(coalesce(p.av, 0), 2) avg_prior,
    round((t.v + 1) / (coalesce(p.av, 0) + 1), 2) score
  from today t
  left join prior p on p.ticker = t.ticker
  order by score desc, t.v desc
  limit 15;
$$;
grant execute on function public.world_trending() to authenticated;

create or replace function public.network_percentiles()
returns jsonb language sql stable security definer set search_path to 'public'
as $$
  with nw as (select (extract(epoch from now()) * 1000)::bigint ms),
  per as (
    select i.user_id, count(*) views, coalesce(sum(coalesce(i.dwell_ms, 0)), 0) dwell,
           count(distinct i.ticker) tickers
    from public.intraday i
    where not i.deleted
      and i.ts >= (select ms from nw) - 30::bigint * 86400000
    group by 1
  ),
  latest as (
    select distinct on (ticker) ticker, price_at_event p
    from public.events
    where not deleted and price_at_event is not null
    order by ticker, ts desc
  ),
  hr as (
    select e.user_id,
      count(*) filter (where e.sentiment in ('positive', 'negative')
                         and e.price_at_event is not null and l.p is not null
                         and l.p <> e.price_at_event) n,
      count(*) filter (where e.price_at_event is not null and l.p is not null
                         and ((e.sentiment = 'positive' and l.p > e.price_at_event)
                           or (e.sentiment = 'negative' and l.p < e.price_at_event))) hits
    from public.events e
    left join latest l on l.ticker = e.ticker
    where not e.deleted
      and e.ts >= (select ms from nw) - 30::bigint * 86400000
    group by 1
  ),
  ranked as (
    select p.user_id, p.views, p.dwell, p.tickers,
      case when coalesce(h.n, 0) > 0 then h.hits::numeric / h.n end hit_rate,
      rank() over (order by p.views desc) r_views,
      rank() over (order by p.dwell desc) r_dwell,
      rank() over (order by p.tickers desc) r_tickers
    from per p
    left join hr h on h.user_id = p.user_id
  ),
  hr_ranked as (
    select user_id, rank() over (order by hit_rate desc) r_hit,
      count(*) over () hit_users
    from ranked where hit_rate is not null
  )
  select jsonb_build_object(
    'users', (select count(*) from per),
    'views', (select views from ranked where user_id = auth.uid()),
    'views_rank', (select r_views from ranked where user_id = auth.uid()),
    'dwell_min', (select round(dwell::numeric / 60000, 1) from ranked where user_id = auth.uid()),
    'dwell_rank', (select r_dwell from ranked where user_id = auth.uid()),
    'tickers', (select tickers from ranked where user_id = auth.uid()),
    'tickers_rank', (select r_tickers from ranked where user_id = auth.uid()),
    'hit_rate', (select round(hit_rate, 4) from ranked where user_id = auth.uid()),
    'hit_rank', (select r_hit from hr_ranked where user_id = auth.uid()),
    'hit_users', (select hit_users from hr_ranked where user_id = auth.uid())
  );
$$;
grant execute on function public.network_percentiles() to authenticated;

create or replace function public.network_community_index()
returns table(ticker text, users bigint, views bigint, first_ts bigint,
              entry_price double precision, last_price double precision, ret numeric)
language sql stable security definer set search_path to 'public'
as $$
  with tot as (
    select e.ticker, count(distinct e.user_id) users,
           coalesce(sum(coalesce(e.views, 1)), 0)::bigint views
    from public.events e
    where not e.deleted
    group by 1
    having public.is_admin() or count(distinct e.user_id) >= 3
  ),
  entry as (
    select distinct on (ticker) ticker, ts first_ts, price_at_event entry_p
    from public.events
    where not deleted and price_at_event is not null
    order by ticker, ts asc
  ),
  latest as (
    select distinct on (ticker) ticker, price_at_event last_p
    from public.events
    where not deleted and price_at_event is not null
    order by ticker, ts desc
  )
  select t.ticker, t.users, t.views, en.first_ts, en.entry_p, l.last_p,
    round(((l.last_p - en.entry_p) / nullif(en.entry_p, 0))::numeric, 4) ret
  from tot t
  join entry en on en.ticker = t.ticker
  join latest l on l.ticker = t.ticker
  order by t.views desc
  limit 20;
$$;
grant execute on function public.network_community_index() to authenticated;

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
    select e.ticker, coalesce(e.views, 1) v, e.sentiment,
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
revoke execute on function public.network_community_daily() from public, anon;
grant execute on function public.network_community_daily() to authenticated;

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
  )
  select d.ticker,
         (extract(epoch from d.day) * 1000)::bigint + 86399999 ts,
         case when d.pos > d.neg then 'positive'
              when d.neg > d.pos then 'negative'
              else 'neutral' end sentiment
  from d
  order by d.ticker, d.day;
$$;
grant execute on function public.network_community_sentiment() to authenticated;
