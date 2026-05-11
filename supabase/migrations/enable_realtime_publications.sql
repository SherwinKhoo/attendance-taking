-- Enable Supabase Realtime postgres_changes for the two tables the client
-- subscribes to: notifications (live admin-posted alerts) and profiles
-- (immediate force-logout when archived_at is set by the revoke flow).
--
-- Idempotent: each block checks pg_publication_tables before adding so the
-- migration is safe to re-run and does not fail if the table is already in
-- the publication. The publication itself (`supabase_realtime`) is created
-- by Supabase on project setup.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'profiles'
  ) then
    alter publication supabase_realtime add table public.profiles;
  end if;
end $$;
