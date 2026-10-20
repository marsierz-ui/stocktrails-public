-- GROUP F5: behavioural patterns (sessions, sector clustering, action lag,
-- recurring vs discovery, weekend usage) + aggregate sector attention over time.

create or replace function public.admin_session_stats()
returns jsonb language sql stable security definer set search_path to 'public'
as $$
  with nw as (select (extract(epoch from now())*1000)::bigint ms),
  i as (select * from public.intraday where not deleted and public.is_admin() and session_id is not null),
  per_sess as (
    select user_id, session_id, count(distinct ticker) tks, coalesce(sum(dwell_ms),0) dw,
      count(distinct source) pts, min(ts) mn
    from i group by user_id, session_id
  ),
  starts as (select distinct on (user_id, session_id) user_id, session_id, source from i order by user_id, session_id, ts asc),
  s30 as (select count(*) c from per_sess where mn >= (select ms from nw) - 30::bigint*86400000),
  mau as (select count(distinct user_id) c from public.events where not deleted and public.is_admin() and ts >= (select ms from nw) - 30::bigint*86400000)
  select jsonb_build_object(
    'avg_tickers_per_session', (select avg(tks) from per_sess),
    'avg_session_dwell_ms', (select avg(dw) from per_sess),
    'avg_portals_per_session', (select avg(pts) from per_sess),
    'most_common_session_start_portal', (select mode() within group (order by source) from starts),
    'sessions_last_30d', (select c from s30),
    'avg_sessions_per_active_user_per_week', (select c from s30)::numeric / 4 / nullif((select c from mau), 0)
  );
$$;

create or replace function public.admin_sector_clustering()
returns jsonb language sql stable security definer set search_path to 'public'
as $$
  with i as (select * from public.intraday where not deleted and public.is_admin() and session_id is not null),
  sess as (
    select user_id, session_id,
      mode() within group (order by sector) filter (where sector is not null) dom,
      count(distinct sector) filter (where sector is not null) nsec,
      count(distinct ticker) tks, coalesce(sum(dwell_ms),0) dw
    from i group by user_id, session_id
  ),
  tot as (select count(*) c from sess)
  select jsonb_build_object(
    'by_sector', coalesce((select jsonb_agg(jsonb_build_object(
        'sector', dom, 'sessions_with_dominant_sector', cnt, 'pct_of_all_sessions', cnt::numeric/nullif((select c from tot),0),
        'avg_tickers_in_session', avtk, 'avg_dwell_ms', avdw) order by cnt desc)
      from (select dom, count(*) cnt, avg(tks) avtk, avg(dw) avdw from sess where dom is not null group by dom) z), '[]'::jsonb),
    'cross_sector_session_pct', (select count(*) filter (where nsec >= 2)::numeric / nullif(count(*),0) from sess)
  );
$$;

create or replace function public.admin_attention_to_action_lag()
returns jsonb language sql stable security definer set search_path to 'public'
as $$
  with e as (select * from public.events where not deleted and public.is_admin()),
  firsts as (select user_id, ticker, min(ts) mn from e group by user_id, ticker),
  pos as (select p.ts pts, f.mn from e p join firsts f on f.user_id = p.user_id and f.ticker = p.ticker where p.position_taken is true),
  lags as (select (pts - mn)/3600000.0 h from pos),
  tot as (select count(*) c from lags)
  select jsonb_build_object(
    'lag_distribution', jsonb_build_array(
      jsonb_build_object('bucket','<1h','count',(select count(*) from lags where h<1),'pct',(select count(*) from lags where h<1)::numeric/nullif((select c from tot),0)),
      jsonb_build_object('bucket','1-6h','count',(select count(*) from lags where h>=1 and h<6),'pct',(select count(*) from lags where h>=1 and h<6)::numeric/nullif((select c from tot),0)),
      jsonb_build_object('bucket','6-24h','count',(select count(*) from lags where h>=6 and h<24),'pct',(select count(*) from lags where h>=6 and h<24)::numeric/nullif((select c from tot),0)),
      jsonb_build_object('bucket','1-3d','count',(select count(*) from lags where h>=24 and h<72),'pct',(select count(*) from lags where h>=24 and h<72)::numeric/nullif((select c from tot),0)),
      jsonb_build_object('bucket','3-7d','count',(select count(*) from lags where h>=72 and h<168),'pct',(select count(*) from lags where h>=72 and h<168)::numeric/nullif((select c from tot),0)),
      jsonb_build_object('bucket','>7d','count',(select count(*) from lags where h>=168),'pct',(select count(*) from lags where h>=168)::numeric/nullif((select c from tot),0))
    ),
    'median_lag_hours', (select percentile_cont(0.5) within group (order by h) from lags),
    'p25_lag_hours', (select percentile_cont(0.25) within group (order by h) from lags),
    'p75_lag_hours', (select percentile_cont(0.75) within group (order by h) from lags),
    'pct_same_day_decisions', (select count(*) filter (where h<24)::numeric/nullif((select c from tot),0) from lags)
  );
