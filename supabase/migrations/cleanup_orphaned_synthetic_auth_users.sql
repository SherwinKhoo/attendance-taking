-- Install (or replace) the helper that deletes auth.users rows with a
-- synthetic attendance email (...@passid.local) that no longer have a
-- matching public.profiles row. These orphans block re-provisioning of the
-- same pass-ID because Supabase rejects auth.admin.createUser with
-- "A user with this email address has already been registered."
--
-- Source of truth lives in supabase/schema.sql. This forward-only migration
-- is for live projects that don't want to take the destructive schema
-- re-apply path. Safe to re-run; CREATE OR REPLACE plus REVOKE/GRANT.
--
-- After applying:
--   - The revoke Edge Function calls this automatically on every batch.
--   - You can also run it manually:
--
--       select public.cleanup_orphaned_synthetic_auth_users();
--
--     Returns the number of rows deleted (0 if no orphans).
--
-- Inspect first if you want a list before deleting:
--
--   select id, email
--   from auth.users u
--   where u.email like '%@passid.local'
--     and not exists (select 1 from public.profiles p where p.profile_id = u.id);

create or replace function public.cleanup_orphaned_synthetic_auth_users()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deleted integer;
begin
  with d as (
    delete from auth.users u
    where u.email like '%@passid.local'
      and not exists (
        select 1 from public.profiles p where p.profile_id = u.id
      )
    returning 1
  )
  select count(*) into v_deleted from d;
  return v_deleted;
end;
$$;

revoke all on function public.cleanup_orphaned_synthetic_auth_users() from public, anon, authenticated;
grant execute on function public.cleanup_orphaned_synthetic_auth_users() to service_role;
