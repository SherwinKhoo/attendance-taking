// Shared CORS helpers for Edge Functions.
//
// Origin allowlist is read from the ALLOWED_ORIGINS env var (comma-separated).
// If unset, falls back to "*" (open) so local development isn't blocked. Set
// it to your production origin(s) on Supabase:
//   npx supabase secrets set ALLOWED_ORIGINS=https://your-site.example,http://localhost:8011
//
// The function name is intentionally generic — every Edge Function imports the
// same `corsHeaders` builder per request.

const allowedOriginsEnv = Deno.env.get("ALLOWED_ORIGINS")?.trim() ?? "";
const ALLOWED_ORIGINS = new Set(
  allowedOriginsEnv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

function originFor(req: Request): string {
  const requested = req.headers.get("Origin") ?? "";
  if (ALLOWED_ORIGINS.size === 0) return "*";
  return ALLOWED_ORIGINS.has(requested) ? requested : "";
}

export function corsHeaders(req: Request): Record<string, string> {
  const origin = originFor(req);
  if (!origin) {
    // Disallowed origin — return only Vary so the browser doesn't cache an
    // accidental Allow-Origin from a previous request.
    return { "Vary": "Origin" };
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

export function jsonResponse(
  req: Request,
  body: unknown,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

export function handleOptions(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(req) });
  }
  return null;
}
