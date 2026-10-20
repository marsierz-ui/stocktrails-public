-- Make the weekday hit-rate return-proxy horizon adjustable (default 30 days).

drop function if exists public.admin_weekday_calibration();
create function public.admin_weekday_calibration(p_horizon_days int default 30)
returns table(dow integer, event_count bigint, avg_dwell_ms double precision, sentiment_bull_pct double precision,
  hit_rate_30d double precision, avg_week52_position double precision)
language sql stable security definer set search_path to 'public'
as $$
  with e as (select ev.* from public.events ev where not ev.deleted and public.is_admin()),
  scored as (
    select e.*, extract(dow from to_timestamp(e.ts/1000))::int as d,
      case when e.price_at_event is not null and e.price_at_event <> 0 and fut.fp is not null
        then (fut.fp - e.price_at_event) / e.price_at_event end as ret
    from e
    left join lateral (
      select f.price_at_event fp from public.events f
      where f.ticker = e.ticker and not f.deleted and f.price_at_event is not null
        and f.ts >= e.ts + (greatest(1, coalesce(p_horizon_days, 30)))::bigint * 86400000
      order by f.ts desc limit 1
    ) fut on true
  )
  select d, count(*), avg(dwell_ms)::double precision,
    (count(*) filter (where sentiment='positive'))::double precision
      / nullif(count(*) filter (where sentiment in ('positive','negative')), 0),
    (count(*) filter (where (sentiment='positive' and ret > 0) or (sentiment='negative' and ret < 0)))::double precision
      / nullif(count(*) filter (where sentiment in ('positive','negative') and ret is not null), 0),
    avg(week52_position)::double precision
  from scored group by d order by d;
$$;
