// Seed prototype users via the Supabase admin API.
//
// Why not pure SQL? The auth.users schema has a number of internal columns
// that vary by GoTrue version and trigger validation on read. Direct INSERT
// works for some Supabase versions but produces "Database error querying
// schema" on others. Using auth.admin.createUser is the supported path and
// future-proof.
//
// Usage:
//   SUPABASE_URL=https://<ref>.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
//   node scripts/seed-prototype.mjs
//
// You can find the service role key in the Supabase dashboard under
// Project Settings → API → "service_role" (NOT the anon key).
//
// The script is idempotent: re-running upserts profiles and updates the
// password to the dev value.

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

const DEV_PASSWORD = "Proto-Pass!1";
const CAMPUS = { code: "PROTO", name: "Prototype Campus", timezone: "Asia/Singapore" };

const SEED_USERS = [
  { pass_id: "A-001", role: "admin",          sub_group: "Admin Group",          display_name: "Prototype Admin" },
  { pass_id: "C-001", role: "coordinator",    sub_group: "Coordinator Group",    display_name: "Prototype Coordinator" },
  { pass_id: "R-001", role: "representative", sub_group: "Representative Group", display_name: "Prototype Representative" },
  { pass_id: "U-001", role: "user",           sub_group: "User Group",           display_name: "Prototype User" },
];

async function ensureCampus() {
  const { error } = await supabase.from("campuses").upsert(CAMPUS);
  if (error) throw new Error(`campus upsert failed: ${error.message}`);
}

async function findExistingByEmail(email) {
  // Paginate listUsers until we find a match. For four users this is one page.
  const { data, error } = await supabase.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });
  if (error) throw new Error(error.message);
  return data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
}

async function ensureUser(seed) {
  const email = `${seed.pass_id.toLowerCase()}@passid.local`;
  let user = await findExistingByEmail(email);

  if (user) {
    const { error: updErr } = await supabase.auth.admin.updateUserById(user.id, {
      password: DEV_PASSWORD,
      email_confirm: true,
    });
    if (updErr) throw new Error(`update failed: ${updErr.message}`);
  } else {
    const { data, error: createErr } = await supabase.auth.admin.createUser({
      email,
      password: DEV_PASSWORD,
      email_confirm: true,
    });
    if (createErr) throw new Error(`create failed: ${createErr.message}`);
    user = data.user;
  }

  const profileRow = {
    profile_id: user.id,
    pass_id: seed.pass_id,
    role: seed.role,
    campus: CAMPUS.code,
    group_name: "Prototype 2026",
    sub_group: seed.sub_group,
    display_name: seed.display_name,
    admin_campus_scope: null, // global admin for A-001
    password_set_at: new Date().toISOString(), // pre-claimed
  };

  const { error: upsertErr } = await supabase
    .from("profiles")
    .upsert(profileRow, { onConflict: "profile_id" });
  if (upsertErr) throw new Error(`profile upsert failed: ${upsertErr.message}`);

  return { ...seed, profile_id: user.id, email };
}

async function main() {
  console.log("Ensuring campus...");
  await ensureCampus();

  for (const seed of SEED_USERS) {
    process.stdout.write(`Seeding ${seed.pass_id}... `);
    const result = await ensureUser(seed);
    console.log(`ok (${result.profile_id})`);
  }

  console.log(`\nDone. Sign in with any pass-ID + password: ${DEV_PASSWORD}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
