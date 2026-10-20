-- GROUP D: per-event lead-lag export for offline panel regression (capped 50k).
-- Return proxies use the nearest subsequent same-ticker event at/after the
-- horizon (earliest after threshold).

create or replace function public.admin_lead_lag_export()
returns table(user_id uuid, ticker text, ts bigint, source text, market_session text, sentiment text,
  views integer, dwell_ms bigint, scroll_depth real, focus_switches smallint, week52_position real,
  market_cap_bucket text, sector text, price_at_event double precision,
  return_1d_proxy double precision, return_7d_proxy double precision, return_30d_proxy double precision)
language sql stable security definer set search_path to 'public'
as $$
  select e.user_id, e.ticker, e.ts, e.source,
    coalesce(e.market_session, public.market_session(e.ts)),
    e.sentiment, e.views, e.dwell_ms, e.scroll_depth, e.focus_switches, e.week52_position,
    e.market_cap_bucket, e.sector, e.price_at_event,
    r1.r, r7.r, r30.r
  from public.events e
  left join lateral (
    select (f.price_at_event - e.price_at_event) / nullif(e.price_at_event, 0) r
    from public.events f
    where f.ticker = e.ticker and not f.deleted and f.price_at_event is not null
      and f.ts >= e.ts + 1::bigint * 86400000
    order by f.ts asc limit 1
  ) r1 on true
  left join lateral (
    select (f.price_at_event - e.price_at_event) / nullif(e.price_at_event, 0) r
    from public.events f
    where f.ticker = e.ticker and not f.deleted and f.price_at_event is not null
      and f.ts >= e.ts + 7::bigint * 86400000
    order by f.ts asc limit 1
  ) r7 on true
  left join lateral (
    select (f.price_at_event - e.price_at_event) / nullif(e.price_at_event, 0) r
    from public.events f
    where f.ticker = e.ticker and not f.deleted and f.price_at_event is not null
      and f.ts >= e.ts + 30::bigint * 86400000
    order by f.ts asc limit 1
  ) r30 on true
  where not e.deleted and public.is_admin()
  order by e.ts asc
  limit 50000;
$$;
