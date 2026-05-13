// Demote the PROTO sandbox admin (A-001) from global to PROTO-local.
//
// Before this script, A-001 was seeded with admin_campus_scope = NULL (global
// reach) so the prototype operator could exercise every admin flow. With the
// dedicated global admin (A-000 in the ADMIN campus) in place, A-001 should
// only have authority within PROTO. This script applies that one-row UPDATE.
//
// Run AFTER scripts/seed-global-admin.mjs so there is always at least one
// global admin present.
//
// Usage:
//   SUPABASE_URL=https://<ref>.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
//   node scripts/demote-proto-admin.mjs
//
// Idempotent: running again is a no-op (rowcount 0).

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

const TARGET_PASS_ID = "A-001";
const TARGET_CAMPUS = "PROTO";

async function main() {
  // Only touch the row if it is currently global; this keeps the script a
  // strict no-op on re-runs and avoids surprising scope changes if an
  // operator manually pinned A-001 to a different campus.
  const { data, error } = await supabase
    .from("profiles")
    .update({ admin_campus_scope: TARGET_CAMPUS })
    .eq("pass_id", TARGET_PASS_ID)
    .eq("role", "admin")
    .eq("campus", TARGET_CAMPUS)
    .is("admin_campus_scope", null)
    .select("profile_id, pass_id, campus, admin_campus_scope");

  if (error) {
    console.error(`demote failed: ${error.message}`);
    process.exit(1);
  }

  if (!data || data.length === 0) {
    console.log(`No-op: ${TARGET_PASS_ID} is not a global admin in ${TARGET_CAMPUS}.`);
    console.log("(Either already demoted, or A-001 lives elsewhere now.)");
    return;
  }

  for (const r of data) {
    console.log(
      `Demoted profile_id=${r.profile_id} (${r.pass_id}@${r.campus}) → admin_campus_scope=${r.admin_campus_scope}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
