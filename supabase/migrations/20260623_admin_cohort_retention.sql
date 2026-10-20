-- GROUP 6: weekly cohort retention. Cohort = ISO week of a user's first-ever
-- event; offsets W+0..W+12. Security-definer, gated by public.is_admin().
create or replace function public.admin_cohort_retention()
returns table(
  cohort_week date, week_offset int, retained_users int, cohort_size int, retention_rate numeric
)
language sql stable security definer set search_path = public as $$
  with first_ev as (
    select user_id, date_trunc('week', to_timestamp(min(ts) / 1000)) as cohort_wk
    from public.events
    where not deleted and public.is_admin()
    group by user_id
  ),
  activity as (
    select distinct e.user_id, date_trunc('week', to_timestamp(e.ts / 1000)) as act_wk
    from public.events e
    where not deleted and public.is_admin()
  ),
  joined as (
    select f.cohort_wk, f.user_id,
      (extract(epoch from (a.act_wk - f.cohort_wk)) / 604800)::int as woff
    from first_ev f
    join activity a on a.user_id = f.user_id
    where a.act_wk >= f.cohort_wk
  ),
  sizes as (
    select cohort_wk, count(*) as cohort_size from first_ev group by cohort_wk
  ),
  retained as (
    select cohort_wk, woff, count(distinct user_id) as retained_users
    from joined
    where woff between 0 and 12
    group by cohort_wk, woff
  )
  select s.cohort_wk::date, o.woff::int,
    coalesce(r.retained_users, 0)::int, s.cohort_size::int,
    round(coalesce(r.retained_users, 0)::numeric / nullif(s.cohort_size, 0), 4)
  from sizes s
  cross join generate_series(0, 12) as o(woff)
  left join retained r on r.cohort_wk = s.cohort_wk and r.woff = o.woff
  order by s.cohort_wk, o.woff;
$$;
grant execute on function public.admin_cohort_retention() to authenticated;
