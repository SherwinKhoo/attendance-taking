#!/usr/bin/env bash
# Deploy the v2 Edge Functions to the live Supabase project.
#
# Run from the project root. You'll be prompted to log in if not already.
#
# Prereqs:
#   - You're a member of the Supabase project.
#   - You know the project ref (the slug before .supabase.co in the URL).

set -euo pipefail

PROJECT_REF="${SUPABASE_PROJECT_REF:-icxzgizsbksydltbstdk}"

echo "==> Logging in (if needed). A token paste prompt may open."
if ! npx --yes supabase projects list >/dev/null 2>&1; then
  npx --yes supabase login
fi

echo "==> Linking to project ${PROJECT_REF}"
npx --yes supabase link --project-ref "${PROJECT_REF}"

echo "==> Deploying provision"
npx --yes supabase functions deploy provision

echo "==> Deploying revoke"
npx --yes supabase functions deploy revoke

echo "==> Deploying rotate-daily (JWT verification disabled; this function"
echo "    uses its own shared-secret auth via ROTATE_DAILY_TOKEN)"
npx --yes supabase functions deploy rotate-daily --no-verify-jwt

cat <<'EOF'

Deploy complete. Remaining steps:

1. Set the rotate-daily token (used by pg_cron to authenticate the HTTP call).
   Generate a long random string, then:
       npx supabase secrets set ROTATE_DAILY_TOKEN=<long_random>

2. Store the same value in Vault for pg_cron to read. From the Supabase SQL
   editor or psql:
       select vault.create_secret('<long_random>', 'rotate_daily_token');

3. Activate the cron schedule:
       psql "$DATABASE_URL" -f supabase/cron_schedule.sql
   (after replacing <PROJECT_REF> in the file with your project ref)

4. Smoke-test by calling rotate-daily directly with the token:
       curl -X POST "https://${PROJECT_REF}.supabase.co/functions/v1/rotate-daily" \
            -H "Authorization: Bearer <long_random>"
   It should return { "ok": true, "rotated": [...] } or "no campuses due".
EOF
