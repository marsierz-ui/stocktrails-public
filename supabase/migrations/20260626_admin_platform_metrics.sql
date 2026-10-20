-- GROUP E: platform health metrics + feature-usage analytics. Both return a
-- single jsonb object and are admin-gated (data is empty for non-admins).

create or replace function public.admin_platform_metrics()
returns jsonb
language sql stable security definer set search_path to 'public'
as $$
  with e as (select * from public.events where not deleted and public.is_admin()),
  lat as (
    select (updated_at - ts) / 60000.0 as mins
    from e where updated_at is not null and ts is not null and updated_at >= ts
  ),
  custom as (
    select source, count(*) c from e
    where source is not null
      and lower(source) <> all (array['yahoo finance','google finance','marketwatch','cnbc','bloomberg',
        'stockanalysis','marketbeat','finviz','perplexity finance','tradingview','seeking alpha','nasdaq',
        'stocktwits','wsj'])
    group by source
  )
  select jsonb_build_object(
    'sync_latency_p50_minutes', (select percentile_cont(0.5) within group (order by mins) from lat),
    'sync_latency_p95_minutes', (select percentile_cont(0.95) within group (order by mins) from lat),
    'custom_portal_count', (select count(*) from custom),
    'top_custom_portals', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('source', source, 'event_count', c) x from custom order by c desc limit 5
      ) y), '[]'::jsonb),
    'pct_events_with_sentiment', (select count(*) filter (where sentiment is not null)::double precision / nullif(count(*),0) from e),
    'pct_events_with_position_taken', (select count(*) filter (where position_taken is true)::double precision / nullif(count(*),0) from e),
    'pct_events_with_target_price', (select count(*) filter (where target_price is not null)::double precision / nullif(count(*),0) from e),
    'avg_fields_filled', (select avg(
        (case when scroll_depth is not null then 1 else 0 end)
      + (case when focus_switches is not null then 1 else 0 end)
      + (case when sector is not null then 1 else 0 end)
      + (case when week52_position is not null then 1 else 0 end)
      + (case when sentiment is not null then 1 else 0 end)
      + (case when position_taken is true then 1 else 0 end)
      + (case when target_price is not null then 1 else 0 end)
    )::double precision from e)
  );
$$;

create or replace function public.admin_feature_usage()
returns jsonb
language sql stable security definer set search_path to 'public'
as $$
  with fu as (select * from public.feature_usage where public.is_admin()),
  active as (select distinct user_id from fu where ts >= now() - interval '30 days'),
  active_n as (select count(*) n from active),
  totals as (select section, count(*) total_events, count(distinct user_id) unique_users from fu group by section),
  seq as (select user_id, section, lag(section) over (partition by user_id order by ts) as prev from fu),
  trans as (
    select section, prev, count(*) c,
      row_number() over (partition by section order by count(*) desc) rn
    from seq where prev is not null group by section, prev
  ),
  ranks as (
    select user_id, ntile(5) over (order by count(*) desc) tile
    from public.events where not deleted and public.is_admin() group by user_id
  ),
  power as (select user_id from ranks where tile = 1),
  power_n as (select count(*) n from power),
  padopt as (
    select t.section,
      count(distinct fu2.user_id) filter (where fu2.user_id in (select user_id from power)) pu
    from totals t left join fu fu2 on fu2.section = t.section
    group by t.section
  )
  select jsonb_build_object(
    'section_totals', coalesce((select jsonb_agg(jsonb_build_object(
        'section', section, 'total_events', total_events, 'unique_users', unique_users,
        'pct_of_active_users', unique_users::double precision / nullif((select n from active_n), 0)
      ) order by total_events desc) from totals), '[]'::jsonb),
    'top_transitions', coalesce((select jsonb_agg(jsonb_build_object(
        'section', section, 'prev', prev, 'count', c)) from trans where rn = 1), '[]'::jsonb),
    'power_user_adoption', coalesce((select jsonb_agg(jsonb_build_object(
        'section', section, 'adoption', pu::double precision / nullif((select n from power_n), 0))) from padopt), '[]'::jsonb)
  );
$$;
