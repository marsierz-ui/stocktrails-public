-- Third-party attention lists: keep everything, index only stocks.
--
-- None of the lists except Wikipedia publish history, so what is not stored at
-- capture time is gone for good.
--  1. trending_raw: every capture's full response per source, append-only
--     (the per-day rows in trending_snapshots are REPLACED by each later capture
--     of the day). Kept for later research, readable by admins only.
--  2. trending_snapshots.asset: what each listed symbol is - equity, etf,
--     crypto, index, fx, commodity, other. Stocktwits sends instrument_class
--     (its .X symbols are crypto); Yahoo's list mixes in indices (^GSPC),
--     crypto pairs (BTC-USD) and FX (=X). All of it is stored.
--  3. trending_daily() - what the index lines read - returns equities and ETFs
--     only, re-ranked among them, so a coin at rank 1 neither enters an index
--     nor pushes the stocks down a rank.
alter table public.trending_snapshots add column if not exists asset text;

update public.trending_snapshots set asset = case
    when ticker like '%.X' and source = 'stocktwits' then 'crypto'
    when ticker like '^%' then 'index'
    when ticker ~ '-(USD|USDT|EUR|BTC|ETH)$' then 'crypto'
    when ticker like '%=X' then 'fx'
    when ticker like '%=F' then 'commodity'
    else 'equity' end
  where asset is null;

create table if not exists public.trending_raw (
  id bigserial primary key,
  source text not null,
  day date not null,
  captured_at timestamptz not null default now(),
  payload jsonb not null
);
create index if not exists trending_raw_source_day on public.trending_raw(source, day);
alter table public.trending_raw enable row level security;
drop policy if exists trending_raw_admin_sel on public.trending_raw;
create policy trending_raw_admin_sel on public.trending_raw for select using (public.is_admin());

create or replace function public.trending_daily(p_days integer default 180, p_top integer default 10)
returns table(source text, day date, weights jsonb)
language sql stable security definer set search_path to 'public'
as $$
  with r as (
    select s.source, s.day, s.ticker, s.views,
           row_number() over (partition by s.source, s.day order by s.rank) rn
    from public.trending_snapshots s
    where s.day >= (current_date - greatest(p_days, 1))
      and coalesce(s.asset, 'equity') in ('equity', 'etf')
  )
  select r.source, r.day, jsonb_object_agg(r.ticker, jsonb_build_array(r.views, r.rn))
  from r
  where r.rn <= greatest(p_top, 1)
  group by r.source, r.day
  order by r.source, r.day;
$$;
