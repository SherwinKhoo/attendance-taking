// supabase/functions/provision/index.ts
//
// Admin-only batch + single-add provisioning Edge Function.
//
// Request:
//   POST /functions/v1/provision
//   Authorization: Bearer <user JWT>
//   Body: {
//     ingest_names: boolean,           // if false, display_name is dropped
//     rows: [{
//       pass_id:     string,           // required
//       role:        "user" | "representative" | "coordinator" | "admin",  // required
//       campus:      string,           // required for global admin; defaults to caller's scope
//       group_name?: string,
//       sub_group?:  string,
//       display_name?: string          // only ingested if ingest_names = true
//     }, ...]
//   }
//
// Response:
//   {
//     ok: true,
//     campus_temps: { [campus_code]: temp_password },
//     provisioned: [{ pass_id, campus, profile_id }, ...],
//     errors:      [{ row_index, pass_id, message }, ...]
//   }

import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import {
  assertAdmin,
  getCallerProfile,
  serviceRoleClient,
} from "../_shared/auth.ts";
import { generateTempPassword } from "../_shared/password.ts";

const VALID_ROLES = ["user", "representative", "coordinator", "admin"] as const;
type Role = typeof VALID_ROLES[number];

interface ProvisionRow {
  pass_id: string;
  role: Role;
  campus: string;
  group_name: string;
  sub_group: string;
  display_name?: string | null;
}

interface ProvisionRequest {
  ingest_names?: boolean;
  rows: ProvisionRow[];
}

interface RowResult {
  row_index: number;
  pass_id: string;
  campus: string;
  profile_id?: string;
  message?: string;
}

function syntheticEmail(passId: string, campus: string): string {
  return `${passId.toLowerCase()}@${campus.toLowerCase()}.local`;
}

function normalisePassId(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().toUpperCase();
}

function validateRow(row: unknown, rowIndex: number): ProvisionRow {
  if (!row || typeof row !== "object") {
    throw new Error(`Row ${rowIndex}: not an object.`);
  }
  const r = row as Record<string, unknown>;

  const pass_id = normalisePassId(r.pass_id);
  if (!pass_id || pass_id.length > 64) {
    throw new Error(`Row ${rowIndex}: pass_id is required (max 64 chars).`);
  }

  const role = typeof r.role === "string" ? r.role.trim().toLowerCase() : "";
  if (!VALID_ROLES.includes(role as Role)) {
    throw new Error(
      `Row ${rowIndex}: role must be one of ${VALID_ROLES.join(", ")}.`,
    );
  }

  const campus = typeof r.campus === "string" && r.campus.trim()
    ? r.campus.trim().toUpperCase()
    : "";
  if (!campus) {
    throw new Error(`Row ${rowIndex}: campus is required.`);
  }

  const group_name = typeof r.group_name === "string" && r.group_name.trim()
    ? r.group_name.trim()
    : "";
  if (!group_name) {
    throw new Error(`Row ${rowIndex}: group_name is required.`);
  }

  const sub_group = typeof r.sub_group === "string" && r.sub_group.trim()
    ? r.sub_group.trim()
    : "";
  if (!sub_group) {
    throw new Error(`Row ${rowIndex}: sub_group is required.`);
  }

  return {
    pass_id,
    role: role as Role,
    campus,
    group_name,
    sub_group,
    display_name: typeof r.display_name === "string" && r.display_name.trim()
      ? r.display_name.trim()
      : null,
  };
}

