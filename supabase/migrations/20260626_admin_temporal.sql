-- GROUP B: temporal pattern mining (session calibration, spikes, weekday).
-- The 30-day return proxy mirrors admin_sentiment_calibration: most recent
-- same-ticker event at least 30 days later.

create or replace function public.admin_market_session_calibration()
returns table(market_session text, event_count bigint, unique_users bigint, unique_tickers bigint,
  avg_dwell_ms double precision, avg_scroll_depth double precision, avg_focus_switches double precision,
  sentiment_bull_pct double precision, hit_rate_30d double precision)
language sql stable security definer set search_path to 'public'
as $$
  with e as (
    select ev.*, public.market_session(ev.ts) as sess
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
  )
  select sess, count(*), count(distinct user_id), count(distinct ticker),
    avg(dwell_ms)::double precision, avg(scroll_depth)::double precision, avg(focus_switches)::double precision,
    (count(*) filter (where sentiment='positive'))::double precision
      / nullif(count(*) filter (where sentiment in ('positive','negative')), 0),
    (count(*) filter (where (sentiment='positive' and ret > 0) or (sentiment='negative' and ret < 0)))::double precision
      / nullif(count(*) filter (where sentiment in ('positive','negative') and ret is not null), 0)
  from scored group by sess order by sess;
$$;

-- Spike = >=3 distinct users on the same ticker within one clock hour.
create or replace function public.admin_attention_spikes()
returns table(ticker text, spike_hour timestamptz, unique_users_in_hour bigint, total_views bigint,
  total_dwell_ms bigint, sentiment_bull_pct double precision, price_at_spike_open double precision, is_earnings_week boolean)
language sql stable security definer set search_path to 'public'
as $$
  with h as (
    select ticker, date_trunc('hour', to_timestamp(ts/1000)) as hr,
      count(distinct user_id) as uu, coalesce(sum(views), 0) as tv, coalesce(sum(dwell_ms), 0) as td,
      count(*) filter (where sentiment='positive') as pos,
      count(*) filter (where sentiment in ('positive','negative')) as pn,
      min(price_at_event) as p0
    from public.events where not deleted and public.is_admin() and ts is not null
    group by ticker, date_trunc('hour', to_timestamp(ts/1000))
  ),
  spikes as (select * from h where uu >= 3)
  select s.ticker, s.hr, s.uu, s.tv, s.td,
    case when s.pn > 0 then s.pos::double precision / s.pn end,
    s.p0::double precision,
    exists (select 1 from spikes s2 where s2.ticker = s.ticker and s2.hr <> s.hr
      and abs(extract(epoch from (s2.hr - s.hr))) <= 3 * 86400)
  from spikes s
  order by s.uu desc, s.tv desc;
$$;

create or replace function public.admin_weekday_calibration()
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
        and f.ts >= e.ts + 30::bigint * 86400000
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
