-- Crowd overlap metric + rationale in data-health field fill rates.
--
-- world_crowd_overlap: per UTC day, cosine similarity between the CALLING
-- user's ticker view-vector and the whole community's ticker view-vector (from
-- intraday, one row per view). 1.0 = you look at exactly what the crowd
-- concentrates on; ~0 = idiosyncratic. This is the user's OWN scalar (no
-- individual data leaks - only aggregate community counts feed the denominator),
-- so unlike the other world_* RPCs it is NOT admin-gated: it powers a per-user
-- panel in the (all-users) Attention section as well as the World tab.
create or replace function public.world_crowd_overlap(p_days int)
returns table(day date, overlap numeric, my_views bigint, community_views bigint)
language sql stable security definer set search_path to 'public'
as $$
  with frm as (select (extract(epoch from now()) * 1000)::bigint - p_days::bigint * 86400000 f),
  mine as (
    select (to_timestamp(ts / 1000.0) at time zone 'UTC')::date d, ticker, count(*) n
    from public.intraday
    where not deleted and user_id = auth.uid() and ts >= (select f from frm)
    group by 1, 2
  ),
  comm as (
    select (to_timestamp(ts / 1000.0) at time zone 'UTC')::date d, ticker, count(*) n
    from public.intraday
    where not deleted and ts >= (select f from frm)
    group by 1, 2
  ),
  dp as (
    select m.d, sum(m.n::numeric * c.n) dot
    from mine m join comm c on c.d = m.d and c.ticker = m.ticker
    group by m.d
  ),
  nm as (select d, sqrt(sum((n::numeric) ^ 2)) mag, sum(n)::bigint v from mine group by d),
  nc as (select d, sqrt(sum((n::numeric) ^ 2)) mag, sum(n)::bigint v from comm group by d)
  select nm.d as day,
    round(coalesce(dp.dot, 0) / nullif(nm.mag * nc.mag, 0), 4) overlap,
    nm.v my_views, nc.v community_views
  from nm
  join nc on nc.d = nm.d
  left join dp on dp.d = nm.d
  order by nm.d;
$$;
grant execute on function public.world_crowd_overlap(int) to authenticated;

-- Data health: add `rationale` to the per-week field fill-rate breakdown so the
-- admin data-health table shows how often users attach a written rationale.
create or replace function public.admin_field_fill_rates()
returns table(week date, field_name text, total_events bigint, filled_events bigint, fill_rate numeric)
language sql stable security definer set search_path to 'public'
as $$
  with nw as (select (extract(epoch from now())*1000)::bigint ms),
  e as (select *, date_trunc('week', to_timestamp(ts/1000))::date wk from public.events
        where not deleted and public.is_admin() and ts >= (select ms from nw) - 84::bigint*86400000),
  base as (
    select wk, count(*) total,
      count(scroll_depth) f_scroll, count(focus_switches) f_focus, count(sector) f_sector,
      count(week52_position) f_w52, count(sentiment) f_sent, count(position_taken) f_pos,
      count(target_price) f_tgt, count(market_cap_bucket) f_cap, count(rationale) f_rat
    from e group by wk
  ),
  ei as (
    select date_trunc('week', to_timestamp(ts/1000))::date wk, count(*) total, count(portal_path) f_pp
    from public.intraday where not deleted and public.is_admin() and ts >= (select ms from nw) - 84::bigint*86400000
    group by 1
  )
  select wk, 'scroll_depth', total, f_scroll, f_scroll::numeric/nullif(total,0) from base
  union all select wk, 'focus_switches', total, f_focus, f_focus::numeric/nullif(total,0) from base
  union all select wk, 'sector', total, f_sector, f_sector::numeric/nullif(total,0) from base
  union all select wk, 'week52_position', total, f_w52, f_w52::numeric/nullif(total,0) from base
  union all select wk, 'sentiment', total, f_sent, f_sent::numeric/nullif(total,0) from base
  union all select wk, 'position_taken', total, f_pos, f_pos::numeric/nullif(total,0) from base
  union all select wk, 'target_price', total, f_tgt, f_tgt::numeric/nullif(total,0) from base
  union all select wk, 'market_cap_bucket', total, f_cap, f_cap::numeric/nullif(total,0) from base
  union all select wk, 'rationale', total, f_rat, f_rat::numeric/nullif(total,0) from base
  union all select wk, 'portal_path', total, f_pp, f_pp::numeric/nullif(total,0) from ei
  order by 1 desc, 5 asc nulls first;
$$;
grant execute on function public.admin_field_fill_rates() to authenticated;
