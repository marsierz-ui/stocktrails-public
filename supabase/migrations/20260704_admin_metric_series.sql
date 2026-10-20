-- Clickable-KPI drilldown support for the admin Insights tab.
--
-- admin_metric_totals()  -> jsonb of current (last-30d) values for every KPI in
--   the Dashboard / Event / Attention metric groups, so each card shows a number.
-- admin_metric_series()  -> per-bucket time series for one metric, feeding the
--   drilldown chart that pops up when a metric card is clicked. p_unit matches the
--   chart's bucket granularity (hour/day/month), so exactly one row per bucket.
--
-- Metrics come from two tables: public.events (event/attention metrics) and
-- public.feature_usage (dashboard/interaction metrics). "New users" = first-ever
-- event, consistent with admin_engagement_overview / admin_marketing_kpis.
-- feedback_open / feedback_sent are feature_usage sections written by the
-- dashboard feedback flow; feedback_ratio = sent / opened.

create or replace function public.admin_metric_totals()
returns jsonb language sql stable security definer set search_path to 'public'
as $$
  with nw as (select (extract(epoch from now()) * 1000)::bigint ms),
  e as (select * from public.events
        where not deleted and public.is_admin() and ts >= (select ms from nw) - 30::bigint*86400000),
  firsts as (select user_id, min(ts) mn from public.events where not deleted and public.is_admin() group by user_id),
  fu as (select * from public.feature_usage
         where public.is_admin() and ts >= now() - interval '30 days'),
  agg as (
    select count(*) events,
      count(*) filter (where sentiment is not null) labelled,
      count(*) filter (where position_taken is true) position_taken,
      count(*) filter (where target_price is not null) target_price,
      count(distinct user_id) active_users,
      count(distinct ticker) active_tickers,
      coalesce(sum(coalesce(views,1)),0) views,
      coalesce(sum(coalesce(dwell_ms,0)),0) dwell
    from e
  ),
  fagg as (
    select count(*) navs,
      count(*) filter (where section = 'feedback_open') fopen,
      count(*) filter (where section = 'feedback_sent') fsent
    from fu
  )
  select jsonb_build_object(
    'active_users', (select active_users from agg),
    'new_users', (select count(*) from firsts where mn >= (select ms from nw) - 30::bigint*86400000),
    'feature_navigations', (select navs from fagg),
    'feedback_open', (select fopen from fagg),
    'feedback_sent', (select fsent from fagg),
    'feedback_ratio', (select round((select fsent from fagg)::numeric / nullif((select fopen from fagg), 0), 4)),
    'events', (select events from agg),
    'labelled', (select labelled from agg),
    'label_rate', (select round((select labelled from agg)::numeric / nullif((select events from agg), 0), 4)),
    'position_taken', (select position_taken from agg),
    'target_price', (select target_price from agg),
    'views', (select views from agg),
    'dwell_min', (select round((select dwell from agg)::numeric / 60000, 1)),
    'active_tickers', (select active_tickers from agg),
    'avg_dwell_min', (select round((select dwell from agg)::numeric / nullif((select events from agg), 0) / 60000, 2))
  );
$$;
grant execute on function public.admin_metric_totals() to authenticated;

create or replace function public.admin_metric_series(p_metric text, p_from bigint, p_to bigint, p_unit text)
returns table(bucket timestamptz, value numeric)
language sql stable security definer set search_path to 'public'
as $$
  with p as (select case when p_unit in ('hour','day','week','month','year') then p_unit else 'day' end unit),
  ev as (
    select date_trunc((select unit from p), to_timestamp(ts / 1000.0)) b,
      count(*) events,
      count(*) filter (where sentiment is not null) labelled,
      count(*) filter (where position_taken is true) position_taken,
      count(*) filter (where target_price is not null) target_price,
      count(distinct user_id) active_users,
      count(distinct ticker) tickers,
      sum(coalesce(views, 1)) views,
      sum(coalesce(dwell_ms, 0)) dwell
    from public.events
    where not deleted and public.is_admin() and ts >= p_from and ts < p_to
    group by 1
  ),
  firsts as (select user_id, min(ts) mn from public.events where not deleted and public.is_admin() group by user_id),
  nu as (
    select date_trunc((select unit from p), to_timestamp(mn / 1000.0)) b, count(*) new_users
    from firsts where mn >= p_from and mn < p_to group by 1
  ),
  fu as (
    select date_trunc((select unit from p), ts) b,
      count(*) navs,
      count(*) filter (where section = 'feedback_open') fopen,
      count(*) filter (where section = 'feedback_sent') fsent
    from public.feature_usage
    where public.is_admin() and ts >= to_timestamp(p_from / 1000.0) and ts < to_timestamp(p_to / 1000.0)
    group by 1
  ),
  spine as (
    select distinct b from (select b from ev union all select b from nu union all select b from fu) x
  )
  select s.b,
    (case p_metric
      when 'active_users' then coalesce(ev.active_users, 0)
      when 'new_users' then coalesce(nu.new_users, 0)
      when 'feature_navigations' then coalesce(fu.navs, 0)
      when 'feedback_open' then coalesce(fu.fopen, 0)
      when 'feedback_sent' then coalesce(fu.fsent, 0)
      when 'feedback_ratio' then round(coalesce(fu.fsent, 0)::numeric / nullif(fu.fopen, 0), 4)
      when 'events' then coalesce(ev.events, 0)
      when 'labelled' then coalesce(ev.labelled, 0)
      when 'label_rate' then round(coalesce(ev.labelled, 0)::numeric / nullif(ev.events, 0), 4)
      when 'position_taken' then coalesce(ev.position_taken, 0)
      when 'target_price' then coalesce(ev.target_price, 0)
      when 'views' then coalesce(ev.views, 0)
      when 'dwell_min' then round(coalesce(ev.dwell, 0)::numeric / 60000, 1)
      when 'active_tickers' then coalesce(ev.tickers, 0)
      when 'avg_dwell_min' then round(coalesce(ev.dwell, 0)::numeric / nullif(ev.events, 0) / 60000, 2)
      else 0
    end)::numeric
  from spine s
  left join ev on ev.b = s.b
  left join nu on nu.b = s.b
  left join fu on fu.b = s.b
  order by s.b;
$$;
grant execute on function public.admin_metric_series(text, bigint, bigint, text) to authenticated;
