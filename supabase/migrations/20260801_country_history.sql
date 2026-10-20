-- Country history: attribute each event to where the user was AT THE TIME.
--
-- Before this, user_meta.country held one current country and every world_* RPC
-- joined it to the whole history. Moving country rewrote the past: a user who
-- researched from DE and then moved to IE showed as if all their research had
-- always been Irish.
--
-- public.user_country stores half-open intervals [from_ms, to_ms) per user, with
-- to_ms null for the current one. record_country() (called from cloud.js trySync
-- with the geo-resolved ISO2) closes the open interval and opens a new one only
-- when the country actually changes, so the switch is pinpointed in time. The
-- world_* RPCs below join by ts range instead of by user, so historical rows keep
-- the country they were recorded in.
--
-- user_meta.country stays as the "current country" denormalisation (admin views
-- and the LWW meta update use it); it is no longer the source of truth for the
-- world aggregates.

create table if not exists public.user_country (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  from_ms bigint not null,
  to_ms bigint,
  country text not null,
  primary key (user_id, from_ms)
);
create index if not exists user_country_lookup on public.user_country(user_id, from_ms);
-- At most one open interval per user: two devices syncing at once cannot leave
-- overlapping intervals (which would double-count that user's views).
create unique index if not exists user_country_one_open on public.user_country(user_id) where to_ms is null;
alter table public.user_country enable row level security;
drop policy if exists user_country_own on public.user_country;
create policy user_country_own on public.user_country for all using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists user_country_admin_sel on public.user_country;
create policy user_country_admin_sel on public.user_country for select using (public.is_admin());

-- Seed: the current country covers all history (from_ms = 0). This reproduces
-- the old behaviour for data recorded before the history existed - there is no
-- stored signal (no per-event timezone or IP) to reconstruct earlier moves from.
-- A known past move is corrected by splitting the seeded interval, e.g. a user
-- who was in DE until 2026-06-01 and IE since:
--   update public.user_country set to_ms = 1780272000000
--     where user_id = '<uuid>' and from_ms = 0;
--   insert into public.user_country(user_id, from_ms, to_ms, country)
--     values ('<uuid>', 1780272000000, null, 'IE');
--   update public.user_country set country = 'DE' where user_id = '<uuid>' and from_ms = 0;
insert into public.user_country (user_id, from_ms, to_ms, country)
select user_id, 0, null, country from public.user_meta where country is not null
on conflict (user_id, from_ms) do nothing;

-- Record the caller's current country. No-op when unchanged, so the open
-- interval's from_ms keeps marking when the user actually arrived.
create or replace function public.record_country(p_country text)
returns void language plpgsql security definer set search_path to 'public'
as $$
declare
  cur public.user_country%rowtype;
  now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  uid uuid := auth.uid();
begin
  if uid is null or p_country !~ '^[A-Z]{2}$' then return; end if;
  select * into cur from public.user_country
    where user_id = uid and to_ms is null order by from_ms desc limit 1;
  if not found then
    -- First ever record for this user: cover their existing history rather than
    -- orphaning it (same reasoning as the seed above).
    insert into public.user_country (user_id, from_ms, to_ms, country)
    values (uid, 0, null, p_country)
    on conflict (user_id, from_ms) do nothing;
    return;
  end if;
  if cur.country = p_country then return; end if;
  update public.user_country set to_ms = now_ms where user_id = uid and to_ms is null;
  insert into public.user_country (user_id, from_ms, to_ms, country)
  values (uid, now_ms, null, p_country)
  on conflict (user_id, from_ms) do update set to_ms = null, country = excluded.country;
end;
$$;
grant execute on function public.record_country(text) to authenticated;

-- ---------- world_* RPCs, re-pointed at the interval join ----------
-- Only the join changes (user_meta.country -> user_country by ts range); the
-- aggregate logic is unchanged from 20260704/20260705/20260707.

create or replace function public.world_country_attention(p_from_ms bigint)
returns table(country text, users bigint, views bigint, dwell_ms bigint)
language sql stable security definer set search_path to 'public'
as $$
  select uc.country, count(distinct i.user_id) users,
         count(*) views,
         coalesce(sum(coalesce(i.dwell_ms, 0)), 0)::bigint dwell_ms
  from public.intraday i
  join public.user_country uc on uc.user_id = i.user_id
    and i.ts >= uc.from_ms and (uc.to_ms is null or i.ts < uc.to_ms)
  where public.is_admin() and not i.deleted and i.ts >= p_from_ms
  group by uc.country
  order by views desc;
$$;

create or replace function public.world_country_top_stock(p_from_ms bigint)
returns table(country text, ticker text, views bigint, users bigint)
language sql stable security definer set search_path to 'public'
as $$
  with per as (
    select uc.country, i.ticker, count(*) views, count(distinct i.user_id) users
    from public.intraday i
    join public.user_country uc on uc.user_id = i.user_id
      and i.ts >= uc.from_ms and (uc.to_ms is null or i.ts < uc.to_ms)
    where public.is_admin() and not i.deleted and i.ts >= p_from_ms
    group by uc.country, i.ticker
  )
  select distinct on (country) country, ticker, views, users
  from per
  order by country, views desc, ticker;
$$;

create or replace function public.world_country_research_time(p_from_ms bigint)
returns table(country text, users bigint, avg_min_per_user numeric)
language sql stable security definer set search_path to 'public'
as $$
  select uc.country, count(distinct i.user_id) users,
    round(coalesce(sum(coalesce(i.dwell_ms, 0)), 0)::numeric / 60000
          / nullif(count(distinct i.user_id), 0), 1) avg_min_per_user
  from public.intraday i
  join public.user_country uc on uc.user_id = i.user_id
    and i.ts >= uc.from_ms and (uc.to_ms is null or i.ts < uc.to_ms)
  where public.is_admin() and not i.deleted and i.ts >= p_from_ms
  group by uc.country;
$$;

create or replace function public.world_country_daily(p_days int)
returns table(day date, country text, users bigint, views bigint, dwell_ms bigint,
              labelled bigint, hits bigint, ret_sum numeric, ret_n bigint)
language sql stable security definer set search_path to 'public'
as $$
  with nw as (select (extract(epoch from now()) * 1000)::bigint ms),
  frm as (select (select ms from nw) - p_days::bigint * 86400000 f),
  att as (
    select (to_timestamp(i.ts / 1000.0) at time zone 'UTC')::date d, uc.country cc,
           count(distinct i.user_id) users, count(*) views,
           coalesce(sum(coalesce(i.dwell_ms, 0)), 0)::bigint dwell_ms
    from public.intraday i
    join public.user_country uc on uc.user_id = i.user_id
      and i.ts >= uc.from_ms and (uc.to_ms is null or i.ts < uc.to_ms)
    where public.is_admin() and not i.deleted and i.ts >= (select f from frm)
    group by 1, 2
  ),
  latest as (
    select distinct on (ticker) ticker, price_at_event p
    from public.events
    where not deleted and price_at_event is not null
    order by ticker, ts desc
  ),
  ev as (
    select (to_timestamp(e.ts / 1000.0) at time zone 'UTC')::date d, uc.country cc,
      count(*) filter (where e.sentiment in ('positive', 'negative')
                         and e.price_at_event is not null and l.p is not null
                         and l.p <> e.price_at_event) labelled,
      count(*) filter (where e.price_at_event is not null and l.p is not null
                         and ((e.sentiment = 'positive' and l.p > e.price_at_event)
                           or (e.sentiment = 'negative' and l.p < e.price_at_event))) hits,
      coalesce(sum((l.p - e.price_at_event) / nullif(e.price_at_event, 0))
                 filter (where e.price_at_event is not null and l.p is not null), 0)::numeric ret_sum,
      count(*) filter (where e.price_at_event is not null and l.p is not null) ret_n
    from public.events e
    join public.user_country uc on uc.user_id = e.user_id
      and e.ts >= uc.from_ms and (uc.to_ms is null or e.ts < uc.to_ms)
    left join latest l on l.ticker = e.ticker
    where public.is_admin() and not e.deleted and e.ts >= (select f from frm)
    group by 1, 2
  )
  select coalesce(a.d, e.d) as day, coalesce(a.cc, e.cc) as country,
    coalesce(a.users, 0) users, coalesce(a.views, 0) views, coalesce(a.dwell_ms, 0) dwell_ms,
    coalesce(e.labelled, 0) labelled, coalesce(e.hits, 0) hits,
    coalesce(e.ret_sum, 0) ret_sum, coalesce(e.ret_n, 0) ret_n
  from att a
  full join ev e on e.d = a.d and e.cc = a.cc
  order by 1, 2;
$$;

create or replace function public.world_country_top_stock_daily(p_days int)
returns table(day date, country text, ticker text, views bigint)
language sql stable security definer set search_path to 'public'
as $$
  with per as (
    select (to_timestamp(i.ts / 1000.0) at time zone 'UTC')::date d, uc.country cc,
           i.ticker, count(*) views
    from public.intraday i
    join public.user_country uc on uc.user_id = i.user_id
      and i.ts >= uc.from_ms and (uc.to_ms is null or i.ts < uc.to_ms)
    where public.is_admin() and not i.deleted
      and i.ts >= (extract(epoch from now()) * 1000)::bigint - p_days::bigint * 86400000
    group by 1, 2, 3
  )
  select distinct on (d, cc) d as day, cc as country, ticker, views
  from per
  order by d, cc, views desc, ticker;
$$;

create or replace function public.world_country_crowd_similarity(p_days int)
returns table(country text, users bigint, views bigint, similarity numeric)
language sql stable security definer set search_path to 'public'
as $$
  with frm as (select (extract(epoch from now()) * 1000)::bigint - p_days::bigint * 86400000 f),
  cv as (
    select uc.country cc, i.ticker, count(*) n
    from public.intraday i
    join public.user_country uc on uc.user_id = i.user_id
      and i.ts >= uc.from_ms and (uc.to_ms is null or i.ts < uc.to_ms)
    where public.is_admin() and not i.deleted and i.ts >= (select f from frm)
    group by 1, 2
  ),
  gv as (select ticker, sum(n) n from cv group by ticker),
  cmeta as (
    select uc.country cc, count(distinct i.user_id) users, count(*) views
    from public.intraday i
    join public.user_country uc on uc.user_id = i.user_id
      and i.ts >= uc.from_ms and (uc.to_ms is null or i.ts < uc.to_ms)
    where public.is_admin() and not i.deleted and i.ts >= (select f from frm)
    group by 1
  ),
  dot as (select cv.cc, sum(cv.n::numeric * gv.n) d from cv join gv on gv.ticker = cv.ticker group by cv.cc),
  magc as (select cc, sqrt(sum((n::numeric) ^ 2)) m from cv group by cc),
  magg as (select sqrt(sum((n::numeric) ^ 2)) m from gv)
  select cm.cc as country, cm.users, cm.views,
    round(coalesce(d.d, 0) / nullif(magc.m * (select m from magg), 0), 4) similarity
  from cmeta cm
  join magc on magc.cc = cm.cc
  left join dot d on d.cc = cm.cc
  order by cm.views desc;
$$;
