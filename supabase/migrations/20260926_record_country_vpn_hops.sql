-- VPN from switching behaviour, on top of the per-lookup checks in the geo
-- function (datacenter/VPN networks) and cloud.js resolveCountry (IP country vs
-- device clock country, impossible travel between two IP fixes).
--
-- A real trip leaves a country for days; a VPN session flips there and back.
-- record_country() now relabels a finished interval as 'XV' (the World view's
-- VPN category) when:
--   1. Flip-flop: A -> B -> A with B shorter than 72h.
--   2. Hopping: 3+ country changes within 7 days. Then every finished interval
--      in that week shorter than 72h outside the user's home country (most time
--      over the last 30 days) is a VPN hop.
-- Runs server-side, so it also covers clients that predate the other checks.
-- Past data is not rewritten here; a known case is relabelled by hand.
create or replace function public.record_country(p_country text)
returns void language plpgsql security definer set search_path to 'public'
as $$
declare
  cur public.user_country%rowtype;
  now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  uid uuid := auth.uid();
  short_ms constant bigint := 72::bigint * 3600000;
  week_ms constant bigint := 7::bigint * 86400000;
  month_ms constant bigint := 30::bigint * 86400000;
  prev_cc text;
  changes int;
  home text;
begin
  if uid is null or p_country !~ '^[A-Z]{2}$' then return; end if;
  select * into cur from public.user_country
    where user_id = uid and to_ms is null order by from_ms desc limit 1;
  if not found then
    -- First ever record for this user: cover their existing history rather than
    -- orphaning it.
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

  -- 1. Flip-flop: back to where the user was before a short stay.
  select country into prev_cc from public.user_country
    where user_id = uid and to_ms = cur.from_ms;
  if prev_cc = p_country and now_ms - cur.from_ms < short_ms and cur.country <> 'XV' then
    update public.user_country set country = 'XV' where user_id = uid and from_ms = cur.from_ms;
  end if;

  -- 2. Hopping between several countries within a week.
  select count(*) into changes from public.user_country
    where user_id = uid and from_ms >= now_ms - week_ms;
  if changes >= 3 then
    select country into home from (
      select country,
             sum(least(coalesce(to_ms, now_ms), now_ms) - greatest(from_ms, now_ms - month_ms)) t
      from public.user_country
      where user_id = uid and coalesce(to_ms, now_ms) > now_ms - month_ms and country <> 'XV'
      group by 1 order by 2 desc limit 1
    ) h;
    update public.user_country set country = 'XV'
      where user_id = uid and to_ms is not null and to_ms >= now_ms - week_ms
        and to_ms - from_ms < short_ms and country <> 'XV'
        and country is distinct from home;
  end if;
end;
$$;
grant execute on function public.record_country(text) to authenticated;
