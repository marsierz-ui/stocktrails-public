-- Free-tier keepalive. The previous ping was an anon SELECT against an
-- RLS-protected table, which returns zero rows and did not stop the project
-- auto-pausing. This does a real write instead.
create table if not exists public.keepalive (
  id smallint primary key,
  pinged_at timestamptz not null default now(),
  ping_count bigint not null default 0,
  constraint keepalive_single_row check (id = 1)
);

insert into public.keepalive (id) values (1) on conflict (id) do nothing;

alter table public.keepalive enable row level security;
-- Deliberately no policies: reachable only via the SECURITY DEFINER function.

create or replace function public.keepalive_ping()
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare ts timestamptz;
begin
  update public.keepalive
     set pinged_at = now(), ping_count = ping_count + 1
   where id = 1
   returning pinged_at into ts;
  return ts;
end;
$$;

revoke all on function public.keepalive_ping() from public;
grant execute on function public.keepalive_ping() to anon, authenticated;
