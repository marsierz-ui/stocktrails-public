-- World "Country vs the crowd" map mode.
--
-- world_country_crowd_similarity: per country, the cosine similarity between
-- that country's ticker view-distribution and the GLOBAL (all-countries)
-- ticker view-distribution over the last p_days. 1.0 = the country researches
-- exactly the mainstream mix; low = it researches a distinctive set. The global
-- vector includes every country's contribution, so a country that dominates the
-- data (or a single-country dataset) sits near 1. Admin-gated like the other
-- world_* map RPCs.
create or replace function public.world_country_crowd_similarity(p_days int)
returns table(country text, users bigint, views bigint, similarity numeric)
language sql stable security definer set search_path to 'public'
as $$
  with frm as (select (extract(epoch from now()) * 1000)::bigint - p_days::bigint * 86400000 f),
  cv as ( -- per (country, ticker) view counts
    select um.country cc, i.ticker, count(*) n
    from public.intraday i
    join public.user_meta um on um.user_id = i.user_id
    where public.is_admin() and not i.deleted and i.ts >= (select f from frm)
      and um.country is not null
    group by 1, 2
  ),
  gv as (select ticker, sum(n) n from cv group by ticker),          -- global per ticker
  cmeta as ( -- per-country totals for the table/tooltip
    select um.country cc, count(distinct i.user_id) users, count(*) views
    from public.intraday i
    join public.user_meta um on um.user_id = i.user_id
    where public.is_admin() and not i.deleted and i.ts >= (select f from frm)
      and um.country is not null
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
grant execute on function public.world_country_crowd_similarity(int) to authenticated;
