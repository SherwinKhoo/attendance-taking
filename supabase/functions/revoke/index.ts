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
//   At least one selector is required. Filter and pass_ids may be combined;
//   the union of matches is revoked. Already-archived rows are skipped.
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

  // Resolve target rows.
  let query = service
    .from("profiles")
    .select("profile_id, pass_id, campus")
    .is("archived_at", null);

  // Bulk filter selectors.
  const effectiveCampus = campus ?? caller.admin_campus_scope ?? null;
  if (effectiveCampus) query = query.eq("campus", effectiveCampus);
  if (groupName) query = query.eq("group_name", groupName);
  if (subGroup) query = query.eq("sub_group", subGroup);

  // Explicit pass_ids (union with filter).
  // Postgrest `.or()` would let us combine, but the simpler model: if pass_ids
  // were given, we ALSO fetch them separately and merge, since the filter may
  // be empty. If only filter is given, the query above is the whole set.
  let bulkRows: ProfileMatch[] = [];
  if (campus || groupName || subGroup) {
    const { data, error } = await query;
    if (error) {
      return jsonResponse(req, 
        { ok: false, error: `profiles lookup failed: ${error.message}` },
        500,
      );
    }
    bulkRows = (data as ProfileMatch[]) ?? [];
  }

  let listRows: ProfileMatch[] = [];
  if (passIds.length > 0) {
    let listQuery = service
      .from("profiles")
      .select("profile_id, pass_id, campus")
      .is("archived_at", null)
      .in("pass_id", passIds);
    if (caller.admin_campus_scope) {
      listQuery = listQuery.eq("campus", caller.admin_campus_scope);
    }
    const { data, error } = await listQuery;
    if (error) {
      return jsonResponse(req, 
        { ok: false, error: `profiles lookup failed: ${error.message}` },
        500,
      );
    }
    listRows = (data as ProfileMatch[]) ?? [];
  }

  // Merge unique by profile_id.
  const merged = new Map<string, ProfileMatch>();
  for (const r of [...bulkRows, ...listRows]) merged.set(r.profile_id, r);
  const targets = Array.from(merged.values());

  const skipped: { pass_id: string; reason: string }[] = [];
  if (passIds.length > 0) {
    const found = new Set(listRows.map((r) => r.pass_id));
    for (const pid of passIds) {
      if (!found.has(pid)) {
        skipped.push({
          pass_id: pid,
          reason: "no active profile (already archived or unknown).",
        });
      }
    }
  }

  const revoked: ProfileMatch[] = [];
  const errors: { pass_id: string; message: string }[] = [];

  for (const t of targets) {
    // Delete the auth.users row. profiles.profile_id REFERENCES
    // auth.users(id) ON DELETE CASCADE, so this also removes the matching
    // profile row (and, via the SET NULL FK we added on
    // audit_events.actor_profile_id, leaves audit history intact with a
    // null actor). The metadata jsonb below still records pass_id +
    // profile_id strings for forensic lookups.
    //
    // CAVEAT: if the revoked user has rows in attendance_sessions,
    // attendance_attempts, or notifications.created_by, those FKs are
    // still NO ACTION and will block the cascade. The error path below
    // surfaces that explicitly so an operator knows to address those FKs
    // (same SET NULL / nullable-column pattern) before re-trying.
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