$$;

create or replace function public.admin_recurring_vs_discovery()
returns jsonb language sql stable security definer set search_path to 'public'
as $$
  with uw as (
    select distinct user_id, ticker, date_trunc('week', to_timestamp(ts/1000))::date wk
    from public.events where not deleted and public.is_admin()
  ),
  flagged as (
    select user_id, ticker, wk,
      exists(select 1 from uw p where p.user_id = uw.user_id and p.ticker = uw.ticker and p.wk = uw.wk - interval '7 days') recurring
    from uw
  ),
  per_uw as (select user_id, wk, count(*) filter (where recurring) rec, count(*) filter (where not recurring) disc from flagged group by user_id, wk),
  per_user as (select user_id, avg(rec::numeric / nullif(rec+disc,0)) ur from per_uw where rec+disc > 0 group by user_id)
  select jsonb_build_object(
    'avg_recurring_rate', (select avg(ur) from per_user),
    'median_recurring_rate', (select percentile_cont(0.5) within group (order by ur) from per_user),
    'distribution', jsonb_build_array(
      jsonb_build_object('bucket','<20%','users',(select count(*) from per_user where ur<0.2)),
      jsonb_build_object('bucket','20-40%','users',(select count(*) from per_user where ur>=0.2 and ur<0.4)),
      jsonb_build_object('bucket','40-60%','users',(select count(*) from per_user where ur>=0.4 and ur<0.6)),
      jsonb_build_object('bucket','60-80%','users',(select count(*) from per_user where ur>=0.6 and ur<0.8)),
      jsonb_build_object('bucket','>80%','users',(select count(*) from per_user where ur>=0.8))
    )
  );
$$;

create or replace function public.admin_weekend_usage()
returns jsonb language sql stable security definer set search_path to 'public'
as $$
  with nw as (select (extract(epoch from now())*1000)::bigint ms),
  e as (select *, extract(dow from (to_timestamp(ts/1000) at time zone 'UTC')) dow from public.events where not deleted and public.is_admin()),
  scored as (
    select e.*,
      case when e.price_at_event is not null and e.price_at_event <> 0 and fut.fp is not null
        then (fut.fp - e.price_at_event)/e.price_at_event end ret
    from e left join lateral (select f.price_at_event fp from public.events f
      where f.ticker = e.ticker and not f.deleted and f.price_at_event is not null
        and f.ts >= e.ts + 30::bigint*86400000 order by f.ts desc limit 1) fut on true
  )
  select jsonb_build_object(
    'pct_events_on_weekend', (select count(*) filter (where dow in (0,6))::numeric/nullif(count(*),0) from e),
    'weekend_users', (select count(distinct user_id) from e where dow in (0,6) and ts >= (select ms from nw) - 30::bigint*86400000),
    'weekend_hit_rate_30d', (select count(*) filter (where dow in (0,6) and ((sentiment='positive' and ret>0) or (sentiment='negative' and ret<0)))::double precision
       / nullif(count(*) filter (where dow in (0,6) and sentiment in ('positive','negative') and ret is not null),0) from scored),
    'weekday_hit_rate_30d', (select count(*) filter (where dow not in (0,6) and ((sentiment='positive' and ret>0) or (sentiment='negative' and ret<0)))::double precision
       / nullif(count(*) filter (where dow not in (0,6) and sentiment in ('positive','negative') and ret is not null),0) from scored),
    'weekend_avg_dwell_ms', (select avg(dwell_ms) from e where dow in (0,6)),
    'weekday_avg_dwell_ms', (select avg(dwell_ms) from e where dow not in (0,6))
  );
$$;

-- Quick-fix #3: aggregate sector/industry attention over time (per bucket).
create or replace function public.admin_sector_over_time(p_from bigint, p_to bigint, p_unit text)
returns table(bucket timestamptz, sector text, n bigint, dwell bigint)
language sql stable security definer set search_path to 'public'
as $$
  select date_trunc(case when p_unit in ('hour','day','week','month','year') then p_unit else 'day' end, to_timestamp(ts/1000)) bucket,
    coalesce(sector,'Unknown') sector, count(*), coalesce(sum(dwell_ms),0)
  from public.events where not deleted and public.is_admin() and ts >= p_from and ts < p_to
  group by 1, 2 order by 1, 2;
$$;
