-- Digital-marketing KPIs for the admin Insights tab: day-N retention, weekly
-- churn rate, growth accounting (quick ratio, resurrected users), WoW/MoM
-- growth, engagement depth per active user, and a weekly acquisition trend.
-- "User birth" = first-ever event, consistent with admin_engagement_overview.

create or replace function public.admin_marketing_kpis()
returns jsonb language sql stable security definer set search_path to 'public'
as $$
  with nw as (select (extract(epoch from now()) * 1000)::bigint ms),
  e as (select user_id, ts, dwell_ms from public.events where not deleted and public.is_admin()),
  firsts as (select user_id, min(ts) mn, max(ts) mx from e group by user_id),
  ret_base as (
    select f.user_id, f.mn,
      exists (select 1 from e x where x.user_id = f.user_id
        and x.ts >= f.mn + 1::bigint*86400000 and x.ts < f.mn + 2::bigint*86400000) hit_d1,
      exists (select 1 from e x where x.user_id = f.user_id
        and x.ts >= f.mn + 7::bigint*86400000 and x.ts < f.mn + 14::bigint*86400000) hit_w1,
      exists (select 1 from e x where x.user_id = f.user_id
        and x.ts >= f.mn + 30::bigint*86400000 and x.ts < f.mn + 60::bigint*86400000) hit_m1
    from firsts f
  ),
  ret as (
    select
      count(*) filter (where r.mn <= w.ms - 2::bigint*86400000) d1_elig,
      count(*) filter (where r.mn <= w.ms - 2::bigint*86400000 and r.hit_d1) d1_hit,
      count(*) filter (where r.mn <= w.ms - 14::bigint*86400000) w1_elig,
      count(*) filter (where r.mn <= w.ms - 14::bigint*86400000 and r.hit_w1) w1_hit,
      count(*) filter (where r.mn <= w.ms - 60::bigint*86400000) m1_elig,
      count(*) filter (where r.mn <= w.ms - 60::bigint*86400000 and r.hit_m1) m1_hit
    from ret_base r cross join nw w
  ),
  last7 as (select distinct user_id from e where ts >= (select ms from nw) - 7::bigint*86400000),
  d8_14 as (select distinct user_id from e
    where ts < (select ms from nw) - 7::bigint*86400000 and ts >= (select ms from nw) - 14::bigint*86400000),
  d8_28 as (select distinct user_id from e
    where ts < (select ms from nw) - 7::bigint*86400000 and ts >= (select ms from nw) - 28::bigint*86400000),
  mau_now as (select count(distinct user_id) c from e where ts >= (select ms from nw) - 30::bigint*86400000),
  mau_prev as (select count(distinct user_id) c from e
    where ts < (select ms from nw) - 30::bigint*86400000 and ts >= (select ms from nw) - 60::bigint*86400000),
  new_wk as (select count(*) c from firsts where mn >= (select ms from nw) - 7::bigint*86400000),
  churn_wk as (select count(*) c from d8_14 where user_id not in (select user_id from last7)),
  resurrected as (
    select count(*) c from firsts f
    where f.mn < (select ms from nw) - 28::bigint*86400000
      and f.user_id in (select user_id from last7)
      and f.user_id not in (select user_id from d8_28)
  ),
  eng7 as (select count(*) ev, coalesce(sum(dwell_ms), 0) dw, count(distinct user_id) u
    from e where ts >= (select ms from nw) - 7::bigint*86400000),
  actdays as (
    select user_id, count(distinct date_trunc('day', to_timestamp(ts/1000))) ad
    from e where ts >= (select ms from nw) - 30::bigint*86400000 group by user_id
  ),
  wk_active as (
    select date_trunc('week', to_timestamp(ts/1000))::date wk, count(distinct user_id) au, count(*) ev
    from e where ts >= (select ms from nw) - 84::bigint*86400000 group by 1
  ),
  wk_new as (
    select date_trunc('week', to_timestamp(mn/1000))::date wk, count(*) nu
    from firsts where mn >= (select ms from nw) - 84::bigint*86400000 group by 1
  ),
  weekly as (
    select coalesce(a.wk, n.wk) wk, coalesce(a.au, 0) au, coalesce(n.nu, 0) nu, coalesce(a.ev, 0) ev
    from wk_active a full join wk_new n on n.wk = a.wk
  )
  select jsonb_build_object(
    'd1_retention', (select round(d1_hit::numeric / nullif(d1_elig, 0), 4) from ret),
    'd1_eligible', (select d1_elig from ret),
    'w1_retention', (select round(w1_hit::numeric / nullif(w1_elig, 0), 4) from ret),
    'w1_eligible', (select w1_elig from ret),
    'm1_retention', (select round(m1_hit::numeric / nullif(m1_elig, 0), 4) from ret),
    'm1_eligible', (select m1_elig from ret),
    'churn_rate_week', (select round((select c from churn_wk)::numeric / nullif((select count(*) from d8_14), 0), 4)),
    'resurrected_week', (select c from resurrected),
    'quick_ratio', (select round(((select c from new_wk) + (select c from resurrected))::numeric / nullif((select c from churn_wk), 0), 2)),
    'wau_wow_growth', (select round((select count(*) from last7)::numeric / nullif((select count(*) from d8_14), 0) - 1, 4)),
    'mau_mom_growth', (select round((select c from mau_now)::numeric / nullif((select c from mau_prev), 0) - 1, 4)),
    'wau_mau_ratio', (select round((select count(*) from last7)::numeric / nullif((select c from mau_now), 0), 4)),
    'events_per_wau', (select round(ev::numeric / nullif(u, 0), 1) from eng7),
    'dwell_min_per_wau', (select round(dw::numeric / 60000 / nullif(u, 0), 1) from eng7),
    'active_days_per_mau', (select round(avg(ad)::numeric, 1) from actdays),
    'power_user_pct', (select round((count(*) filter (where ad >= 10))::numeric / nullif(count(*), 0), 4) from actdays),
    'avg_lifetime_days', (select round(avg((mx - mn) / 86400000.0)::numeric, 1) from firsts),
    'weekly', (select coalesce(jsonb_agg(jsonb_build_object(
        'week', wk, 'new_users', nu, 'active_users', au, 'events', ev) order by wk), '[]'::jsonb) from weekly)
  );
$$;
grant execute on function public.admin_marketing_kpis() to authenticated;
