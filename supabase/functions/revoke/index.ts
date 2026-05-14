// supabase/functions/revoke/index.ts
//
// Admin-only batch + single revocation Edge Function.
//
// Request:
//   POST /functions/v1/revoke
//   Authorization: Bearer <user JWT>
//   Body (one of):
//     { pass_ids: ["X-001", "X-002", ...] }     -- explicit list
//     { campus: "PROTO" }                        -- bulk by campus
//     { campus: "PROTO", group_name: "Y", sub_group: "Z" } -- narrower bulk
//
//   At least one selector is required. All selectors are AND-ed: a row must
//   satisfy every provided selector to be revoked. Already-archived rows are
//   skipped.
//
// Response:
//   {
//     ok: true,
//     revoked: [{ pass_id, profile_id, campus }, ...],
//     skipped: [{ pass_id, reason }, ...],
//     errors:  [{ pass_id, message }, ...]
//   }

import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { getCallerProfile, serviceRoleClient } from "../_shared/auth.ts";

interface RevokeRequest {
  pass_ids?: string[];
  campus?: string;
  group_name?: string;
  sub_group?: string;
}

interface ProfileMatch {
  profile_id: string;
  pass_id: string;
  campus: string | null;
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

  let body: RevokeRequest;
  try {
    body = (await req.json()) as RevokeRequest;
  } catch {
    return jsonResponse(req, { ok: false, error: "Invalid JSON body." }, 400);
  }

  const passIds = Array.isArray(body.pass_ids)
    ? body.pass_ids
        .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
        .map((p) => p.trim().toUpperCase())
    : [];
  const campus = typeof body.campus === "string" && body.campus.trim()
    ? body.campus.trim().toUpperCase()
    : undefined;
  const groupName = typeof body.group_name === "string" && body.group_name.trim()
    ? body.group_name.trim()
    : undefined;
  const subGroup = typeof body.sub_group === "string" && body.sub_group.trim()
    ? body.sub_group.trim()
    : undefined;

  if (passIds.length === 0 && !campus && !groupName && !subGroup) {
    return jsonResponse(req, 
      { ok: false, error: "At least one of pass_ids, campus, group_name, sub_group is required." },
      400,
    );
  }

  // Per-campus admin scope: limit any filter to their scope; reject pass_ids
  // that resolve outside scope when fetched.
  if (caller.admin_campus_scope) {
    if (campus && campus !== caller.admin_campus_scope) {
      return jsonResponse(req, 
        {
          ok: false,
          error: `Admin scope (${caller.admin_campus_scope}) does not include campus ${campus}.`,
        },
        403,
      );
    }
  }

  const service = serviceRoleClient();

  // Resolve target rows. All provided selectors are AND-ed so that e.g.
  // (campus=A, pass_ids=[U-001]) revokes only U-001 in Campus A, not every
  // U-001 across campuses nor every profile in Campus A.
  let query = service
    .from("profiles")
    .select("profile_id, pass_id, campus")
    .is("archived_at", null);

  const effectiveCampus = campus ?? caller.admin_campus_scope ?? null;
  if (effectiveCampus) query = query.eq("campus", effectiveCampus);
  if (groupName) query = query.eq("group_name", groupName);
  if (subGroup) query = query.eq("sub_group", subGroup);
  if (passIds.length > 0) query = query.in("pass_id", passIds);

  const { data: targetData, error: targetErr } = await query;
  if (targetErr) {
    return jsonResponse(req,
      { ok: false, error: `profiles lookup failed: ${targetErr.message}` },
      500,
    );
  }
  const targets = (targetData as ProfileMatch[]) ?? [];

  const skipped: { pass_id: string; reason: string }[] = [];
  if (passIds.length > 0) {
    const found = new Set(targets.map((r) => r.pass_id));
    for (const pid of passIds) {
      if (!found.has(pid)) {
        skipped.push({
          pass_id: pid,
          reason: "no active profile in the given scope (already archived, unknown, or outside campus/group filter).",
        });
      }
    }
  }

  const revoked: ProfileMatch[] = [];
  const errors: { pass_id: string; message: string }[] = [];

  for (const t of targets) {
    // Delete the auth.users row. profiles.profile_id REFERENCES
    // auth.users(id) ON DELETE CASCADE, so this also removes the matching
    // profile row. All four profile-referencing FKs (audit_events.actor_profile_id,
    // attendance_attempts.profile_id, attendance_sessions.creator_profile_id,
    // notifications.created_by) are ON DELETE SET NULL, so the cascade
    // succeeds even for users with attendance / session / notification
    // history. Forensic identity survives via denormalized snapshots:
    // audit_events.metadata jsonb, attendance_attempts.submitter_pass_id
    // (+ submitter_campus), attendance_sessions.creator_pass_id
    // (+ creator_campus). The metadata jsonb on the revoke audit row below
    // also records pass_id + profile_id strings.
    const { error: delErr } = await service.auth.admin.deleteUser(t.profile_id);
    if (delErr) {
      errors.push({
        pass_id: t.pass_id,
        message: `auth.admin.deleteUser failed: ${delErr.message}`,
      });
      continue;
    }

    // Audit log. actor_profile_id here is the *admin who revoked* (still
    // alive); the revoked user's identity lives in the metadata.
    await service.from("audit_events").insert({
      event_type: "revoke_profile",
      actor_profile_id: caller.profile_id,
      actor_campus: caller.campus,
      metadata: {
        revoked_profile_id: t.profile_id,
        revoked_pass_id: t.pass_id,
        revoked_campus: t.campus,
      },
    });

    revoked.push(t);
  }

  // Sweep orphan auth.users rows (synthetic email, no matching profile). This
  // self-heals the project against blocked re-provisioning of any pass-ID —
  // whether the orphan came from a prior schema reapply, a failed provision
  // rollback, or this revoke's own deleteUser-failure fallback at line ~175.
  let orphansCleaned = 0;
  const { data: cleanCount, error: cleanErr } = await service.rpc(
    "cleanup_orphaned_synthetic_auth_users",
  );
  if (cleanErr) {
    errors.push({ pass_id: "(cleanup)", message: `cleanup failed: ${cleanErr.message}` });
  } else if (typeof cleanCount === "number") {
    orphansCleaned = cleanCount;
  }

  return jsonResponse(req, {
    ok: errors.length === 0,
    revoked,
    skipped,
    errors,
    orphans_cleaned: orphansCleaned,
  });
});
