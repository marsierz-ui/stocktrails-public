-- Point-in-time input for the community index.
--
-- network_community_index() returns each ticker's ALL-TIME view count, capped
-- at the top 20 by that count. Building a historical index from it is
-- look-ahead twice over: a stock that only became popular in September sat in
-- the July basket, and every past day was weighted by views that had not
-- happened yet. This returns the views per ticker PER DAY instead, so the client
-- can rank and weight each day on the views known by that day's close.
--
-- The day is the US Eastern TRADING day an event can first be acted on: a view
-- or label at or after 16:00 ET belongs to the next day, since that day's close
-- has already printed. One row per ticker (days as a jsonb array) keeps the
-- response under PostgREST's 1000-row cap however long the history gets.
-- Only tickers with a priced view are returned: nothing else can enter the index.

create or replace function public.network_community_daily()
returns table(ticker text, entry_ts bigint, entry_price double precision, days jsonb)
language sql stable security definer set search_path to 'public'
as $$
  with ev as (
    select e.ticker, coalesce(e.views, 1) v, e.sentiment,
           (to_timestamp(e.ts / 1000.0) at time zone 'America/New_York') et
    from public.events e
    where public.is_admin() and not e.deleted
  ),
  d as (
    select ticker,
           (et::date + case when et::time >= time '16:00' then 1 else 0 end) as day,
           sum(v)::bigint views,
           count(*) filter (where sentiment = 'positive') pos,
           count(*) filter (where sentiment = 'negative') neg,
           count(*) filter (where sentiment is not null) lab
    from ev
    group by 1, 2
  ),
  entry as (
    select distinct on (e.ticker) e.ticker, e.ts, e.price_at_event
    from public.events e
    where public.is_admin() and not e.deleted and e.price_at_event is not null
    order by e.ticker, e.ts asc
  )
  select d.ticker, en.ts, en.price_at_event,
         jsonb_agg(jsonb_build_array(d.day, d.views, d.pos, d.neg, d.lab) order by d.day)
  from d join entry en on en.ticker = d.ticker
  group by d.ticker, en.ts, en.price_at_event;
$$;
revoke execute on function public.network_community_daily() from public, anon;
grant execute on function public.network_community_daily() to authenticated;
