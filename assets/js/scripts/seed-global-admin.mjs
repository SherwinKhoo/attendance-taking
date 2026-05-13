// Seed the dedicated global admin (A-000) in the ADMIN campus.
//
// The global admin is the operator account with cross-campus reach
// (admin_campus_scope = NULL). It lives in its own ADMIN campus — never used
// for attendance, no geofence — so the operator identity stays separate from
// any real campus, including the PROTO sandbox.
//
// Usage:
//   SUPABASE_URL=https://<ref>.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
//   node scripts/seed-global-admin.mjs
//
// The script is idempotent: re-running upserts the campus, resets the auth
// password to a freshly-generated value (printed to stdout), and re-upserts
// the profile. password_set_at is reset to NULL so the global admin
// re-enters the forced password-change flow on next sign-in.
//
// Run AFTER applying supabase/migrations/per_campus_pass_id_and_hostname_safe.sql
// and AFTER scripts/migrate-synthetic-emails.mjs, so the new email shape is
// in place and the campus-code CHECK accepts "ADMIN".

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

const CAMPUS = { code: "ADMIN", name: "Global Admin", timezone: "Asia/Singapore" };
const PASS_ID = "A-000";
const DISPLAY_NAME = "Global Admin";
const GROUP_NAME = "Global";
const SUB_GROUP = "Admin";

// Mirror of scripts/seed-prototype.mjs / supabase/functions/_shared/password.ts.
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

function generateTempPassword(length = 16) {
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

async function ensureTodayTemp() {
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
  const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw new Error(error.message);
  return data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
}

async function main() {
  console.log(`Ensuring campus ${CAMPUS.code}...`);
  await ensureCampus();

  console.log(`Ensuring today's ${CAMPUS.code} temp password...`);
  // Side effect: rotates today's daily temp so the recovery path is live.
  // The returned value isn't reused for the admin password itself; we mint
  // a fresh strong password below.
  await ensureTodayTemp();

  const email = `${PASS_ID.toLowerCase()}@${CAMPUS.code.toLowerCase()}.local`;
  const password = generateTempPassword(16);

  console.log(`Provisioning ${PASS_ID} (${email})...`);
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
    pass_id: PASS_ID,
    role: "admin",
    campus: CAMPUS.code,
    group_name: GROUP_NAME,
    sub_group: SUB_GROUP,
    display_name: DISPLAY_NAME,
    admin_campus_scope: null,   // global reach
    password_set_at: null,      // forces change on first sign-in
  };

  const { error: upsertErr } = await supabase
    .from("profiles")
    .upsert(profileRow, { onConflict: "profile_id" });
  if (upsertErr) throw new Error(`profile upsert failed: ${upsertErr.message}`);

  console.log("\n========================================================");
  console.log("Global admin seeded.");
  console.log(`  campus:        ${CAMPUS.code}`);
  console.log(`  pass_id:       ${PASS_ID}`);
  console.log(`  email:         ${email}`);
  console.log(`  password:      ${password}`);
  console.log("  SAVE THIS PASSWORD NOW. It is not stored anywhere and");
  console.log("  cannot be recovered after this script exits. A forced");
  console.log("  password change runs on first sign-in.");
  console.log("========================================================");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
