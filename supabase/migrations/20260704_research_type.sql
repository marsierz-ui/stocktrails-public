-- Research-path tracking: content.js classifies each portal page into a coarse
-- research type (overview / news / financials / analysis / charts / community /
-- screener / options / ownership / profile / ai) from its URL at capture time;
-- the value flows through events + intraday. admin_research_effectiveness
-- correlates research paths (portal x research type) with the 30-day forward
-- return proxy (same proxy as admin_return_by_segment: most recent same-ticker
-- event price >= 30d later), so the admin can see which research paths precede
-- the best subsequent returns.

alter table public.events add column if not exists research_type text;
alter table public.intraday add column if not exists research_type text;

create or replace function public.admin_research_effectiveness()
returns table(source text, research_type text, users bigint, event_count bigint,
  events_per_user numeric, dwell_min_per_user numeric, label_rate numeric,
  hit_rate double precision, avg_30d_return double precision)
language sql stable security definer set search_path to 'public'
as $$
  with scored as (
    select e.*,
      case when e.price_at_event is not null and e.price_at_event <> 0 and fut.fp is not null
        then (fut.fp - e.price_at_event) / e.price_at_event end ret
    from (select * from public.events where not deleted and public.is_admin()) e
    left join lateral (select f.price_at_event fp from public.events f
      where f.ticker = e.ticker and not f.deleted and f.price_at_event is not null
        and f.ts >= e.ts + 30::bigint*86400000 order by f.ts desc limit 1) fut on true
  )
  select coalesce(source, 'unknown'), coalesce(research_type, 'unclassified'),
    count(distinct user_id),
    count(*),
    round(count(*)::numeric / nullif(count(distinct user_id), 0), 1),
    round(coalesce(sum(dwell_ms), 0)::numeric / 60000 / nullif(count(distinct user_id), 0), 1),
    round((count(*) filter (where sentiment is not null))::numeric / nullif(count(*), 0), 4),
    (count(*) filter (where (sentiment = 'positive' and ret > 0) or (sentiment = 'negative' and ret < 0)))::double precision
      / nullif(count(*) filter (where sentiment in ('positive','negative') and ret is not null), 0),
    avg(ret)::double precision
  from scored
  group by 1, 2
  order by 9 desc nulls last;
$$;
grant execute on function public.admin_research_effectiveness() to authenticated;
