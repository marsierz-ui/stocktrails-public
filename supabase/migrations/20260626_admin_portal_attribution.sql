-- GROUP A: portal source attribution.

create or replace function public.admin_portal_attribution()
returns table(source text, attention_density double precision, sentiment_bull_pct double precision,
  sentiment_distribution jsonb, unique_users bigint, total_events bigint, total_dwell_ms bigint)
language sql stable security definer set search_path to 'public'
as $$
  select
    coalesce(source, '(unknown)') as source,
    (coalesce(sum(dwell_ms), 0))::double precision / nullif(count(distinct ticker), 0) as attention_density,
    (count(*) filter (where sentiment='positive'))::double precision
      / nullif(count(*) filter (where sentiment in ('positive','negative')), 0) as sentiment_bull_pct,
    jsonb_build_object(
      'positive', count(*) filter (where sentiment='positive'),
      'neutral',  count(*) filter (where sentiment='neutral'),
      'negative', count(*) filter (where sentiment='negative')) as sentiment_distribution,
    count(distinct user_id) as unique_users,
    count(*) as total_events,
    coalesce(sum(dwell_ms), 0) as total_dwell_ms
  from public.events where not deleted and public.is_admin()
  group by coalesce(source, '(unknown)')
  order by count(*) desc;
$$;

create or replace function public.admin_first_touch_attribution()
returns table(source text, first_touch_count bigint, pct_of_all_discoveries double precision, avg_subsequent_views double precision)
language sql stable security definer set search_path to 'public'
as $$
  with ft as (
    select distinct on (user_id, ticker) user_id, ticker, source, ts
    from public.events where not deleted and public.is_admin()
    order by user_id, ticker, ts asc
  ),
  v as (
    select user_id, ticker, coalesce(sum(views), 0) as vv
    from public.events where not deleted and public.is_admin()
    group by user_id, ticker
  ),
  tot as (select count(*) n from ft)
  select coalesce(ft.source, '(unknown)'),
    count(*),
    count(*)::double precision / nullif((select n from tot), 0),
    avg(v.vv)::double precision
  from ft left join v on v.user_id = ft.user_id and v.ticker = ft.ticker
  group by coalesce(ft.source, '(unknown)')
  order by count(*) desc;
$$;
