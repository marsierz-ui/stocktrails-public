-- GROUP B1: market-session classification.
-- Stores the US/Eastern trading session at capture time on both databases, and
-- provides a SQL helper so analytics RPCs can classify pre-feature rows from ts.
--
-- Sessions (ET local wall-clock):
--   pre_market   04:00-09:29   (minutes 240-569)
--   market_hours 09:30-16:00   (minutes 570-960)
--   after_hours  16:01-19:59   (minutes 961-1199)
--   overnight    20:00-03:59   (everything else)

create or replace function public.market_session(ts_ms bigint)
returns text
language sql
stable
set search_path to 'public'
as $$
  select case
    when ts_ms is null then null
    else (
      select case
        when m between 240 and 569 then 'pre_market'
        when m between 570 and 960 then 'market_hours'
        when m between 961 and 1199 then 'after_hours'
        else 'overnight'
      end
      from (
        select (extract(hour from et) * 60 + extract(minute from et))::int as m
        from (select (to_timestamp(ts_ms / 1000.0) at time zone 'America/New_York') as et) e
      ) x
    )
  end;
$$;

do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='events' and column_name='market_session') then
    alter table public.events add column market_session text;
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='intraday' and column_name='market_session') then
    alter table public.intraday add column market_session text;
  end if;
  if not exists (select 1 from pg_constraint where conname='events_market_session_chk') then
    alter table public.events add constraint events_market_session_chk
      check (market_session is null or market_session in ('pre_market','market_hours','after_hours','overnight'));
  end if;
  if not exists (select 1 from pg_constraint where conname='intraday_market_session_chk') then
    alter table public.intraday add constraint intraday_market_session_chk
      check (market_session is null or market_session in ('pre_market','market_hours','after_hours','overnight'));
  end if;
end $$;
