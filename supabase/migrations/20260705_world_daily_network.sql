-- World replay + Network RPCs.
--
-- world_country_daily powers the World tab's replayable time axis: one row per
-- (UTC day, country) with attention volume (from intraday: one row per view),
-- label hit-rate ingredients and return-per-view (from events, using the
-- latest community-observed price per ticker as the "price now" proxy - the
-- same source lead-lag proxies use, but anchored at the newest observation so
-- recent days have values too). world_country_top_stock_daily returns the
-- most-viewed ticker per (day, country) for the popup mode.
--
-- world_trending: today's attention per ticker vs its trailing 7-day daily
-- average ((today+1)/(avg+1) so new names rank without dividing by zero).
--
-- network_percentiles: the calling user's 30d stats and percent_rank vs all
-- users. network_community_index: top community holdings with entry (first
-- community view with a price) and return since.
--
-- All gated by public.is_admin() while World/Network are admin-only; opening
-- them up later means relaxing the guard (and adding a k-anonymity floor).

create or replace function public.world_country_daily(p_days int)
returns table(day date, country text, users bigint, views bigint, dwell_ms bigint,
              labelled bigint, hits bigint, ret_sum numeric, ret_n bigint)
language sql stable security definer set search_path to 'public'
as $$
  with nw as (select (extract(epoch from now()) * 1000)::bigint ms),
  frm as (select (select ms from nw) - p_days::bigint * 86400000 f),
  att as (
    select (to_timestamp(i.ts / 1000.0) at time zone 'UTC')::date d, um.country cc,
           count(distinct i.user_id) users, count(*) views,
           coalesce(sum(coalesce(i.dwell_ms, 0)), 0)::bigint dwell_ms
    from public.intraday i
    join public.user_meta um on um.user_id = i.user_id
    where public.is_admin() and not i.deleted and i.ts >= (select f from frm)
      and um.country is not null
    group by 1, 2
  ),
  latest as (
    select distinct on (ticker) ticker, price_at_event p
    from public.events
    where not deleted and price_at_event is not null
    order by ticker, ts desc
  ),
  ev as (
    -- l.p = price_at_event means the label IS the newest observation (no move
    -- observed yet): excluded from labelled, else fresh labels read as 0% hits.
    select (to_timestamp(e.ts / 1000.0) at time zone 'UTC')::date d, um.country cc,
      count(*) filter (where e.sentiment in ('positive', 'negative')
                         and e.price_at_event is not null and l.p is not null
                         and l.p <> e.price_at_event) labelled,
      count(*) filter (where e.price_at_event is not null and l.p is not null
                         and ((e.sentiment = 'positive' and l.p > e.price_at_event)
                           or (e.sentiment = 'negative' and l.p < e.price_at_event))) hits,
      coalesce(sum((l.p - e.price_at_event) / nullif(e.price_at_event, 0))
                 filter (where e.price_at_event is not null and l.p is not null), 0)::numeric ret_sum,
      count(*) filter (where e.price_at_event is not null and l.p is not null) ret_n
    from public.events e
    join public.user_meta um on um.user_id = e.user_id
    left join latest l on l.ticker = e.ticker
    where public.is_admin() and not e.deleted and e.ts >= (select f from frm)
      and um.country is not null
    group by 1, 2
  )
  select coalesce(a.d, e.d) as day, coalesce(a.cc, e.cc) as country,
    coalesce(a.users, 0) users, coalesce(a.views, 0) views, coalesce(a.dwell_ms, 0) dwell_ms,
    coalesce(e.labelled, 0) labelled, coalesce(e.hits, 0) hits,
    coalesce(e.ret_sum, 0) ret_sum, coalesce(e.ret_n, 0) ret_n
  from att a
  full join ev e on e.d = a.d and e.cc = a.cc
  order by 1, 2;
$$;
grant execute on function public.world_country_daily(int) to authenticated;

create or replace function public.world_country_top_stock_daily(p_days int)
returns table(day date, country text, ticker text, views bigint)
language sql stable security definer set search_path to 'public'
as $$
  with per as (
    select (to_timestamp(i.ts / 1000.0) at time zone 'UTC')::date d, um.country cc,
           i.ticker, count(*) views
    from public.intraday i
    join public.user_meta um on um.user_id = i.user_id
    where public.is_admin() and not i.deleted
      and i.ts >= (extract(epoch from now()) * 1000)::bigint - p_days::bigint * 86400000
      and um.country is not null
    group by 1, 2, 3
  )
  select distinct on (d, cc) d as day, cc as country, ticker, views
  from per
  order by d, cc, views desc, ticker;
$$;
grant execute on function public.world_country_top_stock_daily(int) to authenticated;

create or replace function public.world_trending()
returns table(ticker text, views_today bigint, users_today bigint, avg_prior numeric, score numeric)
language sql stable security definer set search_path to 'public'
as $$
  with day0 as (select (extract(epoch from date_trunc('day', now() at time zone 'UTC')) * 1000)::bigint ms),
  today as (
    select i.ticker, count(*) v, count(distinct i.user_id) u
    from public.intraday i
    where public.is_admin() and not i.deleted and i.ts >= (select ms from day0)
    group by 1
  ),
  prior as (
    select i.ticker, count(*)::numeric / 7 av
    from public.intraday i
    where public.is_admin() and not i.deleted
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
    where public.is_admin() and not i.deleted
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
    where public.is_admin() and not e.deleted
      and e.ts >= (select ms from nw) - 30::bigint * 86400000
    group by 1
  ),
  -- rank() (1 = best) + total: the client shows "#K of N" for small
  -- communities, where "top X%" from percent_rank is misleading (a sole user
  -- would read as top 100%).
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
    where public.is_admin() and not e.deleted
    group by 1
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