Deno.serve(async (req: Request) => {
  const optionsResponse = handleOptions(req);
  if (optionsResponse) return optionsResponse;

  if (req.method !== "POST") {
    return jsonResponse(req, { ok: false, error: "Method not allowed." }, 405);
  }

  let caller;
  try {
    caller = await getCallerProfile(req);
  } catch (err) {
    return jsonResponse(req, { ok: false, error: (err as Error).message }, 401);
  }

  if (caller.role !== "admin") {
    return jsonResponse(req, { ok: false, error: "Admin role required." }, 403);
  }

  let body: ProvisionRequest;
  try {
    body = (await req.json()) as ProvisionRequest;
  } catch {
    return jsonResponse(req, { ok: false, error: "Invalid JSON body." }, 400);
  }

  if (!Array.isArray(body.rows) || body.rows.length === 0) {
    return jsonResponse(req, { ok: false, error: "rows must be a non-empty array." }, 400);
  }
  if (body.rows.length > 500) {
    return jsonResponse(req, { ok: false, error: "Maximum 500 rows per request." }, 400);
  }

  const ingestNames = body.ingest_names === true;
  const service = serviceRoleClient();

  const provisioned: RowResult[] = [];
  const errors: RowResult[] = [];
  const campusTemps: Record<string, string> = {};

  for (let i = 0; i < body.rows.length; i++) {
    const idx = i + 1;
    let row: ProvisionRow;
    try {
      row = validateRow(body.rows[i], idx);
    } catch (err) {
      errors.push({
        row_index: idx,
        pass_id: typeof (body.rows[i] as { pass_id?: string })?.pass_id === "string"
          ? (body.rows[i] as { pass_id: string }).pass_id
          : "",
        campus: "",
        message: (err as Error).message,
      });
      continue;
    }

    // Campus is now mandatory per row (enforced by validateRow above); no
    // fall-back to admin scope. Per-campus admin scope is still verified next.
    const targetCampus = row.campus;

    // Verify scope.
    try {
      assertAdmin(caller, targetCampus);
    } catch (err) {
      errors.push({
        row_index: idx,
        pass_id: row.pass_id,
        campus: targetCampus,
        message: (err as Error).message,
      });
      continue;
    }

    // Resolve today's per-campus temp (insert candidate if first today).
    let tempPassword = campusTemps[targetCampus];
    if (!tempPassword) {
      const candidate = generateTempPassword();
      const { data, error } = await service.rpc("ensure_today_temp", {
        p_campus: targetCampus,
        p_candidate_temp: candidate,
      });
      if (error || !data) {
        errors.push({
          row_index: idx,
          pass_id: row.pass_id,
          campus: targetCampus,
          message: `ensure_today_temp failed: ${error?.message ?? "no data"}`,
        });
        continue;
      }
      tempPassword = (data as { temp_password: string }).temp_password;
      campusTemps[targetCampus] = tempPassword;
    }

    // Create the auth.users row.
    const email = syntheticEmail(row.pass_id, targetCampus);
    const { data: created, error: createErr } = await service.auth.admin
      .createUser({
        email,
        password: tempPassword,
        email_confirm: true,
      });
    if (createErr || !created.user) {
      errors.push({
        row_index: idx,
        pass_id: row.pass_id,
        campus: targetCampus,
        message: `auth.admin.createUser failed: ${createErr?.message ?? "no user returned"}`,
      });
      continue;
    }
    const userId = created.user.id;

    // Insert the profile row.
    const profileRow = {
      profile_id: userId,
      pass_id: row.pass_id,
      role: row.role,
      campus: targetCampus,
      group_name: row.group_name,
      sub_group: row.sub_group,
      display_name: ingestNames ? row.display_name : null,
      admin_campus_scope: row.role === "admin" ? targetCampus : null,
      password_set_at: null,
    };

    const { error: profileErr } = await service.from("profiles").insert(
      profileRow,
    );
    if (profileErr) {
      // Roll back the auth.users row to avoid orphans.
      await service.auth.admin.deleteUser(userId).catch(() => {});
      errors.push({
        row_index: idx,
        pass_id: row.pass_id,
        campus: targetCampus,
        message: `profile insert failed: ${profileErr.message}`,
      });
      continue;
    }

    provisioned.push({
      row_index: idx,
      pass_id: row.pass_id,
      campus: targetCampus,
      profile_id: userId,
    });
  }

  return jsonResponse(req, {
    ok: errors.length === 0,
    campus_temps: campusTemps,
    provisioned,
    errors,
  });
});
