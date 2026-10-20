-- Apply only when the crowd-alerts function is deployed and e-mail alerts go live.
-- Daily, after the second trending capture (21:40 UTC). The function is deployed
-- without JWT verification like `trending`; it only acts for users who opted in and
-- sends each alert once, so an extra call does nothing.
create extension if not exists pg_net;
create extension if not exists pg_cron;
select cron.unschedule(jobname) from cron.job where jobname = 'crowd-alerts';
select cron.schedule('crowd-alerts', '30 22 * * 1-5', $$
  select net.http_post(
    url := 'https://unymnlguicuwllkuqglm.supabase.co/functions/v1/crowd-alerts',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 60000);
$$);
