-- =============================================================================
-- Activate the daily rotation cron.
-- =============================================================================
-- Prereqs:
--   1. supabase/schema.sql applied (defines campuses_due_for_rotation, etc.).
--   2. pg_cron AND pg_net extensions enabled. They may need to be turned on
--      manually in the Supabase dashboard:
--          Database → Extensions → search "pg_cron" → toggle on
--          Database → Extensions → search "pg_net"  → toggle on
--      (The CREATE EXTENSION calls below will succeed if you have permission;
--      if they fail, use the dashboard instead.)
--   3. The rotate-daily Edge Function deployed:
--        npx supabase functions deploy rotate-daily
--   4. ROTATE_DAILY_TOKEN set on the function's environment:
--        npx supabase secrets set ROTATE_DAILY_TOKEN=<long random>
--   5. Same value stored in Vault for pg_cron to read. From the SQL editor:
--        select vault.create_secret('<long random>', 'rotate_daily_token');
--
-- Replace <PROJECT_REF> below with your project's reference (the part before
-- `.supabase.co` in your project URL). For project icxzgizsbksydltbstdk that
-- value is `icxzgizsbksydltbstdk`.

-- 0. Ensure extensions are present (no-op if already enabled).
create extension if not exists pg_cron with schema cron;
create extension if not exists pg_net with schema extensions;

-- 1. Unschedule ALL prior versions of this job (idempotent, handles dupes).
do $$
declare
  r record;
begin
  for r in select jobid from cron.job where jobname = 'rotate-daily-temps' loop
    perform cron.unschedule(r.jobid);
  end loop;
end $$;

-- 2. Schedule the new job. Runs at minute 0 of every hour. The function
--    itself filters to campuses currently in their local rotation window.
select cron.schedule(
  'rotate-daily-temps',
  '0 * * * *',
  $cron$
    select net.http_post(
      url := 'https://icxzgizsbksydltbstdk.supabase.co/functions/v1/rotate-daily',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret from vault.decrypted_secrets where name = 'rotate_daily_token'
        )
      ),
      body := '{}'::jsonb
    );
  $cron$
);

-- 3. Verify:
--      select * from cron.job where jobname = 'rotate-daily-temps';
--      select * from cron.job_run_details order by start_time desc limit 5;
