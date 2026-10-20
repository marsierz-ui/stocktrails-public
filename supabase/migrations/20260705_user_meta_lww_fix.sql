-- user_meta LWW fix.
--
-- keep_newer() returns OLD for any UPDATE that does not bump updated_at. The
-- best-effort adoption update in cloud.js trySync (last_seen_session,
-- position_taken, target_price, last_ua, dashboard_ms - and now country for the
-- World view) deliberately never bumps updated_at so it cannot interfere with
-- config sync - which means the trigger has been discarding it entirely (all
-- those columns are null in production despite the client writing them).
--
-- Replace user_meta's trigger with a variant that applies last-write-wins to
-- the synced payload only (config + updated_at) and lets other column updates
-- through. events/intraday keep the original keep_newer().
create or replace function public.user_meta_keep_newer() returns trigger
language plpgsql as $$
begin
  if new.updated_at <= old.updated_at then
    new.config := old.config;
    new.updated_at := old.updated_at;
  end if;
  return new;
end; $$;

drop trigger if exists meta_lww on public.user_meta;
create trigger meta_lww before update on public.user_meta
for each row execute function public.user_meta_keep_newer();
