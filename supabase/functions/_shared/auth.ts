// Shared auth helpers for Edge Functions.
// Verifies the caller's JWT and returns their profile + admin scope.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.77.0";

export interface CallerProfile {
  profile_id: string;
  pass_id: string | null;
  role: "user" | "representative" | "coordinator" | "admin";
  campus: string | null;
  group_name: string | null;
  sub_group: string | null;
  display_name: string | null;
  admin_campus_scope: string | null;
  needs_password_change: boolean;
  archived_at: string | null;
}

export function serviceRoleClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the function environment.",
    );
  }
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Returns the caller's profile via a user-context client (their JWT), so RLS +
// SECURITY DEFINER assertions apply correctly. Throws if not authenticated.
export async function getCallerProfile(req: Request): Promise<CallerProfile> {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anonKey) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_ANON_KEY must be set in the function environment.",
    );
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new Error("Missing or malformed Authorization header.");
  }

  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await userClient.rpc("get_current_login_profile");
  if (error) {
    throw new Error(`Caller profile lookup failed: ${error.message}`);
  }
  if (!data) {
    throw new Error("No profile linked to this account.");
  }
  return data as CallerProfile;
}

export function assertAdmin(
  caller: CallerProfile,
  targetCampus: string | null,
): void {
  if (caller.role !== "admin") {
    throw new Error("Admin role required.");
  }
  if (
    caller.admin_campus_scope &&
    targetCampus &&
    caller.admin_campus_scope !== targetCampus
  ) {
    throw new Error(
      `Admin scope (${caller.admin_campus_scope}) does not include campus ${targetCampus}.`,
    );
  }
}
