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
// The script is idempotent: re-running upserts profiles, resets the auth
// passwords to the values below, and resets password_set_at to NULL so all
// four accounts re-enter the forced password-change flow on next sign-in.
//
// PROTO is a zero-stakes onboarding/testing campus that mimics production:
//   - A-001 (admin) is given a memorable password (`ADMIN_PASSWORD`) so the
//     operator always has a known way in. It is NOT pre-claimed.
//   - C-001 / R-001 / U-001 are given the campus's current daily temp via
//     ensure_today_temp() — exactly what `provision` would assign — and are
//     left unclaimed (password_set_at = NULL).
//   - All four are forced through the password-change flow on first login.

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

const ADMIN_PASSWORD = "Password.123";
const CAMPUS = { code: "PROTO", name: "Prototype Campus", timezone: "Asia/Singapore" };

const SEED_USERS = [
  { pass_id: "A-001", role: "admin",          sub_group: "Admin Group",          display_name: "Prototype Admin" },
  { pass_id: "C-001", role: "coordinator",    sub_group: "Coordinator Group",    display_name: "Prototype Coordinator" },
  { pass_id: "R-001", role: "representative", sub_group: "Representative Group", display_name: "Prototype Representative" },
  { pass_id: "U-001", role: "user",           sub_group: "User Group",           display_name: "Prototype User" },
];

// Mirror of supabase/functions/_shared/password.ts:generateTempPassword.
// Keep in sync if the production generator changes (charset, length bounds).
const PW_UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const PW_LOWER = "abcdefghjkmnpqrstuvwxyz";
const PW_DIGIT = "23456789";
const PW_SYMBOL = "!@#$%^&*._-";
const PW_ALL = PW_UPPER + PW_LOWER + PW_DIGIT + PW_SYMBOL;

function pickChar(charset) {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return charset.charAt(buf[0] % charset.length);
}

function generateTempPassword(length = 12) {
  if (length < 10 || length > 16) throw new Error("Temp password length must be 10-16.");
  const chars = [pickChar(PW_UPPER), pickChar(PW_LOWER), pickChar(PW_DIGIT), pickChar(PW_SYMBOL)];
  for (let i = chars.length; i < length; i++) chars.push(pickChar(PW_ALL));
  for (let i = chars.length - 1; i > 0; i--) {
    const buf = new Uint32Array(1);
    globalThis.crypto.getRandomValues(buf);
    const j = buf[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

async function ensureCampus() {
  const { error } = await supabase.from("campuses").upsert(CAMPUS);
  if (error) throw new Error(`campus upsert failed: ${error.message}`);
}

async function ensureCampusTemp() {
  const candidate = generateTempPassword();
  const { data, error } = await supabase.rpc("ensure_today_temp", {
    p_campus: CAMPUS.code,
    p_candidate_temp: candidate,
  });
  if (error || !data) {
    throw new Error(`ensure_today_temp failed: ${error?.message ?? "no data"}`);
  }
  return data.temp_password;
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

async function ensureUser(seed, { tempPassword }) {
  const email = `${seed.pass_id.toLowerCase()}@${CAMPUS.code.toLowerCase()}.local`;
  const password = seed.role === "admin" ? ADMIN_PASSWORD : tempPassword;
  let user = await findExistingByEmail(email);

  if (user) {
    const { error: updErr } = await supabase.auth.admin.updateUserById(user.id, {
      password,
      email_confirm: true,
    });
    if (updErr) throw new Error(`update failed: ${updErr.message}`);
  } else {
    const { data, error: createErr } = await supabase.auth.admin.createUser({
      email,
      password,
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
    // PROTO is a sandbox; its admin is local to PROTO, not global. The
    // dedicated global admin lives in the ADMIN campus (see
    // scripts/seed-global-admin.mjs).
    admin_campus_scope: seed.role === "admin" ? CAMPUS.code : null,
    password_set_at: null,    // unclaimed: forced change on first sign-in
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

  // Sweep orphan synthetic-email auth.users from prior runs. Schema reapply
  // also calls this, but seeding without a fresh reapply (or re-seeding for
  // testing) still benefits — orphans block re-provisioning of the same
  // pass-ID with "already registered" errors.
  console.log("Sweeping orphan auth.users...");
  const { data: cleaned, error: cleanErr } = await supabase.rpc(
    "cleanup_orphaned_synthetic_auth_users",
  );
  if (cleanErr) {
    console.warn(`cleanup warning: ${cleanErr.message}`);
  } else {
    console.log(`  removed ${cleaned ?? 0} orphan(s).`);
  }

  console.log("Ensuring today's PROTO temp password...");
  const tempPassword = await ensureCampusTemp();

  for (const seed of SEED_USERS) {
    process.stdout.write(`Seeding ${seed.pass_id}... `);
    const result = await ensureUser(seed, { tempPassword });
    console.log(`ok (${result.profile_id})`);
  }

  console.log(`
Done.
  - Admin (A-001): ${ADMIN_PASSWORD}
  - All other seeded accounts (C-001, R-001, U-001): today's PROTO temp = ${tempPassword}
All four accounts will be prompted to change password on first sign-in.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
