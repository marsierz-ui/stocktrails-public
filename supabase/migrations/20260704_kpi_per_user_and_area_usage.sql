-- Per-user KPIs + dashboard area-usage.
--
-- Absolute counts conflate volume with the size of the user base, so the count
-- metrics are now expressed per active user (total / distinct active users in
-- the same window/bucket). Metrics that are already normalized stay as-is:
--   active_users / new_users  -> absolute (they ARE the user base)
--   label_rate / feedback_ratio -> ratios
--   avg_dwell_min             -> per event
-- active_tickers is the average over users of their distinct-ticker count (not
-- distinct tickers / users, which would undercount shared names).
--
-- admin_area_usage aggregates the area:* / click:* feature_usage sections the
-- dashboard emits (IntersectionObserver dwell credits + delegated clicks), per
-- area, on a per-user basis over the last 30 days.

create or replace function public.admin_metric_totals()
returns jsonb language sql stable security definer set search_path to 'public'
as $$
  with nw as (select (extract(epoch from now()) * 1000)::bigint ms),
  e as (select * from public.events
        where not deleted and public.is_admin() and ts >= (select ms from nw) - 30::bigint*86400000),
  firsts as (select user_id, min(ts) mn from public.events where not deleted and public.is_admin() group by user_id),
  fu as (select * from public.feature_usage
         where public.is_admin() and ts >= now() - interval '30 days'),
  tk as (select user_id, count(distinct ticker) c from e group by user_id),
  agg as (
    select count(*) events,
      count(*) filter (where sentiment is not null) labelled,
      count(*) filter (where position_taken is true) position_taken,
      count(*) filter (where target_price is not null) target_price,
      count(distinct user_id) active_users,
      coalesce(sum(coalesce(views,1)),0) views,
      coalesce(sum(coalesce(dwell_ms,0)),0) dwell
    from e
  ),
  fagg as (
    select count(*) navs, count(distinct user_id) users,
      count(*) filter (where section = 'feedback_open') fopen,
      count(*) filter (where section = 'feedback_sent') fsent
    from fu
  )
  select jsonb_build_object(
    'active_users', (select active_users from agg),
    'new_users', (select count(*) from firsts where mn >= (select ms from nw) - 30::bigint*86400000),
    'feature_navigations', (select round(navs::numeric / nullif(users, 0), 2) from fagg),
    'feedback_open', (select round(fopen::numeric / nullif(users, 0), 2) from fagg),
    'feedback_sent', (select round(fsent::numeric / nullif(users, 0), 2) from fagg),
    'feedback_ratio', (select round((select fsent from fagg)::numeric / nullif((select fopen from fagg), 0), 4)),
    'events', (select round(events::numeric / nullif(active_users, 0), 2) from agg),
    'labelled', (select round(labelled::numeric / nullif(active_users, 0), 2) from agg),
    'label_rate', (select round((select labelled from agg)::numeric / nullif((select events from agg), 0), 4)),
    'position_taken', (select round(position_taken::numeric / nullif(active_users, 0), 2) from agg),
    'target_price', (select round(target_price::numeric / nullif(active_users, 0), 2) from agg),
    'views', (select round(views::numeric / nullif(active_users, 0), 1) from agg),
    'dwell_min', (select round(dwell::numeric / 60000 / nullif(active_users, 0), 1) from agg),
    'active_tickers', (select round(avg(c), 1) from tk),
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
      sum(coalesce(views, 1)) views,
      sum(coalesce(dwell_ms, 0)) dwell
    from public.events
    where not deleted and public.is_admin() and ts >= p_from and ts < p_to
    group by 1
  ),
  evu as (
    select date_trunc((select unit from p), to_timestamp(ts / 1000.0)) b, user_id, count(distinct ticker) tk
    from public.events
    where not deleted and public.is_admin() and ts >= p_from and ts < p_to
    group by 1, 2
  ),
  evu_agg as (select b, avg(tk) avg_tk from evu group by b),
  firsts as (select user_id, min(ts) mn from public.events where not deleted and public.is_admin() group by user_id),
  nu as (
    select date_trunc((select unit from p), to_timestamp(mn / 1000.0)) b, count(*) new_users
    from firsts where mn >= p_from and mn < p_to group by 1
  ),
  fu as (
    select date_trunc((select unit from p), ts) b,
      count(*) navs, count(distinct user_id) users,
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
      when 'feature_navigations' then round(coalesce(fu.navs, 0)::numeric / nullif(fu.users, 0), 2)
      when 'feedback_open' then round(coalesce(fu.fopen, 0)::numeric / nullif(fu.users, 0), 2)
      when 'feedback_sent' then round(coalesce(fu.fsent, 0)::numeric / nullif(fu.users, 0), 2)
      when 'feedback_ratio' then round(coalesce(fu.fsent, 0)::numeric / nullif(fu.fopen, 0), 4)
      when 'events' then round(coalesce(ev.events, 0)::numeric / nullif(ev.active_users, 0), 2)
      when 'labelled' then round(coalesce(ev.labelled, 0)::numeric / nullif(ev.active_users, 0), 2)
      when 'label_rate' then round(coalesce(ev.labelled, 0)::numeric / nullif(ev.events, 0), 4)
      when 'position_taken' then round(coalesce(ev.position_taken, 0)::numeric / nullif(ev.active_users, 0), 2)
      when 'target_price' then round(coalesce(ev.target_price, 0)::numeric / nullif(ev.active_users, 0), 2)
      when 'views' then round(coalesce(ev.views, 0)::numeric / nullif(ev.active_users, 0), 1)
      when 'dwell_min' then round(coalesce(ev.dwell, 0)::numeric / 60000 / nullif(ev.active_users, 0), 1)
      when 'active_tickers' then round(coalesce(evu_agg.avg_tk, 0), 1)
      when 'avg_dwell_min' then round(coalesce(ev.dwell, 0)::numeric / nullif(ev.events, 0) / 60000, 2)
      else 0
    end)::numeric
  from spine s
  left join ev on ev.b = s.b
  left join evu_agg on evu_agg.b = s.b
  left join nu on nu.b = s.b
  left join fu on fu.b = s.b
  order by s.b;
$$;
grant execute on function public.admin_metric_series(text, bigint, bigint, text) to authenticated;

create or replace function public.admin_area_usage()
returns table(area text, users bigint, dwell_per_user numeric, clicks_per_user numeric, total_users bigint)
language sql stable security definer set search_path to 'public'
as $$
  with fu as (
    select
      case when section like 'area:%' then substr(section, 6)
           when section like 'click:%' then substr(section, 7) end area,
      case when section like 'area:%' then 'dwell' else 'click' end kind,
      user_id
    from public.feature_usage
    where public.is_admin()
      and (section like 'area:%' or section like 'click:%')
      and ts >= now() - interval '30 days'
  ),
  base as (select count(distinct user_id) tu from fu),
  agg as (
    select area,
      count(distinct user_id) users,
      count(*) filter (where kind = 'dwell') dwell_n,
      count(*) filter (where kind = 'click') click_n,
      count(distinct user_id) filter (where kind = 'dwell') dwell_u,
      count(distinct user_id) filter (where kind = 'click') click_u
    from fu where area is not null and area <> '' group by area
  )
  select area, users,
    round(dwell_n::numeric / nullif(dwell_u, 0), 1) dwell_per_user,
    round(click_n::numeric / nullif(click_u, 0), 1) clicks_per_user,
    (select tu from base) total_users
  from agg order by dwell_n desc, click_n desc;
$$;
grant execute on function public.admin_area_usage() to authenticated;
