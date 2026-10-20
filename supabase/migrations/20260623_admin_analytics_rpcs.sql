-- GROUP 3: admin analytics RPCs. All security-definer + gated by public.is_admin().
-- The "30-day return proxy" = price_at_event -> the most recent event for the
-- same ticker at least 30 days later (no separate price-history table exists).

-- 3a. Per (user, ticker) sentiment calibration.
create or replace function public.admin_sentiment_calibration()
returns table(
  user_id uuid, ticker text,
  positive_count bigint, negative_count bigint, neutral_count bigint,
  positive_hit_rate double precision, negative_hit_rate double precision,
  sentiment_flip_rate double precision, aggregate_brier_score double precision
)
language sql stable security definer set search_path = public as $$
  with e as (
    select * from public.events
    where not deleted and public.is_admin() and sentiment is not null
  ),
  scored as (
    select e.user_id, e.ticker, e.sentiment, e.sentiment_prev, e.price_at_event,
      case when e.price_at_event is not null and e.price_at_event <> 0 and fut.fp is not null
           then (fut.fp - e.price_at_event) / e.price_at_event end as ret
    from e
    left join lateral (
      select f.price_at_event as fp
      from public.events f
      where f.ticker = e.ticker and not f.deleted
        and f.price_at_event is not null
        and f.ts >= e.ts + 30::bigint * 86400000
      order by f.ts desc
      limit 1
    ) fut on true
  )
  select user_id, ticker,
    count(*) filter (where sentiment = 'positive'),
    count(*) filter (where sentiment = 'negative'),
    count(*) filter (where sentiment = 'neutral'),
    (count(*) filter (where sentiment = 'positive' and ret > 0))::double precision
      / nullif(count(*) filter (where sentiment = 'positive' and ret is not null), 0),
    (count(*) filter (where sentiment = 'negative' and ret < 0))::double precision
      / nullif(count(*) filter (where sentiment = 'negative' and ret is not null), 0),
    (count(*) filter (where sentiment_prev is not null))::double precision / nullif(count(*), 0),
    avg(power(
      (case sentiment when 'positive' then 0.85 when 'negative' then 0.15 else 0.5 end)
      - (case when ret > 0 then 1 else 0 end), 2)) filter (where ret is not null)
  from scored
  group by user_id, ticker;
$$;
grant execute on function public.admin_sentiment_calibration() to authenticated;

-- 3b. Per (user, ticker, day) portal journey.
create or replace function public.admin_portal_journey()
returns table(
  user_id uuid, ticker text, session_date date,
  portal_sequence text[], path_sequence text[],
  total_dwell_ms bigint, focus_switches_sum bigint, max_scroll_depth double precision
)
language sql stable security definer set search_path = public as $$
  select user_id, ticker,
    (date_trunc('day', to_timestamp(ts / 1000)))::date,
    array_agg(source order by ts),
    array_agg(portal_path order by ts),
    coalesce(sum(dwell_ms), 0),
    coalesce(sum(focus_switches), 0),
    max(scroll_depth)::double precision
  from public.intraday
  where not deleted and public.is_admin()
  group by user_id, ticker, (date_trunc('day', to_timestamp(ts / 1000)))::date;
$$;
grant execute on function public.admin_portal_journey() to authenticated;

-- 3c. Per (ticker, ISO week) attention velocity + crowding flag.
create or replace function public.admin_attention_velocity()
returns table(
  ticker text, week date,
  unique_users bigint, total_views bigint, total_dwell_ms bigint,
  avg_revisit_gap_hours double precision, sentiment_bull_pct double precision, is_crowded boolean
)
language sql stable security definer set search_path = public as $$
  with i as (
    select *, date_trunc('week', to_timestamp(ts / 1000)) as wk
    from public.intraday
    where not deleted and public.is_admin()
  ),
  gaps as (
    select ticker, wk,
      (ts - lag(ts) over (partition by user_id, ticker, wk order by ts)) as gap_ms
    from i
  ),
  gap_agg as (
    select ticker, wk, avg(gap_ms) as avg_gap_ms
    from gaps where gap_ms is not null
    group by ticker, wk
  ),
  agg as (
    select ticker, wk,
      count(distinct user_id) as unique_users,
      count(*) as total_views,
      coalesce(sum(dwell_ms), 0) as total_dwell_ms,
      count(*) filter (where sentiment = 'positive') as pos,
      count(*) filter (where sentiment = 'negative') as neg
    from i group by ticker, wk
  )
  select a.ticker, a.wk::date, a.unique_users, a.total_views, a.total_dwell_ms,
    (g.avg_gap_ms / 3600000.0)::double precision,
    case when (a.pos + a.neg) > 0 then a.pos::double precision / (a.pos + a.neg) end,
    (a.unique_users >= 3
      and case when (a.pos + a.neg) > 0 then a.pos::double precision / (a.pos + a.neg) else 0 end >= 0.75)
  from agg a
  left join gap_agg g on g.ticker = a.ticker and g.wk = a.wk;
$$;
grant execute on function public.admin_attention_velocity() to authenticated;

-- 3d. 52-week-position histogram (edges 0,.2,.4,.6,.8,1.0).
create or replace function public.admin_52w_position_buckets()
returns table(
  bucket_low double precision, bucket_high double precision,
  event_count bigint, avg_30d_return_proxy double precision, sentiment_distribution jsonb
)
language sql stable security definer set search_path = public as $$
  with e as (
    select * from public.events
    where not deleted and public.is_admin() and week52_position is not null
  ),
  scored as (
    select e.sentiment, e.price_at_event,
      least(4, floor(e.week52_position / 0.2))::int as b,
      case when e.price_at_event is not null and e.price_at_event <> 0 and fut.fp is not null
           then (fut.fp - e.price_at_event) / e.price_at_event end as ret
    from e
    left join lateral (
      select f.price_at_event as fp
      from public.events f
      where f.ticker = e.ticker and not f.deleted
        and f.price_at_event is not null
        and f.ts >= e.ts + 30::bigint * 86400000
      order by f.ts desc
      limit 1
    ) fut on true
  ),
  buckets as (
    select b,
      count(*) as cnt,
      avg(ret) as avgret,
      jsonb_build_object(
        'pos', count(*) filter (where sentiment = 'positive'),
        'neu', count(*) filter (where sentiment = 'neutral'),
        'neg', count(*) filter (where sentiment = 'negative')
      ) as dist
    from scored group by b
  )
  select (ed.b * 0.2)::double precision, (ed.b * 0.2 + 0.2)::double precision,
    coalesce(bk.cnt, 0), bk.avgret,
    coalesce(bk.dist, jsonb_build_object('pos', 0, 'neu', 0, 'neg', 0))
  from generate_series(0, 4) as ed(b)
  left join buckets bk on bk.b = ed.b
  order by ed.b;
$$;
grant execute on function public.admin_52w_position_buckets() to authenticated;
