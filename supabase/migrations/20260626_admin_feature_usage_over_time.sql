-- Feature usage over time: per-bucket per-section counts within a window, so the
-- dashboard can chart each section's share (%) of navigation over time.

create or replace function public.admin_feature_usage_over_time(p_from bigint, p_to bigint, p_unit text)
returns table(bucket timestamptz, section text, n bigint)
language sql stable security definer set search_path to 'public'
as $$
  select date_trunc(case when p_unit in ('hour','day','week','month','year') then p_unit else 'day' end, ts) as bucket,
    section, count(*)
  from public.feature_usage
  where public.is_admin()
    and ts >= to_timestamp(p_from / 1000.0) and ts < to_timestamp(p_to / 1000.0)
  group by 1, 2 order by 1, 2;
$$;
