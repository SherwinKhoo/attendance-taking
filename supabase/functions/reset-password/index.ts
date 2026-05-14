// supabase/functions/reset-password/index.ts
//
// Admin-only single-target password reset. Sends the affected user back to
// today's per-campus daily temp without revoking them. For claimed accounts
// it also force-logs-out every device.
//
// Request:
//   POST /functions/v1/reset-password
//   Authorization: Bearer <admin JWT>
//   Body: { pass_id: "X-123", campus?: "PROTO" }
//
// Campus is required to disambiguate (pass-IDs are unique per campus, not
// globally). Per-campus admins may omit it; their admin_campus_scope is used.
// Global admins must supply it explicitly; otherwise a same-string pass-ID
// in multiple campuses returns a 400.
//
// Response:
//   {
//     ok: true,
//     pass_id: "X-123",
//     campus: "PROTO",
//     claimed_before: false | true,
//     temp_password: "...",   // today's per-campus temp
//   }
//
// Behaviour:
//   - Unclaimed target (password_set_at IS NULL): no DB mutation. The user
//     can already sign in with today's temp; the admin just needs to re-share
//     it. claimed_before=false in the response.
//   - Claimed target: rewrite the password to today's temp, clear
//     password_set_at, revoke all refresh tokens. claimed_before=true.
//
// Audit: emits a `reset_password_to_temp` event with claimed_before in
// metadata regardless of branch.

import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import {
  assertAdmin,
  getCallerProfile,
  serviceRoleClient,
} from "../_shared/auth.ts";
import { generateTempPassword } from "../_shared/password.ts";

interface ResetRequest {
  pass_id?: string;
  campus?: string;
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

  let body: ResetRequest;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(req, { ok: false, error: "Body must be JSON." }, 400);
  }

  const passId = String(body.pass_id ?? "").trim().toUpperCase();
  if (!passId) {
    return jsonResponse(req, { ok: false, error: "pass_id is required." }, 400);
  }
  const requestedCampus = typeof body.campus === "string" && body.campus.trim()
    ? body.campus.trim().toUpperCase()
    : null;

  const service = serviceRoleClient();

  // Look up target profile by (campus, pass_id). Pass-IDs are unique per
  // campus, not globally, so a campus is required to disambiguate. Per-campus
  // admins default to their own scope when none is provided; global admins
  // must supply one explicitly. limit(2) lets us distinguish the ambiguous
  // case cleanly without relying on .maybeSingle() (which errors on >1).
  const effectiveCampus = requestedCampus ?? caller.admin_campus_scope ?? null;
  let lookupQuery = service
    .from("profiles")
    .select("profile_id, pass_id, campus, password_set_at, archived_at")
    .eq("pass_id", passId)
    .is("archived_at", null)
    .limit(2);
  if (effectiveCampus) lookupQuery = lookupQuery.eq("campus", effectiveCampus);
  const { data: rows, error: lookupErr } = await lookupQuery;
  if (lookupErr) {
    return jsonResponse(req, { ok: false, error: lookupErr.message }, 500);
  }
  if (!rows || rows.length === 0) {
    return jsonResponse(
      req,
      {
        ok: false,
        error: effectiveCampus
          ? `No active profile for ${passId} in ${effectiveCampus}.`
          : `No active profile for ${passId}.`,
      },
      404,
    );
  }
  if (rows.length > 1) {
    return jsonResponse(
      req,
      {
        ok: false,
        error:
          `Pass-ID ${passId} exists in more than one campus. Specify campus in the request.`,
      },
      400,
    );
  }
  const target = rows[0];

  try {
    assertAdmin(caller, target.campus);
  } catch (err) {
    return jsonResponse(req, { ok: false, error: (err as Error).message }, 403);
  }

  // Always resolve today's temp first so the admin gets the same string
  // regardless of which branch we take.
  const candidate = generateTempPassword();
  const { data: tempData, error: tempErr } = await service.rpc(
    "ensure_today_temp",
    {
      p_campus: target.campus,
      p_candidate_temp: candidate,
    },
  );
  if (tempErr || !tempData) {
    return jsonResponse(
      req,
      {
        ok: false,
        error: tempErr?.message ?? "ensure_today_temp failed.",
      },
      500,
    );
  }
  const tempPassword = (tempData as { temp_password: string }).temp_password;

  const claimedBefore = target.password_set_at !== null;

  if (claimedBefore) {
    const { error: updErr } = await service.auth.admin.updateUserById(
      target.profile_id,
      { password: tempPassword },
    );
    if (updErr) {
      return jsonResponse(
        req,
        { ok: false, error: `updateUser failed: ${updErr.message}` },
        500,
      );
    }

    const { error: profErr } = await service
      .from("profiles")
      .update({ password_set_at: null })
      .eq("profile_id", target.profile_id);
    if (profErr) {
      return jsonResponse(
        req,
        { ok: false, error: `profiles update failed: ${profErr.message}` },
        500,
      );
    }

    // Revoke all refresh tokens for this user via a service-role RPC that
    // deletes from auth.refresh_tokens directly. Existing access tokens stay
    // valid until natural expiry (~1 h), but the next refresh on any device
    // will fail and supabase-js will emit SIGNED_OUT. The client also
    // listens for the password_set_at transition on the profiles realtime
    // channel for immediate logout of currently-open tabs.
    const { error: revokeErr } = await service.rpc(
      "revoke_user_refresh_tokens",
      { p_user_id: target.profile_id },
    );
    if (revokeErr) {
      // Soft failure: GoTrue may already have rotated tokens out via the
      // password change. Log but don't fail the reset.
      console.warn(
        "[reset-password] revoke_user_refresh_tokens error:",
        revokeErr.message,
      );
    }
  }

  await service.from("audit_events").insert({
    event_type: "reset_password_to_temp",
    actor_profile_id: caller.profile_id,
    actor_campus: caller.campus,
    metadata: {
      target_profile_id: target.profile_id,
      target_pass_id: passId,
      target_campus: target.campus,
      claimed_before: claimedBefore,
    },
  });

  return jsonResponse(req, {
    ok: true,
    pass_id: passId,
    campus: target.campus,
    claimed_before: claimedBefore,
    temp_password: tempPassword,
  });
});
