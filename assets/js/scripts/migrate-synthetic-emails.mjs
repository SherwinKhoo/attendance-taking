// One-time backfill: rewrite synthetic auth.users emails from the legacy
// `{pass_id}@passid.local` shape to `{pass_id}@{campus}.local`.
//
// Run AFTER applying supabase/migrations/per_campus_pass_id_and_hostname_safe.sql
// (which relaxes the global pass-ID uniqueness to per-campus) and BEFORE
// deploying the updated client / provision Edge Function. The cutover window
// between those two steps must be short — during it, the client cannot
// authenticate any account that has already been backfilled, and provisioning
// would still produce legacy-shape emails. Plan accordingly.
//
// Usage:
//   SUPABASE_URL=https://<ref>.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
//   node scripts/migrate-synthetic-emails.mjs
//
// Idempotent: rows already in the new shape are skipped. Auth users without
// a matching profile are reported as orphans and left for
// cleanup_orphaned_synthetic_auth_users() to sweep.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in env.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const LEGACY_SUFFIX = "@passid.local";

async function listAllAuthUsers() {
  const all = [];
  let page = 1;
  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`listUsers page ${page}: ${error.message}`);
    const users = data?.users ?? [];
    all.push(...users);
    if (users.length < 1000) break;
    page += 1;
  }
  return all;
}

async function loadProfilesByProfileId() {
  // Load (profile_id, pass_id, campus) for every profile, archived or not.
  // We rewrite emails for archived rows too so that orphan-cleanup matches the
  // new domain shape uniformly.
  const byId = new Map();
  let from = 0;
  const pageSize = 1000;
  for (;;) {
    const { data, error } = await supabase
      .from("profiles")
      .select("profile_id, pass_id, campus")
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`profiles select: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) byId.set(r.profile_id, r);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return byId;
}

function newEmailFor(profile) {
  if (!profile.pass_id || !profile.campus) return null;
  return `${profile.pass_id.toLowerCase()}@${profile.campus.toLowerCase()}.local`;
}

async function main() {
  console.log("Listing auth.users...");
  const users = await listAllAuthUsers();
  console.log(`  found ${users.length} auth users`);

  console.log("Loading profiles...");
  const profiles = await loadProfilesByProfileId();
  console.log(`  found ${profiles.size} profile rows`);

  let migrated = 0;
  let skipped = 0;
  let orphaned = 0;
  let unchanged = 0;
  const errors = [];

  for (const u of users) {
    const email = (u.email ?? "").toLowerCase();
    if (!email.endsWith(LEGACY_SUFFIX)) {
      // Not a legacy synthetic email — either already migrated, or a real
      // operator account. Nothing to do.
      unchanged += 1;
      continue;
    }
    const profile = profiles.get(u.id);
    if (!profile) {
      orphaned += 1;
      continue;
    }
    const target = newEmailFor(profile);
    if (!target) {
      // pass_id null (archived without pass_id) — also an orphan from this
      // script's standpoint; cleanup helper handles it.
      orphaned += 1;
      continue;
    }
    if (target === email) {
      skipped += 1;
      continue;
    }
    const { error } = await supabase.auth.admin.updateUserById(u.id, {
      email: target,
      email_confirm: true,
    });
    if (error) {
      errors.push({ id: u.id, email, target, message: error.message });
      continue;
    }
    migrated += 1;
  }

  console.log("\nDone.");
  console.log(`  migrated: ${migrated}`);
  console.log(`  skipped (already in new shape): ${skipped}`);
  console.log(`  unchanged (not legacy synthetic): ${unchanged}`);
  console.log(`  orphans (no matching profile, left for cleanup): ${orphaned}`);
  if (errors.length > 0) {
    console.log(`  errors: ${errors.length}`);
    for (const e of errors) console.log(`    ${e.email} -> ${e.target}: ${e.message}`);
    process.exit(2);
  }
  if (orphaned > 0) {
    console.log(
      "\nRun `select public.cleanup_orphaned_synthetic_auth_users();` to sweep the orphans.",
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
