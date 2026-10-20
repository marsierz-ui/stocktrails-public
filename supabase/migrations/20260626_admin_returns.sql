-- GROUP F3: portfolio & return signal quality. Uses the 30-day return proxy
-- (most recent same-ticker event >= horizon later) and event prices as a sparse
-- weekly price series (no real price table exists in Postgres).

create or replace function public.admin_paper_portfolio()
returns jsonb language sql stable security definer set search_path to 'public'
as $$
  with e as (select * from public.events where not deleted and public.is_admin() and price_at_event is not null),
  buys as (select distinct on (user_id, ticker) user_id, ticker, ts, price_at_event bp from e order by user_id, ticker, ts asc),
  weeks as (
    select generate_series(date_trunc('week', (select to_timestamp(min(ts)/1000) from e)),
                           date_trunc('week', now()), interval '1 week')::date wk
  ),
  pos_week as (
    select b.user_id, b.ticker, w.wk, b.bp,
      (select f.price_at_event from e f where f.ticker = b.ticker
         and f.ts <= (extract(epoch from (w.wk + interval '7 days')) * 1000)::bigint
       order by f.ts desc limit 1) cur
    from buys b cross join weeks w
    where w.wk >= date_trunc('week', to_timestamp(b.ts/1000))::date
  ),
  series as (
    select wk, round((100 * avg(cur / nullif(bp,0)))::numeric, 2) val
    from pos_week where cur is not null group by wk order by wk
  ),
  proxy as (
    select b.user_id, b.ticker, b.bp,
      case when fut.fp is not null then (fut.fp - b.bp) / nullif(b.bp,0) end ret
    from buys b
    left join lateral (select f.price_at_event fp from e f
      where f.ticker = b.ticker and f.ts >= b.ts + 30::bigint*86400000
      order by f.ts desc limit 1) fut on true
  )
  select jsonb_build_object(
    'series', coalesce((select jsonb_agg(jsonb_build_object('week', wk, 'portfolio_value', val, 'nasdaq_value', null) order by wk) from series), '[]'::jsonb),
    'total_positions', (select count(*) from buys),
    'avg_30d_return_proxy', (select avg(ret) from proxy where ret is not null),
    'pct_positions_profitable', (select count(*) filter (where ret > 0)::numeric / nullif(count(*) filter (where ret is not null),0) from proxy),
    'best_ticker', (select ticker from proxy where ret is not null order by ret desc limit 1),
    'worst_ticker', (select ticker from proxy where ret is not null order by ret asc limit 1)
  );
$$;

create or replace function public.admin_return_by_segment()
returns table(segment_type text, segment_value text, event_count bigint, avg_30d_return double precision,
  hit_rate double precision, sentiment_bull_pct double precision)
language sql stable security definer set search_path to 'public'
as $$
  with scored as (
    select e.*,
      case when e.price_at_event is not null and e.price_at_event <> 0 and fut.fp is not null
        then (fut.fp - e.price_at_event) / e.price_at_event end ret
    from (select * from public.events where not deleted and public.is_admin()) e
    left join lateral (select f.price_at_event fp from public.events f
      where f.ticker = e.ticker and not f.deleted and f.price_at_event is not null
        and f.ts >= e.ts + 30::bigint*86400000 order by f.ts desc limit 1) fut on true
  )
  select 'cap_bucket', market_cap_bucket, count(*), avg(ret)::double precision,
    (count(*) filter (where (sentiment='positive' and ret>0) or (sentiment='negative' and ret<0)))::double precision
      / nullif(count(*) filter (where sentiment in ('positive','negative') and ret is not null),0),
    (count(*) filter (where sentiment='positive'))::double precision
      / nullif(count(*) filter (where sentiment in ('positive','negative')),0)
  from scored where market_cap_bucket is not null group by market_cap_bucket
  union all
  select 'sector', sector, count(*), avg(ret)::double precision,
    (count(*) filter (where (sentiment='positive' and ret>0) or (sentiment='negative' and ret<0)))::double precision
      / nullif(count(*) filter (where sentiment in ('positive','negative') and ret is not null),0),
    (count(*) filter (where sentiment='positive'))::double precision
      / nullif(count(*) filter (where sentiment in ('positive','negative')),0)
  from scored where sector is not null group by sector
  order by 1, 4 desc nulls last;
$$;

create or replace function public.admin_target_price_accuracy()
returns jsonb language sql stable security definer set search_path to 'public'
as $$
  with e as (select * from public.events where not deleted and public.is_admin()
    and target_price is not null and price_at_event is not null),
  hit as (
    select e.*,
      (select min(f.ts) from public.events f where f.ticker = e.ticker and not f.deleted
         and f.price_at_event is not null and f.ts > e.ts and f.ts <= e.ts + 90::bigint*86400000
         and ((e.sentiment='negative' and f.price_at_event <= e.target_price)
           or (e.sentiment is distinct from 'negative' and f.price_at_event >= e.target_price))) hit_ts
    from e
  )
  select jsonb_build_object(
    'total_with_target', (select count(*) from e),
    'pct_target_hit_90d', (select count(*) filter (where hit_ts is not null)::numeric / nullif(count(*),0) from hit),
    'avg_distance_pct', (select avg(abs(target_price - price_at_event) / nullif(price_at_event,0)) from e),
    'median_days_to_hit', (select percentile_cont(0.5) within group (order by (hit_ts - ts)/86400000.0) from hit where hit_ts is not null)
  );
$$;
