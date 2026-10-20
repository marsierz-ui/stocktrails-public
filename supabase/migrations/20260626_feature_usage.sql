-- GROUP E4: feature usage tracking. One row per section-navigation event,
-- synced from the client ring-buffer. RLS scopes rows to their owner; admins
-- read all via admin_feature_usage() (security definer).

create table if not exists public.feature_usage (
  id uuid default gen_random_uuid() primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  section text not null,
  ts timestamptz not null,
  updated_at timestamptz default now()
);

alter table public.feature_usage enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='feature_usage' and policyname='feature_usage_own') then
    create policy feature_usage_own on public.feature_usage
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='feature_usage' and policyname='feature_usage_admin_sel') then
    create policy feature_usage_admin_sel on public.feature_usage
      for select using (public.is_admin());
  end if;
end $$;

create index if not exists feature_usage_user_section_idx on public.feature_usage (user_id, section);
create index if not exists feature_usage_section_ts_idx on public.feature_usage (section, ts);
