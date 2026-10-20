-- Close a privilege escalation on public.profiles.
--
-- profiles_self_upd is "for update using (id = auth.uid())" - a user may write
-- their own profile row. is_admin lives in that row, and nothing restricted
-- which COLUMNS the update could touch, so any signed-in user could run
--
--   supabase.from('profiles').update({ is_admin: true }).eq('id', <own uid>)
--
-- and become an admin. public.is_admin() is security definer and gates the
-- admin SELECT policies on events / intraday / user_meta / feedback plus every
-- admin_* and world_* RPC, so that one call handed out read access to every
-- user's attention history, email, name and feedback.
--
-- Two independent controls, because one of them is a GRANT and a later blanket
-- "grant all on all tables in schema public" would quietly undo it:
--   1. column-level UPDATE grants - the client may only write email and name;
--   2. a trigger that refuses an is_admin change arriving over the API roles.
--
-- No client writes profiles at all today (both clients only SELECT is_admin),
-- so this takes nothing away. Promotion stays a SQL-editor action, run as
-- postgres, which is neither of the API roles and so passes the trigger:
--   update public.profiles set is_admin = true where email = 'you@example.com';

revoke update on public.profiles from anon, authenticated;
grant update (email, name) on public.profiles to authenticated;

create or replace function public.profiles_guard_admin() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- PostgREST runs API requests as anon/authenticated; the SQL editor, service
  -- role and migrations do not, and keep full control of the column.
  if new.is_admin is distinct from old.is_admin
     and current_user in ('anon', 'authenticated') then
    raise exception 'is_admin is not client-writable';
  end if;
  new.id := old.id;
  new.created_at := old.created_at;
  return new;
end; $$;

drop trigger if exists profiles_guard_admin on public.profiles;
create trigger profiles_guard_admin before update on public.profiles
  for each row execute function public.profiles_guard_admin();
