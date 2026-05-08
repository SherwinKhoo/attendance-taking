-- Remove auth.users rows that have no matching public.profiles row.
-- Useful after applying the destructive schema.sql, since the schema drops
-- public.profiles cascade but leaves auth.users untouched. Synthetic emails
-- linger and would conflict with fresh provisioning.
--
-- Safe scope: only deletes rows whose email looks like a synthetic
-- attendance address (ends with @passid.local) AND has no matching profile.
-- A real user who somehow exists in auth.users with a non-synthetic email is
-- left alone.
--
-- Inspect first:
--
--   select id, email
--   from auth.users u
--   where u.email like '%@passid.local'
--     and not exists (select 1 from public.profiles p where p.profile_id = u.id);
--
-- Then delete:

delete from auth.users u
where u.email like '%@passid.local'
  and not exists (
    select 1 from public.profiles p where p.profile_id = u.id
  );
