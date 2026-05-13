// supabase/functions/rotate-daily/index.ts
//
// Daily per-campus rotation Edge Function. Called hourly by pg_cron via
// pg_net.http_post; only the campuses currently at local 00:00 are rotated.
//
// Auth: pre-shared secret in the Authorization header. The pg_cron schedule
// passes `Bearer ${current_setting('app.rotate_daily_token')}`. The function
// compares against the ROTATE_DAILY_TOKEN env var.
//
// For each due campus:
//   1. Generate a fresh random temp.
//   2. Call rotate_today_temp(campus, new_temp) — overwrites system_secrets,
//      prunes >7-day-old rows.
//   3. Update auth.users.encrypted_password for every unclaimed profile in
//      that campus via auth.admin.updateUserById.
//   4. Set attendance_sessions.active = false for all active sessions whose
//      creator is in that campus (auto-deactivation).
//
// Response (for cron observability):
//   {
//     ok: true,
//     rotated: [{ campus, rotation_date, unclaimed_updated, sessions_deactivated }, ...]
//   }

import { jsonResponse, handleOptions } from "../_shared/cors.ts";
import { serviceRoleClient } from "../_shared/auth.ts";
import { generateTempPassword } from "../_shared/password.ts";

interface DueCampus {
  code: string;
  name: string;
  timezone: string;
  local_time: string;
}

interface RotationResult {
  campus: string;
  rotation_date: string;
  unclaimed_updated: number;
  sessions_deactivated: number;
  errors: string[];
}

Deno.serve(async (req: Request) => {
  const optionsResponse = handleOptions(req);
  if (optionsResponse) return optionsResponse;

  if (req.method !== "POST") {
    return jsonResponse(req, { ok: false, error: "Method not allowed." }, 405);
  }

  const expected = Deno.env.get("ROTATE_DAILY_TOKEN");
  if (!expected) {
    return jsonResponse(req, 
      { ok: false, error: "ROTATE_DAILY_TOKEN not configured." },
      500,
    );
  }
  const auth = req.headers.get("Authorization") ?? "";
  if (auth !== `Bearer ${expected}`) {
    return jsonResponse(req, { ok: false, error: "Unauthorized." }, 401);
  }

  const service = serviceRoleClient();

  // 1. Find campuses currently in their rotation hour.
  const { data: dueData, error: dueErr } = await service.rpc(
    "campuses_due_for_rotation",
  );
  if (dueErr) {
    return jsonResponse(req, 
      { ok: false, error: `campuses_due_for_rotation failed: ${dueErr.message}` },
      500,
    );
  }
  const due = (dueData as DueCampus[] | null) ?? [];
  if (due.length === 0) {
    return jsonResponse(req, { ok: true, rotated: [], note: "no campuses due this run" });
  }

  const rotated: RotationResult[] = [];

  for (const campus of due) {
    const result: RotationResult = {
      campus: campus.code,
      rotation_date: "",
      unclaimed_updated: 0,
      sessions_deactivated: 0,
      errors: [],
    };

    // 2. Rotate the system_secrets row.
    const newTemp = generateTempPassword();
    const { data: rotData, error: rotErr } = await service.rpc(
      "rotate_today_temp",
      { p_campus: campus.code, p_new_temp: newTemp },
    );
    if (rotErr || !rotData) {
      result.errors.push(`rotate_today_temp failed: ${rotErr?.message ?? "no data"}`);
      rotated.push(result);
      continue;
    }
    result.rotation_date = (rotData as { rotation_date: string }).rotation_date;

    // 3. Update auth.users for every unclaimed profile in this campus.
    const { data: unclaimed, error: unclaimedErr } = await service
      .from("profiles")
      .select("profile_id")
      .eq("campus", campus.code)
      .is("archived_at", null)
      .is("password_set_at", null);
    if (unclaimedErr) {
      result.errors.push(`profiles lookup failed: ${unclaimedErr.message}`);
    } else {
      for (const row of (unclaimed ?? []) as { profile_id: string }[]) {
        const { error: updErr } = await service.auth.admin.updateUserById(
          row.profile_id,
          { password: newTemp },
        );
        if (updErr) {
          result.errors.push(
            `updateUserById(${row.profile_id}) failed: ${updErr.message}`,
          );
        } else {
          result.unclaimed_updated += 1;
        }
      }
    }

    // 4. Auto-deactivate any active sessions whose creator is in this campus.
    const { data: campusProfiles, error: campusProfilesErr } = await service
      .from("profiles")
      .select("profile_id")
      .eq("campus", campus.code)
      .is("archived_at", null);
    if (campusProfilesErr) {
      result.errors.push(
        `profiles lookup for session deactivation failed: ${campusProfilesErr.message}`,
      );
    } else {
      const profileIds = ((campusProfiles ?? []) as { profile_id: string }[]).map(
        (p) => p.profile_id,
      );
      if (profileIds.length > 0) {
        const { data: deact, error: deactErr } = await service
          .from("attendance_sessions")
          .update({ active: false })
          .eq("active", true)
          .in("creator_profile_id", profileIds)
          .select("id");
        if (deactErr) {
          result.errors.push(`session deactivate failed: ${deactErr.message}`);
        } else {
          result.sessions_deactivated = (deact ?? []).length;
        }
      }
    }

    // Audit log.
    await service.from("audit_events").insert({
      event_type: "daily_rotation",
      actor_campus: campus.code,
      metadata: {
        rotation_date: result.rotation_date,
        unclaimed_updated: result.unclaimed_updated,
        sessions_deactivated: result.sessions_deactivated,
        errors: result.errors,
      },
    });

    rotated.push(result);
  }

  return jsonResponse(req, {
    ok: rotated.every((r) => r.errors.length === 0),
    rotated,
  });
});
