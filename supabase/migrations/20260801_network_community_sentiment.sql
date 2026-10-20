-- Community label timeline per ticker, for the Network tab's holding-rule
-- selector.
--
-- The Network community index needs to know when the community turned on a
-- name, not just how much it looked at it. Individual labels would be a large
-- and needlessly identifying payload, so this collapses each (ticker, UTC day)
-- to one label: the majority of that day's labels, ties going to neutral. The
-- timestamp is the end of that day, so a label only affects the weights the
-- dashboard applies to the NEXT bar (no look-ahead), matching how the
-- Performance index treats a user's own labels.
--
-- Same admin gate as the rest of the Network RPCs.

create or replace function public.network_community_sentiment()
returns table(ticker text, ts bigint, sentiment text)
language sql stable security definer set search_path to 'public'
as $$
  with d as (
    select e.ticker,
           -- "as" is required: a bare `day` label parses as an interval unit.
           (to_timestamp(e.ts / 1000.0) at time zone 'UTC')::date as day,
           count(*) filter (where e.sentiment = 'positive') pos,
           count(*) filter (where e.sentiment = 'negative') neg
    from public.events e
    where public.is_admin() and not e.deleted and e.sentiment is not null
    group by 1, 2
  )
  select d.ticker,
         (extract(epoch from d.day) * 1000)::bigint + 86399999 ts,
         case when d.pos > d.neg then 'positive'
              when d.neg > d.pos then 'negative'
              else 'neutral' end sentiment
  from d
  order by d.ticker, d.day;
$$;
grant execute on function public.network_community_sentiment() to authenticated;
