-- World view: per-country community aggregates.
--
-- user_meta.country is a coarse ISO 3166-1 alpha-2 location detected client-side
-- from the browser locale / IANA timezone (no IP geolocation), written by the
-- best-effort user_meta update in cloud.js trySync.
--
-- The three world_* RPCs feed the dashboard World tab (choropleth map). They
-- aggregate the intraday table (one row per view, so count(*) = views and short
-- "live" windows are accurate; the daily-deduped events table refreshes ts on
-- revisit, which would leak pre-window views into a live window). All take
-- p_from_ms (epoch ms window start). While the World tab is admin-only they are
-- gated by public.is_admin(), same pattern as the admin_* RPCs; opening the tab
-- to everyone later just means relaxing this guard to auth.uid() is not null.

alter table public.user_meta add column if not exists country text;

-- Mode 1: live aggregate attention per country (views + active minutes + users).
create or replace function public.world_country_attention(p_from_ms bigint)
returns table(country text, users bigint, views bigint, dwell_ms bigint)
language sql stable security definer set search_path to 'public'
as $$
  select um.country, count(distinct i.user_id) users,
         count(*) views,
         coalesce(sum(coalesce(i.dwell_ms, 0)), 0)::bigint dwell_ms
  from public.intraday i
  join public.user_meta um on um.user_id = i.user_id
  where public.is_admin() and not i.deleted and i.ts >= p_from_ms
    and um.country is not null
  group by um.country
  order by views desc;
$$;
grant execute on function public.world_country_attention(bigint) to authenticated;

-- Mode 2: currently most researched stock per country.
create or replace function public.world_country_top_stock(p_from_ms bigint)
returns table(country text, ticker text, views bigint, users bigint)
language sql stable security definer set search_path to 'public'
as $$
  with per as (
    select um.country, i.ticker, count(*) views, count(distinct i.user_id) users
    from public.intraday i
    join public.user_meta um on um.user_id = i.user_id
    where public.is_admin() and not i.deleted and i.ts >= p_from_ms
      and um.country is not null
    group by um.country, i.ticker
  )
  select distinct on (country) country, ticker, views, users
  from per
  order by country, views desc, ticker;
$$;
grant execute on function public.world_country_top_stock(bigint) to authenticated;

-- Mode 3: average research time per user in each country (minutes).
create or replace function public.world_country_research_time(p_from_ms bigint)
returns table(country text, users bigint, avg_min_per_user numeric)
language sql stable security definer set search_path to 'public'
as $$
  select um.country, count(distinct i.user_id) users,
    round(coalesce(sum(coalesce(i.dwell_ms, 0)), 0)::numeric / 60000
          / nullif(count(distinct i.user_id), 0), 1) avg_min_per_user
  from public.intraday i
  join public.user_meta um on um.user_id = i.user_id
  where public.is_admin() and not i.deleted and i.ts >= p_from_ms
    and um.country is not null
  group by um.country;
$$;
grant execute on function public.world_country_research_time(bigint) to authenticated;
