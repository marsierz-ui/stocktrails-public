-- GROUP E1 / E4: per-user adoption + last-seen session tracking on user_meta.
-- All additive and nullable; synced last-write-wins alongside the config blob.

do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='user_meta' and column_name='last_seen_session') then
    alter table public.user_meta add column last_seen_session text;
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='user_meta' and column_name='position_taken') then
    alter table public.user_meta add column position_taken boolean;
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='user_meta' and column_name='target_price') then
    alter table public.user_meta add column target_price real;
  end if;
end $$;
