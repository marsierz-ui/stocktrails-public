-- Schedule the trending capture inside Supabase, so it does not depend on GitHub
-- Actions (whose scheduled runs are best-effort: delayed under load, and
-- disabled after 60 days without repository activity). The GitHub workflow
-- stays as a second caller; the edge function's freshness and "day closed"
-- gates make a double call a no-op.
--
-- Two runs, an hour apart, because cron runs in UTC and the US close does not:
-- 20:40 UTC is 16:40 ET in summer (EDT) but 15:40 ET in winter (EST), before
-- the close. In summer the 20:40 run takes the day's final snapshot and the
-- 21:40 run is skipped as "day closed"; in winter the 20:40 run takes a
-- pre-close snapshot and the 21:40 run (16:40 EST) replaces it with the final one.
--
-- The anon key in the job is the public client key (it ships in the
-- extension); the function is deployed without JWT verification anyway.

create extension if not exists pg_net;
create extension if not exists pg_cron;

select cron.unschedule(jobname) from cron.job where jobname in ('trending-capture-a', 'trending-capture-b');

select cron.schedule('trending-capture-a', '40 20 * * 1-5', $$
  select net.http_post(
    url := 'https://unymnlguicuwllkuqglm.supabase.co/functions/v1/trending',
    headers := '{"Content-Type": "application/json", "apikey": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVueW1ubGd1aWN1d2xsa3VxZ2xtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIwMzI0OTMsImV4cCI6MjA5NzYwODQ5M30.5YjbkKI7qyostBsFK2ILbeDIGPftKHbcfvl2oeNC8HM", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVueW1ubGd1aWN1d2xsa3VxZ2xtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIwMzI0OTMsImV4cCI6MjA5NzYwODQ5M30.5YjbkKI7qyostBsFK2ILbeDIGPftKHbcfvl2oeNC8HM"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 60000);
$$);

select cron.schedule('trending-capture-b', '40 21 * * 1-5', $$
  select net.http_post(
    url := 'https://unymnlguicuwllkuqglm.supabase.co/functions/v1/trending',
    headers := '{"Content-Type": "application/json", "apikey": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVueW1ubGd1aWN1d2xsa3VxZ2xtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIwMzI0OTMsImV4cCI6MjA5NzYwODQ5M30.5YjbkKI7qyostBsFK2ILbeDIGPftKHbcfvl2oeNC8HM", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVueW1ubGd1aWN1d2xsa3VxZ2xtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIwMzI0OTMsImV4cCI6MjA5NzYwODQ5M30.5YjbkKI7qyostBsFK2ILbeDIGPftKHbcfvl2oeNC8HM"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 60000);
$$);
