-- PREREQ D: bring the pre-existing admin RPCs up to date with the analytics-v2
-- columns. Return types change (new OUT columns), so each is dropped first.
-- Sentiment literals are lowercase to match the values the client actually stores
-- ('positive' / 'negative' / 'neutral').

drop function if exists public.admin_top_tickers();
create function public.admin_top_tickers()
returns table(ticker text, views bigint, users bigint, dwell bigint,
  avg_scroll_depth double precision, avg_focus_switches double precision,
  dominant_sector text, pct_position_taken double precision)
language sql stable security definer set search_path to 'public'
as $$
  select ticker, count(*), count(distinct user_id), coalesce(sum(dwell_ms), 0),
    avg(scroll_depth)::double precision,
    avg(focus_switches)::double precision,
    mode() within group (order by sector) filter (where sector is not null),
    (count(*) filter (where position_taken is true))::double precision / nullif(count(*), 0)
  from public.events where not deleted and public.is_admin()
  group by ticker order by 2 desc limit 50;
$$;

drop function if exists public.admin_extras();
create function public.admin_extras()
returns table(discovery bigint, revisit bigint, hhi double precision, busiest_day text, busiest_n bigint,
  dwell_total bigint, dwell_hhi double precision, dwell_busiest_day text, dwell_busiest bigint,
  pct_pre_market double precision, avg_week52_position double precision)
language sql stable security definer set search_path to 'public'
as $$
  with e as (select * from public.events where not deleted and public.is_admin()),
  byt as (select ticker, count(*) c, coalesce(sum(dwell_ms),0) dw from e group by ticker),
  tot as (select sum(c) sc, nullif(sum(dw),0) sd from byt),
  byd as (select to_char(to_timestamp(ts/1000),'YYYY-MM-DD') dstr, count(*) c, coalesce(sum(dwell_ms),0) dw from e group by 1),
  bd_v as (select dstr, c from byd order by c desc limit 1),
  bd_t as (select dstr, dw from byd order by dw desc limit 1)
  select
    (select count(distinct (user_id::text || ':' || ticker)) from e),
    (select count(*) from e) - (select count(distinct (user_id::text || ':' || ticker)) from e),
    coalesce((select sum((c::numeric / (select sc from tot)) ^ 2) from byt), 0)::double precision,
    (select dstr from bd_v), (select c from bd_v),
    (select coalesce(sum(dw),0) from byt),
    coalesce((select sum((dw::numeric / nullif((select sd from tot),0)) ^ 2) from byt), 0)::double precision,
    (select dstr from bd_t), (select dw from bd_t),
    (select (count(*) filter (where public.market_session(ts) <> 'market_hours'))::double precision / nullif(count(*),0) from e),
    (select avg(week52_position)::double precision from e);
$$;

drop function if exists public.admin_by_hour();
create function public.admin_by_hour()
returns table(hour integer, n bigint, dwell bigint,
  avg_scroll_depth double precision, avg_dwell_ms double precision, sentiment_bull_pct double precision)
language sql stable security definer set search_path to 'public'
as $$
  select extract(hour from to_timestamp(ts/1000))::int, count(*), coalesce(sum(dwell_ms), 0),
    avg(scroll_depth)::double precision,
    avg(dwell_ms)::double precision,
    (count(*) filter (where sentiment='positive'))::double precision
      / nullif(count(*) filter (where sentiment in ('positive','negative')), 0)
  from public.events where not deleted and ts is not null and public.is_admin()
  group by 1 order by 1;
$$;

drop function if exists public.admin_by_weekday();
create function public.admin_by_weekday()
returns table(dow integer, n bigint, dwell bigint,
  avg_scroll_depth double precision, avg_dwell_ms double precision, sentiment_bull_pct double precision)
language sql stable security definer set search_path to 'public'
as $$
  select extract(dow from to_timestamp(ts/1000))::int, count(*), coalesce(sum(dwell_ms), 0),
    avg(scroll_depth)::double precision,
    avg(dwell_ms)::double precision,
    (count(*) filter (where sentiment='positive'))::double precision
      / nullif(count(*) filter (where sentiment in ('positive','negative')), 0)
  from public.events where not deleted and ts is not null and public.is_admin()
  group by 1 order by 1;
$$;
