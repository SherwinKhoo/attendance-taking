# v2 cutover notes

`supabase/schema.sql` is destructive — it drops every legacy table (`profiles`,
`device_logins`, `attendance_*`, `audit_events`) and recreates the schema in
the Supabase Auth model. There is intentionally **no migration of legacy
credentials**. The live cutover is treated as a full-batch revoke: every user
re-registers via the new flow with a fresh per-campus daily temp.

## Order of operations on the live project

1. **Schedule a maintenance window.** Notify users; freeze provisioning and
   attendance submissions for the duration.
2. **Take a backup.** Use Supabase's "Database → Backups" or run `pg_dump` of
   the public schema. The legacy data is gone after step 4 — keep this
   somewhere safe.
3. **Apply `schema.sql`.** Wipes `public.*`, recreates v2 tables, helpers,
   RPCs, RLS, grants. Re-runnable thanks to the drop block at the top.
4. **Clean orphaned `auth.users`.** Any rows with synthetic emails left over
   from prior runs need to go before the new provisioning starts. Run
   `supabase/migrations/cleanup_orphaned_auth_users.sql`.
5. **Seed campuses.** Insert one row per campus into `public.campuses`. Pick
   the right IANA timezone string (`Asia/Singapore`, `Europe/London`, …).
6. **Seed at least one global admin.** Run the Node helper (recommended):

   ```bash
   SUPABASE_URL=https://<ref>.supabase.co \
   SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
   node scripts/seed-prototype.mjs
   ```

   This creates `A-001`/`C-001`/`R-001`/`U-001` (all with password
   `Proto-Pass!1`, pre-claimed) via `auth.admin.createUser`. Don't use the
   pure-SQL seed (`supabase/prototype_seed.sql`) — it tries to INSERT directly
   into `auth.users`, which is fragile across GoTrue schema versions.
7. **Deploy Edge Functions** (`provision`, `revoke`, `rotate-daily`) and set
   `ROTATE_DAILY_TOKEN` in their environment.
8. **Activate the cron schedule.** See `supabase/cron_schedule.sql`.
9. **Provision the first batch** via the admin panel CSV upload.
10. **Distribute** the per-campus daily temp + the per-row pass-IDs through
    the org's existing print channel.
11. **Open the maintenance window.** Users log in with pass-ID + the daily
    temp, hit the forced-change modal, set their own password.

## After cutover

The `assert_authenticated` helper denies any sensitive RPC for a profile
where `password_set_at IS NULL`, so users can't do anything until they've
claimed their account. The daily rotation cron at local 00:00 keeps the
unclaimed-pool temp fresh; the printout's exposure window is one day.

Stragglers who don't log in within 24 h ask the admin for "today's password"
(from the admin-panel display) — same workflow, no per-user re-issuance.

## When to repeat

Each end-of-cycle batch return runs through the same flow:
- **Bulk revoke** every user in the batch (filter by campus / group /
  sub_group, or paste the pass-ID list). `auth.users` deleted, `profiles`
  archived with `pass_id` cleared.
- **Bulk provision** the next batch's CSV. Same pass-IDs may recur — they
  collide with no archived row (because `pass_id` was nulled on archive).
