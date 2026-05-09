-- =============================================================================
-- Make profiles.campus / group_name / sub_group required.
-- =============================================================================
-- Use this on a live project to apply the v2-polish schema constraint without
-- the destructive `schema.sql` drop-and-recreate. Equivalent to applying
-- schema.sql when starting from a clean DB.
--
-- Safe-by-default: refuses to apply NOT NULL while any active profile row
-- still has a NULL in the affected columns. Inspect first; backfill or delete
-- offending rows; then re-run.
-- =============================================================================

-- 1. Inspect — counts of nulls in active (non-archived) rows.
do $$
declare
  v_null_campus int;
  v_null_group  int;
  v_null_sub    int;
begin
  select
    sum(case when campus is null then 1 else 0 end),
    sum(case when group_name is null then 1 else 0 end),
    sum(case when sub_group is null then 1 else 0 end)
  into v_null_campus, v_null_group, v_null_sub
  from public.profiles
  where archived_at is null;

  raise notice 'Active profiles with NULL campus:     %', coalesce(v_null_campus, 0);
  raise notice 'Active profiles with NULL group_name: %', coalesce(v_null_group, 0);
  raise notice 'Active profiles with NULL sub_group:  %', coalesce(v_null_sub, 0);

  if coalesce(v_null_campus, 0) + coalesce(v_null_group, 0) + coalesce(v_null_sub, 0) > 0 then
    raise exception 'Cannot apply NOT NULL: % null active rows. Backfill or revoke them first.',
      coalesce(v_null_campus, 0) + coalesce(v_null_group, 0) + coalesce(v_null_sub, 0);
  end if;
end $$;

-- 2. Apply NOT NULL.
alter table public.profiles alter column campus     set not null;
alter table public.profiles alter column group_name set not null;
alter table public.profiles alter column sub_group  set not null;

-- 3. Verify.
--   select column_name, is_nullable
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'profiles'
--     and column_name in ('campus', 'group_name', 'sub_group');
--   All three should report is_nullable = 'NO'.
