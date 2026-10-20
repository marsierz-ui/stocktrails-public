-- Crowd attention per stock, across platforms, and "back to earth" alerts.
--
-- 1. crowd_stock_daily(): the per-stock series of every tracked platform
--    (stockanalysis, apewisdom, stocktwits, yahoo ...) as one row per (source, day),
--    ticker -> [views, rank], like trending_daily but with NO top-N cut. Pass
--    p_tickers to keep the payload small (PostgREST caps a response at 1000 rows
--    and a day's list is long). A 'stocktrails' source is added on days when there
--    are enough users to keep individuals private (>= 20 active users that day and
--    >= 5 users on the ticker); until then it is simply absent.
-- 2. _crowd_settled() / crowd_settled(): stocks that were trending (rank <= 20 on
--    any platform) and that the user looked at around then, whose attention has
--    since subsided: no platform lists them in its top 50 for at least 3 captured
--    days after the last trending day. The user's own views come from intraday,
--    which already syncs; nothing new about the user is stored for this.
-- 3. crowd_notify / crowd_notified: the e-mail opt-in (off by default) and the
--    log that keeps each alert to one e-mail. The edge function crowd-alerts
--    reads them with the service role and sends.
-- All of it describes attention. None of it says to buy or sell.

create or replace function public.crowd_stock_daily(p_tickers text[] default null, p_days int default 60)
returns table(source text, day date, weights jsonb)
language sql stable security definer set search_path to 'public'
as $$
  with n as (select least(greatest(p_days, 1), 400) as d),
  ext as (
    select s.source, s.day, s.ticker, s.views, s.rank
    from public.trending_snapshots s, n
    where s.day >= current_date - n.d
      and coalesce(s.asset, 'equity') in ('equity', 'etf')
      and (p_tickers is null or s.ticker = any(p_tickers))
  ),
  v as (
    select i.user_id, i.ticker, (to_timestamp(i.ts / 1000.0) at time zone 'America/New_York')::date as d
    from public.intraday i, n
    where not i.deleted and i.ticker is not null
      and i.ts >= (extract(epoch from now()) * 1000)::bigint - n.d::bigint * 86400000
  ),
  act as (select d from v group by d having count(distinct user_id) >= 20),
  st as (
    select v.d, v.ticker, count(distinct v.user_id)::int as u
    from v join act on act.d = v.d
    group by v.d, v.ticker
    having count(distinct v.user_id) >= 5
  ),
  rk as (select d, ticker, u, row_number() over (partition by d order by u desc, ticker) as rn from st)
  select e.source, e.day, jsonb_object_agg(e.ticker, jsonb_build_array(e.views, e.rank))
  from ext e group by e.source, e.day
  union all
  select 'stocktrails', rk.d, jsonb_object_agg(rk.ticker, jsonb_build_array(rk.u, rk.rn))
  from rk where p_tickers is null or rk.ticker = any(p_tickers)
  group by rk.d
  order by 1, 2;
$$;
revoke execute on function public.crowd_stock_daily(text[], int) from public, anon;
grant execute on function public.crowd_stock_daily(text[], int) to authenticated;

create or replace function public._crowd_settled(p_user uuid, p_days int default 45)
returns table(ticker text, first_trend date, last_trend date, peak_rank int, sources text[], my_views int, quiet_days int)
language sql stable security definer set search_path to 'public'
as $$
  with cap as (select distinct day from public.trending_snapshots where day >= current_date - 140),
  tr as (
    select s.ticker, s.day, s.source, s.rank
    from public.trending_snapshots s
    where s.day >= current_date - least(greatest(p_days, 1), 90) - 20
      and coalesce(s.asset, 'equity') in ('equity', 'etf') and s.rank <= 20
  ),
  last_t as (select ticker, max(day) as l from tr group by 1),
  ep as (
    select tr.ticker, min(tr.day) as f, max(tr.day) as l, min(tr.rank)::int as peak, array_agg(distinct tr.source) as srcs
    from tr join last_t on last_t.ticker = tr.ticker and tr.day between last_t.l - 14 and last_t.l
    group by tr.ticker
  ),
  mine as (
    select i.ticker, count(*)::int as n
    from public.intraday i join ep on ep.ticker = i.ticker
    where i.user_id = p_user and not i.deleted
      and (to_timestamp(i.ts / 1000.0) at time zone 'America/New_York')::date between ep.f - 1 and ep.l + 2
    group by i.ticker
  ),
  after as (select ep.ticker, count(*)::int as quiet from ep join cap on cap.day > ep.l group by ep.ticker),
  warm as (
    select distinct s.ticker
    from public.trending_snapshots s join ep on ep.ticker = s.ticker and s.day > ep.l
    where s.rank <= 50 and coalesce(s.asset, 'equity') in ('equity', 'etf')
  )
  select ep.ticker, ep.f, ep.l, ep.peak, ep.srcs, mine.n, after.quiet
  from ep
  join mine on mine.ticker = ep.ticker
  join after on after.ticker = ep.ticker
  where ep.l >= current_date - p_days and after.quiet >= 3
    and ep.ticker not in (select ticker from warm)
  order by ep.l desc, ep.ticker;
$$;
revoke execute on function public._crowd_settled(uuid, int) from public, anon, authenticated;
grant execute on function public._crowd_settled(uuid, int) to service_role;

create or replace function public.crowd_settled(p_days int default 45)
returns table(ticker text, first_trend date, last_trend date, peak_rank int, sources text[], my_views int, quiet_days int)
language sql stable security definer set search_path to 'public'
as $$ select * from public._crowd_settled(auth.uid(), p_days); $$;
revoke execute on function public.crowd_settled(int) from public, anon;
grant execute on function public.crowd_settled(int) to authenticated;

create table if not exists public.crowd_notify (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email_on boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.crowd_notify enable row level security;
drop policy if exists crowd_notify_own on public.crowd_notify;
create policy crowd_notify_own on public.crowd_notify for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create table if not exists public.crowd_notified (
  user_id uuid not null references auth.users(id) on delete cascade,
  ticker text not null,
  last_trend date not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, ticker, last_trend)
);
alter table public.crowd_notified enable row level security; -- no policy: service role only
