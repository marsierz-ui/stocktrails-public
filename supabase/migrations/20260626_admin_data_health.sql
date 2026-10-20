-- GROUP F4: data health & pipeline observability. updated_at/ts are epoch-ms
-- bigints, so latency math is plain ms arithmetic (no EXTRACT EPOCH).

create or replace function public.admin_field_fill_rates()
returns table(week date, field_name text, total_events bigint, filled_events bigint, fill_rate numeric)
language sql stable security definer set search_path to 'public'
as $$
  with nw as (select (extract(epoch from now())*1000)::bigint ms),
  e as (select *, date_trunc('week', to_timestamp(ts/1000))::date wk from public.events
        where not deleted and public.is_admin() and ts >= (select ms from nw) - 84::bigint*86400000),
  base as (
    select wk, count(*) total,
      count(scroll_depth) f_scroll, count(focus_switches) f_focus, count(sector) f_sector,
      count(week52_position) f_w52, count(sentiment) f_sent, count(position_taken) f_pos,
      count(target_price) f_tgt, count(market_cap_bucket) f_cap
    from e group by wk
  ),
  ei as (
    select date_trunc('week', to_timestamp(ts/1000))::date wk, count(*) total, count(portal_path) f_pp
    from public.intraday where not deleted and public.is_admin() and ts >= (select ms from nw) - 84::bigint*86400000
    group by 1
  )
  select wk, 'scroll_depth', total, f_scroll, f_scroll::numeric/nullif(total,0) from base
  union all select wk, 'focus_switches', total, f_focus, f_focus::numeric/nullif(total,0) from base
  union all select wk, 'sector', total, f_sector, f_sector::numeric/nullif(total,0) from base
  union all select wk, 'week52_position', total, f_w52, f_w52::numeric/nullif(total,0) from base
  union all select wk, 'sentiment', total, f_sent, f_sent::numeric/nullif(total,0) from base
  union all select wk, 'position_taken', total, f_pos, f_pos::numeric/nullif(total,0) from base
  union all select wk, 'target_price', total, f_tgt, f_tgt::numeric/nullif(total,0) from base
  union all select wk, 'market_cap_bucket', total, f_cap, f_cap::numeric/nullif(total,0) from base
  union all select wk, 'portal_path', total, f_pp, f_pp::numeric/nullif(total,0) from ei
  order by 1 desc, 5 asc nulls first;
$$;

create or replace function public.admin_sync_health()
returns jsonb language sql stable security definer set search_path to 'public'
as $$
  with e as (select * from public.events where not deleted and public.is_admin()),
  i as (select * from public.intraday where not deleted and public.is_admin()),
  lat as (select (updated_at - ts)/60000.0 mins from e where updated_at >= ts),
  dup_groups as (select count(*) cc from i group by user_id, ticker, date_trunc('minute', to_timestamp(ts/1000)) having count(*) > 1),
  orphan as (select count(*) c from (select user_id, max(updated_at) mu, max(ts) mt from e group by user_id having max(ts) - max(updated_at) > 24*3600*1000) o)
  select jsonb_build_object(
    'pct_events_synced_within_5min', (select count(*) filter (where (updated_at-ts) <= 300000)::numeric / nullif(count(*),0) from e),
    'pct_events_synced_within_1hr', (select count(*) filter (where (updated_at-ts) <= 3600000)::numeric / nullif(count(*),0) from e),
    'pct_events_never_synced', (select count(*) filter (where updated_at = ts)::numeric / nullif(count(*),0) from e),
    'sync_latency_p50_minutes', (select percentile_cont(0.5) within group (order by mins) from lat),
    'sync_latency_p95_minutes', (select percentile_cont(0.95) within group (order by mins) from lat),
    'price_fetch_failure_rate', (select count(*) filter (where price_fetch_failed is true)::numeric / nullif(count(*),0) from e),
    'duplicate_event_rate_intraday', coalesce((select sum(cc) from dup_groups), 0)::numeric / nullif((select count(*) from i), 0),
    'orphan_proxy', (select c from orphan)
  );
$$;

create or replace function public.admin_platform_metrics()
returns jsonb language sql stable security definer set search_path to 'public'
as $$
  with e as (select * from public.events where not deleted and public.is_admin()),
  i as (select * from public.intraday where not deleted and public.is_admin()),
  lat as (select (updated_at - ts)/60000.0 mins from e where updated_at is not null and ts is not null and updated_at >= ts),
  custom as (
    select source, count(*) c from e
    where source is not null
      and lower(source) <> all (array['yahoo finance','google finance','marketwatch','cnbc','bloomberg',
        'stockanalysis','marketbeat','finviz','perplexity finance','tradingview','seeking alpha','nasdaq',
        'stocktwits','wsj'])
    group by source
  ),
  multidev as (
    select count(distinct user_id) c from (
      select user_id, date_trunc('day', to_timestamp(ts/1000)) d, count(distinct source) sc
      from e group by 1, 2 having count(distinct source) >= 2
    ) x
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
    )::double precision from e),
    'price_fetch_failure_rate', (select count(*) filter (where price_fetch_failed is true)::double precision / nullif(count(*),0) from e),
    'pct_events_with_session_id', (select count(session_id)::double precision / nullif(count(*),0) from i),
    'multi_device_users', (select c from multidev),
    'avg_dashboard_minutes', (select avg(dashboard_ms)/60000.0 from public.user_meta where public.is_admin() and dashboard_ms is not null),
    'total_dashboard_minutes', (select coalesce(sum(dashboard_ms),0)/60000.0 from public.user_meta where public.is_admin())
  );
$$;