-- GROUP F2: user quality & engagement depth.

create or replace function public.admin_engagement_overview()
returns jsonb language sql stable security definer set search_path to 'public'
as $$
  with nw as (select (extract(epoch from now()) * 1000)::bigint ms),
  e as (select * from public.events where not deleted and public.is_admin()),
  per_user_30 as (
    select user_id, count(*) ev, count(distinct date_trunc('day', to_timestamp(ts/1000))) ad
    from e where ts >= (select ms from nw) - 30::bigint*86400000 group by user_id
  ),
  per_user_life as (select user_id, count(distinct ticker) tk from e group by user_id),
  firsts as (select user_id, min(ts) mn from e group by user_id),
  d8_14 as (select distinct user_id from e
    where ts < (select ms from nw) - 7::bigint*86400000 and ts >= (select ms from nw) - 14::bigint*86400000),
  last7 as (select distinct user_id from e where ts >= (select ms from nw) - 7::bigint*86400000),
  dau as (select count(distinct user_id) c from e where ts >= (select ms from nw) - 1::bigint*86400000),
  mau as (select count(distinct user_id) c from e where ts >= (select ms from nw) - 30::bigint*86400000)
  select jsonb_build_object(
    'dau', (select c from dau),
    'wau', (select count(distinct user_id) from e where ts >= (select ms from nw) - 7::bigint*86400000),
    'mau', (select c from mau),
    'dau_mau_ratio', round((select c from dau)::numeric / nullif((select c from mau), 0), 4),
    'median_events_per_active_day', (select percentile_cont(0.5) within group (order by ev::numeric / nullif(ad,0)) from per_user_30),
    'median_tickers_per_user_lifetime', (select percentile_cont(0.5) within group (order by tk) from per_user_life),
    'new_users_this_week', (select count(*) from firsts where mn >= (select ms from nw) - 7::bigint*86400000),
    'new_users_this_month', (select count(*) from firsts where mn >= (select ms from nw) - 30::bigint*86400000),
    'churned_users_this_week', (select count(*) from d8_14 where user_id not in (select user_id from last7))
  );
$$;

create or replace function public.admin_sentiment_funnel()
returns jsonb language sql stable security definer set search_path to 'public'
as $$
  with e as (select * from public.events where not deleted and public.is_admin()),
  tot as (select count(*) c from e),
  per_user as (
    select user_id, min(ts) mn, min(ts) filter (where sentiment is not null) mnl
    from e group by user_id
  )
  select jsonb_build_object(
    'total_events', (select c from tot),
    'events_with_dwell_30s', (select count(*) from e where dwell_ms >= 30000),
    'events_with_sentiment', (select count(*) from e where sentiment is not null),
    'events_with_position_taken', (select count(*) from e where position_taken is true),
    'events_with_target_price', (select count(*) from e where target_price is not null),
    'pct_dwell_30s', (select count(*) from e where dwell_ms >= 30000)::numeric / nullif((select c from tot), 0),
    'pct_sentiment', (select count(*) from e where sentiment is not null)::numeric / nullif((select c from tot), 0),
    'pct_position_taken', (select count(*) from e where position_taken is true)::numeric / nullif((select c from tot), 0),
    'pct_target_price', (select count(*) from e where target_price is not null)::numeric / nullif((select c from tot), 0),
    'median_hours_to_first_label', (select percentile_cont(0.5) within group (order by (mnl - mn)/3600000.0) from per_user where mnl is not null),
    'label_edit_rate', (select count(*) filter (where sentiment_prev is not null)::numeric / nullif(count(*) filter (where sentiment is not null), 0) from e)
  );
$$;

create or replace function public.admin_user_quality_distribution()
returns table(urow bigint, total_events bigint, active_days bigint, unique_tickers bigint, total_dwell_ms bigint,
  pct_labelled double precision, pct_position_taken double precision, is_power_user boolean, acquisition_portal text)
language sql stable security definer set search_path to 'public'
as $$
  with e as (select * from public.events where not deleted and public.is_admin()),
  per_user as (
    select user_id, count(*) te, count(distinct date_trunc('day', to_timestamp(ts/1000))) ad,
      count(distinct ticker) ut, coalesce(sum(dwell_ms),0) td,
      count(*) filter (where sentiment is not null)::double precision / nullif(count(*),0) pl,
      count(*) filter (where position_taken is true)::double precision / nullif(count(*),0) pp
    from e group by user_id
  ),
  thr as (select percentile_cont(0.8) within group (order by te) p80 from per_user),
  acq as (select distinct on (user_id) user_id, source from e order by user_id, ts asc)
  select row_number() over (order by p.te desc), p.te, p.ad, p.ut, p.td, p.pl, p.pp,
    (p.te >= (select p80 from thr)), a.source
  from per_user p left join acq a on a.user_id = p.user_id
  order by p.te desc;
$$;
