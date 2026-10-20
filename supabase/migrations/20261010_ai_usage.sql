-- Per-user daily counter for the ai-coach Edge Function, so one account cannot
-- use up a shared model quota. Server-only: row level security is on and there is
-- no policy, so the anon and authenticated roles cannot read or write it; the
-- function reaches it with the service role through ai_usage_bump.
--
-- It stores a user id, a day and a number. Not the questions, not the answers.
-- Additive: nothing existing changes, and no client reads this table.

create table if not exists public.ai_usage (
  user_id uuid not null,
  day date not null,
  calls integer not null default 0,
  primary key (user_id, day)
);
alter table public.ai_usage enable row level security;

-- Counts one call for today (UTC). Returns the new count, or -1 (and counts
-- nothing) when that would pass p_cap.
create or replace function public.ai_usage_bump(p_user uuid, p_cap integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  d date := (now() at time zone 'utc')::date;
  n integer;
begin
  insert into public.ai_usage (user_id, day, calls) values (p_user, d, 1)
  on conflict (user_id, day) do update set calls = public.ai_usage.calls + 1
  returning calls into n;
  if n > p_cap then
    update public.ai_usage set calls = calls - 1 where user_id = p_user and day = d;
    return -1;
  end if;
  return n;
end;
$$;

revoke all on function public.ai_usage_bump(uuid, integer) from public, anon, authenticated;
grant execute on function public.ai_usage_bump(uuid, integer) to service_role;
