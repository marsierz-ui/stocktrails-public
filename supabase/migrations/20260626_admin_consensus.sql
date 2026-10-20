-- GROUP C: cross-user consensus & contrarian signals, by (ticker, week).

create or replace function public.admin_consensus_signals()
returns table(ticker text, week date, unique_users bigint, total_views bigint, total_dwell_ms bigint,
  sentiment_bull_pct double precision, sentiment_divergence double precision,
  is_crowded_bull boolean, is_crowded_bear boolean, is_divergent boolean, return_proxy_30d double precision)
language sql stable security definer set search_path to 'public'
as $$
  with e as (
    select ev.*, date_trunc('week', to_timestamp(ev.ts/1000))::date as wk
    from public.events ev where not ev.deleted and public.is_admin()
  ),
  scored as (
    select e.*,
      case when e.price_at_event is not null and e.price_at_event <> 0 and fut.fp is not null
        then (fut.fp - e.price_at_event) / e.price_at_event end as ret
    from e
    left join lateral (
      select f.price_at_event fp from public.events f
      where f.ticker = e.ticker and not f.deleted and f.price_at_event is not null
        and f.ts >= e.ts + 30::bigint * 86400000
      order by f.ts desc limit 1
    ) fut on true
  ),
  agg as (
    select ticker, wk,
      count(distinct user_id) uu, coalesce(sum(views), 0) tv, coalesce(sum(dwell_ms), 0) td,
      count(*) filter (where sentiment='positive') pos,
      count(*) filter (where sentiment in ('positive','negative')) pn,
      avg(ret) filter (where ret is not null) avgret
    from scored group by ticker, wk
  )
  select ticker, wk, uu, tv, td,
    case when pn > 0 then pos::double precision / pn end,
    case when pn > 0 then abs(0.5 - pos::double precision / pn) * 2 end,
    (pn > 0 and pos::double precision / pn >= 0.75 and uu >= 3),
    (pn > 0 and pos::double precision / pn <= 0.25 and uu >= 3),
    (pn > 0 and abs(0.5 - pos::double precision / pn) * 2 <= 0.2 and uu >= 3),
    avgret::double precision
  from agg
  order by uu desc, td desc;
$$;
