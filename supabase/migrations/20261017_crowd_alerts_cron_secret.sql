-- crowd-alerts now refuses calls without the shared secret (x-cron-secret), so the
-- daily job must send it. The value lives in Vault, never in the repo. Once, by hand:
--   supabase secrets set CROWD_ALERTS_SECRET=<random>
--   select vault.create_secret('<same random>', 'crowd_alerts_secret');
-- Replaces the job from 20261016_crowd_alerts_cron.sql only where that job exists;
-- where e-mail alerts are not live yet, this does nothing.
do $$
begin
  if to_regclass('cron.job') is not null and exists (select 1 from cron.job where jobname = 'crowd-alerts') then
    perform cron.unschedule('crowd-alerts');
    perform cron.schedule('crowd-alerts', '30 22 * * 1-5', $job$
      select net.http_post(
        url := 'https://unymnlguicuwllkuqglm.supabase.co/functions/v1/crowd-alerts',
        headers := jsonb_build_object('Content-Type', 'application/json',
          'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'crowd_alerts_secret')),
        body := '{}'::jsonb,
        timeout_milliseconds := 60000);
    $job$);
  end if;
end $$;
