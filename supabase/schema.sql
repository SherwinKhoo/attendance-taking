-- =============================================================================
-- Attendance app — schema (v2: Supabase Auth + multi-campus + notifications)
-- =============================================================================
-- WARNING: This script is destructive. It drops the legacy self-rolled auth
-- tables and functions and recreates the schema for the Supabase Auth model.
-- Apply to a fresh local database first (supabase start), validate end-to-end,
-- then plan a coordinated cutover for the live project.
--
-- Companion artefacts (delivered separately):
--   * supabase/functions/provision/index.ts   — admin batch + single provision
--   * supabase/functions/revoke/index.ts      — admin batch + single revoke
--   * supabase/functions/rotate-daily/index.ts — daily per-campus rotation
--   * pg_cron schedule (see bottom of this file, commented out, requires the
--     rotate-daily function URL and a service-role key in vault).
-- =============================================================================

create extension if not exists pgcrypto;
-- pg_net is enabled by default on Supabase; rely on it for the cron HTTP call.
-- pg_cron is also enabled by default in Supabase Cloud.

-- -----------------------------------------------------------------------------
-- Drop legacy artefacts (self-rolled auth)
-- -----------------------------------------------------------------------------

drop function if exists public.bind_device_login(text, text, text, text, uuid, uuid);
drop function if exists public.ensure_profile(text, text, text, text);
drop function if exists public.assert_active_device_login(text, uuid, uuid);
drop function if exists public.assert_active_login(text, uuid, uuid);
drop function if exists public.login_response(public.device_logins);
drop function if exists public.register_pass_login(text, text, text, uuid);
drop function if exists public.register_pass_login(text, text, uuid);
drop function if exists public.login_with_password(text, text, uuid);
drop function if exists public.logout_session(text, uuid, uuid);
drop function if exists public.get_current_login_profile(text, uuid, uuid);
drop function if exists public.create_attendance_session(text, text, timestamptz, integer, double precision, double precision, text, uuid, uuid);
drop function if exists public.create_attendance_session(text, text, timestamptz, integer, double precision, double precision, uuid);
drop function if exists public.create_attendance_session(text, text, timestamptz, integer, double precision, double precision, uuid, boolean, boolean);
drop function if exists public.get_latest_active_session_qr_for_creator(text, uuid, uuid);
drop function if exists public.get_latest_active_session_qr_for_creator(uuid);
drop function if exists public.list_manageable_sessions(integer);
drop function if exists public.submit_attendance(jsonb, text, uuid, uuid, double precision, double precision);
drop function if exists public.list_open_geofence_sessions();
drop function if exists public.submit_geofence_attendance(uuid, uuid, double precision, double precision);
drop function if exists public.view_session_attendance(uuid, text, uuid, uuid);
drop function if exists public.export_canonical_attendance_csv(uuid, text, uuid, uuid);
drop function if exists public.cleanup_orphaned_synthetic_auth_users();
drop function if exists public.revoke_user_refresh_tokens(uuid);

drop table if exists public.notifications cascade;
drop table if exists public.system_secrets cascade;
drop table if exists public.attendance_attempts cascade;
drop table if exists public.attendance_sessions cascade;
drop table if exists public.audit_events cascade;
drop table if exists public.device_logins cascade;
drop table if exists public.profiles cascade;
drop table if exists public.campuses cascade;

-- -----------------------------------------------------------------------------
-- New tables
-- -----------------------------------------------------------------------------

create table public.campuses (
  code text primary key,
  name text not null,
  timezone text not null,
  -- Optional per-campus geofence used by the campus-grounds (no-QR) check-in
  -- mode. All three columns must be set for the mode to be available; sessions
  -- attempting to enable allow_geofence on a campus without these are rejected.
  center_lat double precision,
  center_lon double precision,
  radius_metres integer check (radius_metres is null or radius_metres > 0),
  created_at timestamptz not null default now(),
  -- Campus codes are embedded into synthetic auth emails as the domain
  -- (`{pass_id}@{campus}.local`), so they must be RFC 1035 host-label safe:
  -- ASCII alphanumerics + hyphen, no underscores, no leading/trailing hyphen,
  -- <=63 chars.
  constraint campuses_code_hostname_safe
    check (code ~ '^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$')
);

create table public.profiles (
  -- profile_id matches auth.users.id; populated by the provision Edge Function
  -- after auth.admin.createUser. RLS keys off auth.uid() = profile_id.
  profile_id uuid primary key references auth.users(id) on delete cascade,
  pass_id text,
  role text not null default 'user'
    check (role in ('user', 'representative', 'coordinator', 'admin')),
  campus text not null references public.campuses(code) on update cascade,
  group_name text not null,
  sub_group text not null,
  display_name text,
  -- For admin role: NULL = global scope (developer); set = restricted to one campus.
  admin_campus_scope text references public.campuses(code) on update cascade,
  -- NULL while user is on the daily temp; populated when user changes password.
  password_set_at timestamptz,
  -- Set on revoke; pass_id cleared at the same time so the string can be reused
  -- by a fresh profile in a future batch.
  archived_at timestamptz,
  created_at timestamptz not null default now()
);

-- Active pass_ids must be unique per campus; the same string may exist in
-- different campuses simultaneously. Archived rows are excluded so a string
-- can recur within a campus after revoke.
create unique index profiles_campus_pass_id_active_unique
  on public.profiles(campus, pass_id)
  where archived_at is null and pass_id is not null;

create index profiles_campus_idx on public.profiles(campus) where archived_at is null;
create index profiles_unclaimed_idx on public.profiles(campus, password_set_at)
  where archived_at is null and password_set_at is null;

-- Plaintext daily temps written by the rotation Edge Function. Read only via
-- get_current_batch_temp_password(). Pruned to last 7 days by the rotation job.
create table public.system_secrets (
  id uuid primary key default gen_random_uuid(),
  campus text not null references public.campuses(code) on update cascade on delete cascade,
  rotation_date date not null,
  temp_password text not null,
  created_at timestamptz not null default now(),
  unique (campus, rotation_date)
);

create table public.attendance_sessions (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  name text not null,
  intended_start_at timestamptz not null,
  grace_period_minutes integer not null default 0 check (grace_period_minutes >= 0),
  creator_lat double precision not null,
  creator_lon double precision not null,
  -- SET NULL so revoke / profile delete leaves the session row intact.
  -- creator_pass_id / creator_campus snapshot the creator's identifying
  -- strings at insert time for forensic lookups after the FK is nulled.
  creator_profile_id uuid references public.profiles(profile_id) on delete set null,
  creator_pass_id text,
  creator_campus text,
  creator_device_install_id uuid not null,
  active boolean not null default true,
  -- Check-in modes. At least one must be enabled (CHECK below). QR is the
  -- default; campus-grounds is opt-in by the creator and requires the
  -- creator's campus to have a configured geofence.
  allow_qr boolean not null default true,
  allow_geofence boolean not null default false,
  -- Visibility scope. The lowest grouping specified at creation time controls
  -- who sees the session in lists like list_open_geofence_sessions. NULL at any
  -- level means "all" for that level. The prefix CHECK enforces a valid
  -- hierarchy: sub_group implies group_name implies campus. scope_campus may
  -- only be NULL for global-admin-created cross-campus sessions and is then
  -- incompatible with allow_geofence (no single geofence to apply).
  scope_campus text references public.campuses(code) on update cascade,
  scope_group_name text,
  scope_sub_group text,
  created_at timestamptz not null default now(),
  constraint attendance_sessions_at_least_one_mode check (allow_qr or allow_geofence),
  constraint attendance_sessions_scope_prefix check (
    (scope_sub_group is null or scope_group_name is not null)
    and (scope_group_name is null or scope_campus is not null)
  ),
  constraint attendance_sessions_geofence_requires_campus check (
    not allow_geofence or scope_campus is not null
  )
);

create unique index attendance_sessions_code_unique_idx
  on public.attendance_sessions(code);
create index attendance_sessions_creator_active_idx
  on public.attendance_sessions(creator_profile_id, active, created_at desc);
create index attendance_sessions_scope_idx
  on public.attendance_sessions(active, scope_campus, scope_group_name, scope_sub_group);

create table public.attendance_attempts (
  id uuid primary key default gen_random_uuid(),
  -- ON DELETE CASCADE: an attendance attempt is meaningless without its
  -- parent session, and the row already snapshots session_code / session_name /
  -- submitter_pass_id / submitter_campus / scanned_session_payload for forensic
  -- lookups via audit_events (whose session_id has no FK and survives).
  session_id uuid not null references public.attendance_sessions(id) on delete cascade,
  session_code text not null,
  session_name text not null,
  scanned_session_payload jsonb not null,
  -- SET NULL on profile delete; submitter_pass_id / submitter_campus
  -- snapshot the submitter's identifying strings so report RPCs and CSV
  -- exports still resolve a pass ID after the user is revoked.
  profile_id uuid references public.profiles(profile_id) on delete set null,
  submitter_pass_id text,
  submitter_campus text,
  device_install_id uuid not null,
  submitted_at timestamptz not null default now(),
  submitter_lat double precision not null,
  submitter_lon double precision not null,
  status text not null default 'accepted'
    check (status in ('accepted', 'flagged', 'rejected')),
  flags text[] not null default '{}',
  canonical boolean not null default false,
  distance_from_session_m double precision
);

create index attendance_attempts_session_profile_idx
  on public.attendance_attempts(session_id, profile_id, submitted_at);
create index attendance_attempts_device_idx
  on public.attendance_attempts(device_install_id);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  -- SET NULL on profile delete so the audit row survives revoke / manual
  -- profile-delete: the metadata jsonb still carries the relevant ids and
  -- pass_id strings for forensic lookups. Without this, the FK blocks the
  -- auth.users → profiles cascade chain on revoke.
  actor_profile_id uuid references public.profiles(profile_id) on delete set null,
  actor_campus text references public.campuses(code) on update cascade,
  device_install_id uuid,
  session_id uuid,
  attendance_attempt_id uuid,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index audit_events_actor_idx on public.audit_events(actor_profile_id, created_at desc);
create index audit_events_campus_idx on public.audit_events(actor_campus, created_at desc);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  target_campus text references public.campuses(code) on update cascade,
  target_group_name text,
  target_sub_group text,
  target_profile_id uuid references public.profiles(profile_id) on delete cascade,
  title text not null,
  body text not null,
  link_url text,
  pinned boolean not null default false,
  created_by uuid references public.profiles(profile_id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz
);

create index notifications_recent_idx on public.notifications(created_at desc);

-- At most one pinned notification per (campus, group_name, sub_group, profile_id)
-- scope. NULLS NOT DISTINCT means NULL columns count as equal in the uniqueness
-- check (Postgres 15+). post_notification() also auto-unpins prior pin at the
-- same scope so this index is a backstop, not the primary mechanism.
create unique index notifications_pinned_unique
  on public.notifications(target_campus, target_group_name, target_sub_group, target_profile_id)
  nulls not distinct
  where pinned;

-- -----------------------------------------------------------------------------
-- Helper: small immutable / pure utilities (reused from v1)
-- -----------------------------------------------------------------------------

create or replace function public.distance_metres(
  lat1 double precision, lon1 double precision,
  lat2 double precision, lon2 double precision
) returns double precision
language sql immutable
set search_path = public, pg_temp
as $$
  select 6371000 * 2 * asin(
    sqrt(
      power(sin(radians((lat2 - lat1) / 2)), 2) +
      cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians((lon2 - lon1) / 2)), 2)
    )
  );
$$;

create or replace function public.csv_cell(value text)
returns text
language sql immutable
set search_path = public, pg_temp
as $$
  select '"' || replace(
    case
      when coalesce(value, '') ~ ('^[=+\-@' || chr(9) || chr(13) || ']')
        then '''' || coalesce(value, '')
      else coalesce(value, '')
    end,
    '"',
    '""'
  ) || '"';
$$;

create or replace function public.assert_password_policy(p_password text)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if p_password is null
    or p_password !~ '^[A-Za-z0-9!@#$%^&*._-]{10,16}$'
    or p_password !~ '[A-Z]'
    or p_password !~ '[a-z]'
    or p_password !~ '[0-9]'
    or p_password !~ '[!@#$%^&*._-]' then
    raise exception 'Password must be 10-16 characters with uppercase, lowercase, a number, and one approved symbol.';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Helper: identity resolution (replaces assert_active_login)
-- -----------------------------------------------------------------------------

-- Returns the active profile row for the calling JWT. Raises if no profile,
-- archived, or password not yet set (forces user through the change-password
-- modal before any sensitive action). Caller decides whether to allow
-- "password not set" by passing p_allow_unclaimed.
create or replace function public.assert_authenticated(p_allow_unclaimed boolean default false)
returns public.profiles
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles;
begin
  if auth.uid() is null then
    raise exception 'Authentication required.';
  end if;

  select * into v_profile
  from public.profiles
  where profile_id = auth.uid();

  if v_profile.profile_id is null then
    raise exception 'No profile linked to this account.';
  end if;

  if v_profile.archived_at is not null then
    raise exception 'This account has been archived.';
  end if;

  if not p_allow_unclaimed and v_profile.password_set_at is null then
    raise exception 'Password change required before continuing.';
  end if;

  return v_profile;
end;
$$;

-- Verifies caller is an admin authorised to act on a given target campus.
-- NULL admin_campus_scope = global. NULL p_target_campus = "any" (e.g., for
-- listing all campuses an admin can touch).
create or replace function public.assert_admin_scope(p_target_campus text default null)
returns public.profiles
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_admin public.profiles;
begin
  v_admin := public.assert_authenticated(p_allow_unclaimed => false);

  if v_admin.role <> 'admin' then
    raise exception 'Admin role required.';
  end if;

  if v_admin.admin_campus_scope is not null
     and p_target_campus is not null
     and v_admin.admin_campus_scope <> p_target_campus then
    raise exception 'Admin scope does not include this campus.';
  end if;

  return v_admin;
end;
$$;

-- -----------------------------------------------------------------------------
-- RPC: profile / lifecycle
-- -----------------------------------------------------------------------------

-- Returns the calling user's profile and a flag indicating whether the
-- forced-change modal should be shown. Allows unclaimed callers (since the
-- client needs the flag to decide whether to render the modal).
create or replace function public.get_current_login_profile(
  p_device_install_id uuid default null
)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles;
begin
  v_profile := public.assert_authenticated(p_allow_unclaimed => true);

  return jsonb_build_object(
    'profile_id', v_profile.profile_id,
    'pass_id', v_profile.pass_id,
    'role', v_profile.role,
    'campus', v_profile.campus,
    'group_name', v_profile.group_name,
    'sub_group', v_profile.sub_group,
    'display_name', v_profile.display_name,
    'admin_campus_scope', v_profile.admin_campus_scope,
    'needs_password_change', v_profile.password_set_at is null,
    'archived_at', v_profile.archived_at
  );
end;
$$;

-- Called by the client after a successful supabase.auth.updateUser({ password })
-- to mark the profile as claimed. Server-side strength check is enforced before
-- the client calls updateUser; this RPC just records the event.
create or replace function public.mark_password_set()
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles;
  v_first_time boolean;
begin
  v_profile := public.assert_authenticated(p_allow_unclaimed => true);
  v_first_time := v_profile.password_set_at is null;

  update public.profiles
  set password_set_at = now()
  where profile_id = v_profile.profile_id
    and password_set_at is null;

  insert into public.audit_events(event_type, actor_profile_id, actor_campus, metadata)
  values (
    case when v_first_time then 'mark_password_set' else 'password_changed' end,
    v_profile.profile_id, v_profile.campus,
    jsonb_build_object('first_time', v_first_time)
  );

  return jsonb_build_object('ok', true, 'first_time', v_first_time);
end;
$$;

-- Validate a candidate password against the strength policy. Used by the client
-- before calling supabase.auth.updateUser({ password }).
create or replace function public.validate_password(p_password text)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  perform public.assert_password_policy(p_password);
  return jsonb_build_object('ok', true);
exception when others then
  return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;

-- -----------------------------------------------------------------------------
-- RPC: attendance sessions
-- -----------------------------------------------------------------------------

create or replace function public.create_attendance_session(
  p_code text,
  p_name text,
  p_intended_start_at timestamptz,
  p_grace_period_minutes integer,
  p_creator_lat double precision,
  p_creator_lon double precision,
  p_device_install_id uuid,
  p_allow_qr boolean default true,
  p_allow_geofence boolean default false,
  p_scope_campus text default null,
  p_scope_group_name text default null,
  p_scope_sub_group text default null
)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_caller public.profiles;
  v_session public.attendance_sessions;
  v_campus public.campuses;
  v_is_global_admin boolean;
  v_scope_campus text;
  v_scope_group text;
  v_scope_sub text;
begin
  v_caller := public.assert_authenticated();

  if v_caller.role not in ('representative', 'coordinator', 'admin') then
    raise exception 'Only Representatives, Coordinators, and Admins can create sessions.';
  end if;

  if p_code is null or length(trim(p_code)) > 128 or trim(p_code) = '' then
    raise exception 'Session code is invalid.';
  end if;

  if p_name is null or length(trim(p_name)) > 120 or trim(p_name) = '' then
    raise exception 'Session name must be 1-120 characters.';
  end if;

  if not (p_allow_qr or p_allow_geofence) then
    raise exception 'At least one check-in mode (QR scan or campus grounds) must be enabled.';
  end if;

  v_is_global_admin := (v_caller.role = 'admin' and v_caller.admin_campus_scope is null);

  -- Normalise empty strings to NULL so the client can send blanks freely.
  v_scope_campus := nullif(trim(coalesce(p_scope_campus, '')), '');
  v_scope_group := nullif(trim(coalesce(p_scope_group_name, '')), '');
  v_scope_sub := nullif(trim(coalesce(p_scope_sub_group, '')), '');

  -- Default: scope to the creator's own (campus, group, sub_group) tuple, which
  -- preserves the pre-scope-columns behaviour for callers that don't pass any.
  if v_scope_campus is null and v_scope_group is null and v_scope_sub is null then
    v_scope_campus := v_caller.campus;
    v_scope_group := v_caller.group_name;
    v_scope_sub := v_caller.sub_group;
  end if;

  -- Prefix rule: sub_group implies group_name implies campus.
  if v_scope_sub is not null and v_scope_group is null then
    raise exception 'Sub-group scope requires a group scope.';
  end if;
  if v_scope_group is not null and v_scope_campus is null then
    raise exception 'Group scope requires a campus scope.';
  end if;

  -- Safeguards:
  --   * Global admin (role=admin, admin_campus_scope IS NULL): no restriction;
  --     may scope to any campus or to NULL (cross-campus).
  --   * Per-campus admin (role=admin, admin_campus_scope set) AND coordinator:
  --     campus pinned (admin_campus_scope or own campus respectively); group
  --     and sub-group may be any value within that campus, or blank.
  --   * Representative: pinned to their full (campus, group, sub_group) tuple
  --     when those scope levels are set.
  if not v_is_global_admin then
    if v_scope_campus is null then
      raise exception 'Only global admins may create cross-campus sessions.';
    end if;
    if v_caller.role = 'admin' then
      if v_scope_campus <> v_caller.admin_campus_scope then
        raise exception 'Admin scope does not include campus %.', v_scope_campus;
      end if;
    elsif v_caller.role = 'coordinator' then
      if v_scope_campus <> v_caller.campus then
        raise exception 'You can only create sessions within your own campus.';
      end if;
    else
      -- Representative: pinned to their full tuple.
      if v_scope_campus <> v_caller.campus then
        raise exception 'You can only create sessions within your own campus.';
      end if;
      if v_scope_group is not null and v_scope_group <> v_caller.group_name then
        raise exception 'You can only create sessions within your own group.';
      end if;
      if v_scope_sub is not null and v_scope_sub <> v_caller.sub_group then
        raise exception 'You can only create sessions within your own sub-group.';
      end if;
    end if;
  end if;

  -- Geofence mode requires the scope campus to have a configured geofence;
  -- cross-campus (scope_campus IS NULL) is incompatible with geofence mode
  -- because there is no single geofence to apply.
  if p_allow_geofence then
    if v_scope_campus is null then
      raise exception 'Cross-campus sessions cannot use campus-grounds mode.';
    end if;
    select * into v_campus from public.campuses where code = v_scope_campus;
    if v_campus.center_lat is null
       or v_campus.center_lon is null
       or v_campus.radius_metres is null then
      raise exception 'Campus % has no geofence configured; campus-grounds mode unavailable.',
        v_scope_campus;
    end if;
  end if;

  insert into public.attendance_sessions(
    code, name, intended_start_at, grace_period_minutes,
    creator_lat, creator_lon, creator_profile_id, creator_pass_id, creator_campus,
    creator_device_install_id, allow_qr, allow_geofence,
    scope_campus, scope_group_name, scope_sub_group
  )
  values (
    upper(trim(p_code)), trim(p_name), p_intended_start_at, p_grace_period_minutes,
    p_creator_lat, p_creator_lon, v_caller.profile_id, v_caller.pass_id, v_caller.campus,
    p_device_install_id, p_allow_qr, p_allow_geofence,
    v_scope_campus, v_scope_group, v_scope_sub
  )
  returning * into v_session;

  insert into public.audit_events(event_type, actor_profile_id, actor_campus, device_install_id, session_id)
  values ('create_attendance_session', v_caller.profile_id, v_caller.campus, p_device_install_id, v_session.id);

  return jsonb_build_object(
    'version', 1,
    'session_id', v_session.id,
    'session_code', v_session.code,
    'session_name', v_session.name,
    'intended_start_at', v_session.intended_start_at,
    'grace_period_minutes', v_session.grace_period_minutes,
    'creator_lat', v_session.creator_lat,
    'creator_lon', v_session.creator_lon,
    'creator_profile_id', v_session.creator_profile_id,
    'allow_qr', v_session.allow_qr,
    'allow_geofence', v_session.allow_geofence,
    'scope_campus', v_session.scope_campus,
    'scope_group_name', v_session.scope_group_name,
    'scope_sub_group', v_session.scope_sub_group,
    'created_at', v_session.created_at
  );
end;
$$;

-- Role-scoped list of active sessions the caller may "open" (resume / re-display
-- QR / view roster / export). Replaces the creator-only get_latest_* RPC with a
-- picker model:
--   * Global admin (role=admin, admin_campus_scope IS NULL): every active
--     session.
--   * Per-campus admin: active sessions whose scope_campus matches their
--     admin_campus_scope, plus global-admin-authored cross-campus sessions
--     (scope_campus IS NULL).
--   * Coordinator: same predicate but using their own campus.
--   * Representative: only sessions whose scope includes the rep's own tuple —
--     same scope predicate as list_open_geofence_sessions (without the
--     allow_geofence requirement).
create or replace function public.list_manageable_sessions(
  p_limit integer default 50
)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_caller public.profiles;
  v_is_global_admin boolean;
begin
  v_caller := public.assert_authenticated();

  if v_caller.role not in ('representative', 'coordinator', 'admin') then
    raise exception 'Only Representatives, Coordinators, and Admins can list manageable sessions.';
  end if;

  if p_limit is null or p_limit < 1 then
    p_limit := 50;
  elsif p_limit > 500 then
    p_limit := 500;
  end if;

  v_is_global_admin := (v_caller.role = 'admin' and v_caller.admin_campus_scope is null);

  return coalesce((
    select jsonb_agg(row_payload order by created_at desc)
    from (
      select
        s.created_at,
        jsonb_build_object(
          'version', 1,
          'session_id', s.id,
          'session_code', s.code,
          'session_name', s.name,
          'intended_start_at', s.intended_start_at,
          'grace_period_minutes', s.grace_period_minutes,
          'creator_lat', s.creator_lat,
          'creator_lon', s.creator_lon,
          'creator_profile_id', s.creator_profile_id,
          'creator_pass_id', s.creator_pass_id,
          'allow_qr', s.allow_qr,
          'allow_geofence', s.allow_geofence,
          'scope_campus', s.scope_campus,
          'scope_group_name', s.scope_group_name,
          'scope_sub_group', s.scope_sub_group,
          'active', s.active,
          'created_at', s.created_at
        ) as row_payload
      from public.attendance_sessions s
      where s.active
        and (
          v_is_global_admin
          or (v_caller.role = 'admin'
              and (s.scope_campus = v_caller.admin_campus_scope or s.scope_campus is null))
          or (v_caller.role = 'coordinator'
              and (s.scope_campus = v_caller.campus or s.scope_campus is null))
          or (v_caller.role = 'representative'
              and (s.scope_campus is null or s.scope_campus = v_caller.campus)
              and (s.scope_group_name is null or s.scope_group_name = v_caller.group_name)
              and (s.scope_sub_group is null or s.scope_sub_group = v_caller.sub_group))
        )
      order by s.created_at desc
      limit p_limit
    ) ordered
  ), '[]'::jsonb);
end;
$$;

create or replace function public.submit_attendance(
  p_session_payload jsonb,
  p_device_install_id uuid,
  p_submitter_lat double precision,
  p_submitter_lon double precision
)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_caller public.profiles;
  v_session public.attendance_sessions;
  v_flags text[] := '{}';
  v_distance double precision;
  v_canonical boolean := false;
  v_attempt public.attendance_attempts;
begin
  v_caller := public.assert_authenticated();

  select * into v_session
  from public.attendance_sessions
  where id = nullif(p_session_payload->>'session_id', '')::uuid
    and code = p_session_payload->>'session_code'
    and active
  limit 1;

  if v_session.id is null then
    raise exception 'Session was not found.';
  end if;

  v_distance := public.distance_metres(
    v_session.creator_lat, v_session.creator_lon,
    p_submitter_lat, p_submitter_lon
  );

  if v_distance > 50 then
    v_flags := array_append(v_flags, 'OUTSIDE_LOCATION_MARGIN');
  end if;

  if v_session.grace_period_minutes > 0
     and now() > v_session.intended_start_at + make_interval(mins => v_session.grace_period_minutes) then
    v_flags := array_append(v_flags, 'LATE_AFTER_GRACE_PERIOD');
  end if;

  -- Single device-reuse signal now (the prior duplicate was an audit regression).
  -- "This device has submitted attendance under another profile before."
  if exists (
    select 1 from public.attendance_attempts
    where device_install_id = p_device_install_id
      and profile_id <> v_caller.profile_id
  ) then
    v_flags := array_append(v_flags, 'DEVICE_USED_FOR_MULTIPLE_PROFILES');
  end if;

  if exists (
    select 1 from public.attendance_attempts
    where session_id = v_session.id
      and profile_id = v_caller.profile_id
  ) then
    v_flags := array_append(v_flags, 'DUPLICATE_ATTEMPT');
  else
    v_canonical := true;
  end if;

  insert into public.attendance_attempts(
    session_id, session_code, session_name, scanned_session_payload,
    profile_id, submitter_pass_id, submitter_campus,
    device_install_id, submitter_lat, submitter_lon,
    status, flags, canonical, distance_from_session_m
  )
  values (
    v_session.id, v_session.code, v_session.name, p_session_payload,
    v_caller.profile_id, v_caller.pass_id, v_caller.campus,
    p_device_install_id, p_submitter_lat, p_submitter_lon,
    case when cardinality(v_flags) > 0 then 'flagged' else 'accepted' end,
    v_flags, v_canonical, v_distance
  )
  returning * into v_attempt;

  insert into public.audit_events(
    event_type, actor_profile_id, actor_campus, device_install_id,
    session_id, attendance_attempt_id, metadata
  )
  values (
    'submit_attendance', v_caller.profile_id, v_caller.campus, p_device_install_id,
    v_session.id, v_attempt.id, jsonb_build_object('flags', v_flags)
  );

  return to_jsonb(v_attempt);
end;
$$;

-- List active campus-grounds sessions for the caller's exact
-- campus + group + sub-group bundle. Used by the "Check in" zone refresh.
create or replace function public.list_open_geofence_sessions()
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_caller public.profiles;
begin
  v_caller := public.assert_authenticated();

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'session_id', s.id,
      'session_code', s.code,
      'session_name', s.name,
      'intended_start_at', s.intended_start_at,
      'grace_period_minutes', s.grace_period_minutes,
      'creator_pass_id', s.creator_pass_id,
      'created_at', s.created_at
    ) order by s.created_at desc)
    from public.attendance_sessions s
    where s.active
      and s.allow_geofence
      and (s.scope_campus is null or s.scope_campus = v_caller.campus)
      and (s.scope_group_name is null or s.scope_group_name = v_caller.group_name)
      and (s.scope_sub_group is null or s.scope_sub_group = v_caller.sub_group)
  ), '[]'::jsonb);
end;
$$;

-- Submit attendance via the campus-grounds path. Hard-rejects when the
-- submitter is outside the campus geofence (unlike submit_attendance which
-- soft-flags OUTSIDE_LOCATION_MARGIN for QR's 50 m proximity check).
create or replace function public.submit_geofence_attendance(
  p_session_id uuid,
  p_device_install_id uuid,
  p_submitter_lat double precision,
  p_submitter_lon double precision
)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_caller public.profiles;
  v_session public.attendance_sessions;
  v_campus public.campuses;
  v_distance double precision;
  v_flags text[] := '{}';
  v_canonical boolean := false;
  v_attempt public.attendance_attempts;
  v_payload jsonb;
begin
  v_caller := public.assert_authenticated();

  if p_session_id is null then
    raise exception 'Session id is required.';
  end if;

  select * into v_session from public.attendance_sessions where id = p_session_id;
  if v_session.id is null then
    raise exception 'Session was not found.';
  end if;
  if not v_session.active then
    raise exception 'Session is no longer active.';
  end if;
  if not v_session.allow_geofence then
    raise exception 'This session does not allow campus-grounds check-in.';
  end if;

  -- Scope gate: caller must fall within the session's configured scope. The
  -- attendance_sessions_geofence_requires_campus CHECK guarantees scope_campus
  -- is non-null on geofence sessions, so the campus comparison always runs.
  if v_session.scope_campus is distinct from v_caller.campus then
    raise exception 'You are not in the target campus for this session.';
  end if;
  if v_session.scope_group_name is not null
     and v_session.scope_group_name <> v_caller.group_name then
    raise exception 'You are not in the target group for this session.';
  end if;
  if v_session.scope_sub_group is not null
     and v_session.scope_sub_group <> v_caller.sub_group then
    raise exception 'You are not in the target sub-group for this session.';
  end if;

  select * into v_campus from public.campuses where code = v_session.scope_campus;
  if v_campus.center_lat is null
     or v_campus.center_lon is null
     or v_campus.radius_metres is null then
    raise exception 'Campus % has no geofence configured.', v_session.scope_campus;
  end if;

  v_distance := public.distance_metres(
    v_campus.center_lat, v_campus.center_lon,
    p_submitter_lat, p_submitter_lon
  );

  if v_distance > v_campus.radius_metres then
    raise exception 'You are outside the campus grounds (% m from centre, limit % m).',
      round(v_distance)::int, v_campus.radius_metres;
  end if;

  if v_session.grace_period_minutes > 0
     and now() > v_session.intended_start_at + make_interval(mins => v_session.grace_period_minutes) then
    v_flags := array_append(v_flags, 'LATE_AFTER_GRACE_PERIOD');
  end if;

  if exists (
    select 1 from public.attendance_attempts
    where device_install_id = p_device_install_id
      and profile_id <> v_caller.profile_id
  ) then
    v_flags := array_append(v_flags, 'DEVICE_USED_FOR_MULTIPLE_PROFILES');
  end if;

  if exists (
    select 1 from public.attendance_attempts
    where session_id = v_session.id
      and profile_id = v_caller.profile_id
  ) then
    v_flags := array_append(v_flags, 'DUPLICATE_ATTEMPT');
  else
    v_canonical := true;
  end if;

  v_payload := jsonb_build_object(
    'mode', 'geofence',
    'session_id', v_session.id,
    'session_code', v_session.code
  );

  insert into public.attendance_attempts(
    session_id, session_code, session_name, scanned_session_payload,
    profile_id, submitter_pass_id, submitter_campus,
    device_install_id, submitter_lat, submitter_lon,
    status, flags, canonical, distance_from_session_m
  )
  values (
    v_session.id, v_session.code, v_session.name, v_payload,
    v_caller.profile_id, v_caller.pass_id, v_caller.campus,
    p_device_install_id, p_submitter_lat, p_submitter_lon,
    case when cardinality(v_flags) > 0 then 'flagged' else 'accepted' end,
    v_flags, v_canonical, v_distance
  )
  returning * into v_attempt;

  insert into public.audit_events(
    event_type, actor_profile_id, actor_campus, device_install_id,
    session_id, attendance_attempt_id, metadata
  )
  values (
    'submit_geofence_attendance', v_caller.profile_id, v_caller.campus, p_device_install_id,
    v_session.id, v_attempt.id, jsonb_build_object('flags', v_flags, 'distance_m', v_distance)
  );

  return to_jsonb(v_attempt);
end;
$$;

create or replace function public.view_session_attendance(p_session_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_caller public.profiles;
begin
  v_caller := public.assert_authenticated();

  if v_caller.role not in ('representative', 'coordinator', 'admin') then
    raise exception 'Only Representatives, Coordinators, and Admins can view session attendance.';
  end if;

  if v_caller.role = 'representative'
     and not exists (
       select 1 from public.attendance_sessions
       where id = p_session_id
         and creator_profile_id = v_caller.profile_id
     ) then
    raise exception 'Representatives can only view attendance for sessions they created.';
  end if;

  insert into public.audit_events(event_type, actor_profile_id, actor_campus, session_id)
  values ('view_session_attendance', v_caller.profile_id, v_caller.campus, p_session_id);

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'pass_id', coalesce(p.pass_id, a.submitter_pass_id),
      'submitted_at', a.submitted_at,
      'status', a.status,
      'flags', a.flags,
      'canonical', a.canonical,
      'attempt_count', (
        select count(*) from public.attendance_attempts attempts
        where attempts.session_id = a.session_id
          and attempts.submitter_pass_id = a.submitter_pass_id
      )
    ) order by a.submitted_at)
    from public.attendance_attempts a
    left join public.profiles p on p.profile_id = a.profile_id
    where a.session_id = p_session_id
  ), '[]'::jsonb);
end;
$$;

create or replace function public.export_canonical_attendance_csv(p_session_id uuid)
returns text
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_caller public.profiles;
  v_csv text;
begin
  v_caller := public.assert_authenticated();

  if v_caller.role not in ('coordinator', 'admin') then
    raise exception 'Only Coordinators and Admins can export canonical CSV.';
  end if;

  insert into public.audit_events(event_type, actor_profile_id, actor_campus, session_id)
  values ('export_canonical_attendance_csv', v_caller.profile_id, v_caller.campus, p_session_id);

  select string_agg(line, E'\n' order by sort_order)
  into v_csv
  from (
    select 0 as sort_order,
      'session code,session name,pass ID,canonical submitted timestamp,attempt count,flag count,flags,device install ID,submitter coordinates,late flag status,distance from session QR location' as line
    union all
    select 1,
      concat_ws(',',
        public.csv_cell(a.session_code),
        public.csv_cell(a.session_name),
        public.csv_cell(coalesce(p.pass_id, a.submitter_pass_id)),
        public.csv_cell(a.submitted_at::text),
        (
          select count(*)::text from public.attendance_attempts attempts
          where attempts.session_id = a.session_id
            and attempts.submitter_pass_id = a.submitter_pass_id
        ),
        cardinality(a.flags)::text,
        public.csv_cell(array_to_string(a.flags, '|')),
        public.csv_cell(a.device_install_id::text),
        public.csv_cell(a.submitter_lat::text || ',' || a.submitter_lon::text),
        (array_position(a.flags, 'LATE_AFTER_GRACE_PERIOD') is not null)::text,
        coalesce(round(a.distance_from_session_m::numeric, 2)::text, '')
      )
    from public.attendance_attempts a
    left join public.profiles p on p.profile_id = a.profile_id
    where a.session_id = p_session_id
      and a.canonical
  ) rows;

  return coalesce(v_csv,
    'session code,session name,pass ID,canonical submitted timestamp,attempt count,flag count,flags,device install ID,submitter coordinates,late flag status,distance from session QR location');
end;
$$;

-- -----------------------------------------------------------------------------
-- Helper: read-or-create today's per-campus temp password
-- -----------------------------------------------------------------------------
-- Used by the provision and rotate-daily Edge Functions. Computes "today" in
-- the campus's local timezone, then atomically inserts the candidate temp if
-- no row exists for that (campus, date), or returns the existing one. Caller
-- supplies a pre-generated candidate so this function stays pure SQL.
create or replace function public.ensure_today_temp(
  p_campus text,
  p_candidate_temp text
)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_timezone text;
  v_today date;
  v_secret public.system_secrets;
begin
  select timezone into v_timezone from public.campuses where code = p_campus;
  if v_timezone is null then
    raise exception 'Unknown campus %', p_campus;
  end if;

  v_today := (now() at time zone v_timezone)::date;

  insert into public.system_secrets(campus, rotation_date, temp_password)
  values (p_campus, v_today, p_candidate_temp)
  on conflict (campus, rotation_date) do nothing
  returning * into v_secret;

  if v_secret.id is null then
    select * into v_secret
    from public.system_secrets
    where campus = p_campus and rotation_date = v_today;
  end if;

  return jsonb_build_object(
    'campus', v_secret.campus,
    'rotation_date', v_secret.rotation_date,
    'temp_password', v_secret.temp_password,
    'created_now', v_secret.temp_password = p_candidate_temp
  );
end;
$$;

-- Force-rotate today's per-campus temp. Used by the daily rotation cron at
-- local midnight: generates a fresh row regardless of what existed.
create or replace function public.rotate_today_temp(
  p_campus text,
  p_new_temp text
)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_timezone text;
  v_today date;
  v_secret public.system_secrets;
begin
  select timezone into v_timezone from public.campuses where code = p_campus;
  if v_timezone is null then
    raise exception 'Unknown campus %', p_campus;
  end if;

  v_today := (now() at time zone v_timezone)::date;

  insert into public.system_secrets(campus, rotation_date, temp_password)
  values (p_campus, v_today, p_new_temp)
  on conflict (campus, rotation_date) do update
  set temp_password = excluded.temp_password,
      created_at = now()
  returning * into v_secret;

  -- Prune anything older than 7 days, across ALL campuses (not just the one
  -- being rotated). Belt-and-braces against a campus that stops rotating
  -- without being removed; the universal time cutoff is "yesterday's UTC date
  -- minus 7", which is conservative enough to keep any campus's last week of
  -- temps regardless of timezone.
  delete from public.system_secrets
  where rotation_date < ((now() at time zone 'UTC')::date - interval '7 days');

  return jsonb_build_object(
    'campus', v_secret.campus,
    'rotation_date', v_secret.rotation_date,
    'temp_password', v_secret.temp_password
  );
end;
$$;

-- Anon-readable list of campuses for the sign-in screen's campus picker.
-- Returns only (code, name) so anonymous callers cannot enumerate geofence
-- coordinates or rotation timezones. RLS on public.campuses restricts SELECT
-- to authenticated users; this SECURITY DEFINER RPC carves out the minimal
-- public projection needed before sign-in.
create or replace function public.list_public_campuses()
returns jsonb
language sql security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(
    jsonb_build_object('code', code, 'name', name)
    order by code
  ), '[]'::jsonb)
  from public.campuses;
$$;

-- Lists campuses where the current local time is the rotation hour. Used by
-- the cron-triggered Edge Function to decide which campuses to rotate this run.
create or replace function public.campuses_due_for_rotation()
returns jsonb
language sql security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'code', code,
    'name', name,
    'timezone', timezone,
    'local_time', to_char(now() at time zone timezone, 'HH24:MI')
  )), '[]'::jsonb)
  from public.campuses
  where extract(hour from now() at time zone timezone) = 0
    and extract(minute from now() at time zone timezone) < 5;
$$;

-- -----------------------------------------------------------------------------
-- RPC: admin operations
-- -----------------------------------------------------------------------------

-- Returns today's per-campus temp password. Scoped: admin with NULL scope must
-- pass p_campus; admin with set scope can omit it (or pass matching campus).
create or replace function public.get_current_batch_temp_password(p_campus text default null)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_admin public.profiles;
  v_campus text;
  v_secret public.system_secrets;
begin
  v_admin := public.assert_admin_scope(p_target_campus => p_campus);

  v_campus := coalesce(p_campus, v_admin.admin_campus_scope);
  if v_campus is null then
    raise exception 'Campus is required for global admin.';
  end if;

  select * into v_secret
  from public.system_secrets
  where campus = v_campus
  order by rotation_date desc
  limit 1;

  insert into public.audit_events(event_type, actor_profile_id, actor_campus, metadata)
  values ('read_batch_temp_password', v_admin.profile_id, v_admin.campus,
          jsonb_build_object('campus', v_campus));

  if v_secret.id is null then
    return jsonb_build_object('campus', v_campus, 'temp_password', null, 'rotation_date', null);
  end if;

  return jsonb_build_object(
    'campus', v_campus,
    'temp_password', v_secret.temp_password,
    'rotation_date', v_secret.rotation_date
  );
end;
$$;

-- List unclaimed (password_set_at IS NULL) profiles in scope.
create or replace function public.list_unclaimed_profiles(p_campus text default null)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_admin public.profiles;
  v_campus text;
begin
  v_admin := public.assert_admin_scope(p_target_campus => p_campus);
  v_campus := coalesce(p_campus, v_admin.admin_campus_scope);

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'profile_id', p.profile_id,
      'pass_id', p.pass_id,
      'role', p.role,
      'campus', p.campus,
      'group_name', p.group_name,
      'sub_group', p.sub_group,
      'created_at', p.created_at
    ) order by p.created_at)
    from public.profiles p
    where p.archived_at is null
      and p.password_set_at is null
      and (v_campus is null or p.campus = v_campus)
  ), '[]'::jsonb);
end;
$$;

create or replace function public.post_notification(
  p_title text,
  p_body text,
  p_link_url text default null,
  p_target_campus text default null,
  p_target_group_name text default null,
  p_target_sub_group text default null,
  p_target_profile_id uuid default null,
  p_pinned boolean default false,
  p_expires_at timestamptz default null
)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_caller public.profiles;
  v_notification public.notifications;
begin
  v_caller := public.assert_authenticated();

  if v_caller.role not in ('coordinator', 'admin') then
    raise exception 'Only Coordinators and Admins can post notifications.';
  end if;

  -- Per-campus admin scope check for admins with restricted scope.
  if v_caller.role = 'admin'
     and v_caller.admin_campus_scope is not null
     and (p_target_campus is null or p_target_campus <> v_caller.admin_campus_scope) then
    raise exception 'Notification target must match your admin campus scope.';
  end if;

  if p_title is null or length(trim(p_title)) = 0 or length(p_title) > 200 then
    raise exception 'Title is required and must be at most 200 characters.';
  end if;

  if p_body is null or length(trim(p_body)) = 0 or length(p_body) > 2000 then
    raise exception 'Body is required and must be at most 2000 characters.';
  end if;

  -- Reject non-http(s) link URLs (javascript:, data:, etc.).
  if p_link_url is not null and p_link_url !~* '^https?://' then
    raise exception 'link_url must start with http:// or https://.';
  end if;

  -- If pinning, unpin any existing pin at the same scope first.
  if p_pinned then
    update public.notifications
    set pinned = false
    where pinned
      and target_campus is not distinct from p_target_campus
      and target_group_name is not distinct from p_target_group_name
      and target_sub_group is not distinct from p_target_sub_group
      and target_profile_id is not distinct from p_target_profile_id;
  end if;

  insert into public.notifications(
    target_campus, target_group_name, target_sub_group, target_profile_id,
    title, body, link_url, pinned, created_by, expires_at
  )
  values (
    p_target_campus, p_target_group_name, p_target_sub_group, p_target_profile_id,
    trim(p_title), trim(p_body), p_link_url, p_pinned, v_caller.profile_id, p_expires_at
  )
  returning * into v_notification;

  insert into public.audit_events(event_type, actor_profile_id, actor_campus, metadata)
  values ('post_notification', v_caller.profile_id, v_caller.campus,
          jsonb_build_object('notification_id', v_notification.id, 'pinned', p_pinned));

  return to_jsonb(v_notification);
end;
$$;

create or replace function public.pin_notification(p_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_caller public.profiles;
  v_target public.notifications;
begin
  v_caller := public.assert_authenticated();

  if v_caller.role not in ('coordinator', 'admin') then
    raise exception 'Only Coordinators and Admins can pin notifications.';
  end if;

  select * into v_target from public.notifications where id = p_id;
  if v_target.id is null then
    raise exception 'Notification not found.';
  end if;

  if v_caller.role = 'admin'
     and v_caller.admin_campus_scope is not null
     and v_target.target_campus is distinct from v_caller.admin_campus_scope then
    raise exception 'Notification is outside your admin campus scope.';
  end if;

  update public.notifications
  set pinned = false
  where pinned
    and target_campus is not distinct from v_target.target_campus
    and target_group_name is not distinct from v_target.target_group_name
    and target_sub_group is not distinct from v_target.target_sub_group
    and target_profile_id is not distinct from v_target.target_profile_id
    and id <> p_id;

  update public.notifications set pinned = true where id = p_id;

  insert into public.audit_events(event_type, actor_profile_id, actor_campus, metadata)
  values ('pin_notification', v_caller.profile_id, v_caller.campus,
          jsonb_build_object('notification_id', p_id));

  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.view_audit_events(
  p_limit integer default 100,
  p_offset integer default 0,
  p_event_type text default null
)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_admin public.profiles;
begin
  v_admin := public.assert_admin_scope();

  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'Limit must be between 1 and 500.';
  end if;

  return coalesce((
    select jsonb_agg(row_to_json(events) order by events.created_at desc)
    from (
      select e.id, e.event_type, e.actor_profile_id, e.actor_campus,
             e.device_install_id, e.session_id, e.attendance_attempt_id,
             e.metadata, e.created_at
      from public.audit_events e
      where (v_admin.admin_campus_scope is null
             or e.actor_campus = v_admin.admin_campus_scope
             or e.actor_campus is null)
        and (p_event_type is null or e.event_type = p_event_type)
      order by e.created_at desc
      limit p_limit
      offset coalesce(p_offset, 0)
    ) events
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin: campus management
-- ---------------------------------------------------------------------------
-- Create, rename, delete campuses, and edit per-campus geofences. Create /
-- rename / delete are global-admin-only (admin_campus_scope IS NULL). Geofence
-- edit is allowed for the campus's own per-campus admin and for any global
-- admin, via the existing assert_admin_scope guard.

create or replace function public.admin_create_campus(
  p_code text,
  p_name text,
  p_timezone text
)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_admin public.profiles;
  v_row public.campuses;
begin
  v_admin := public.assert_admin_scope();
  if v_admin.admin_campus_scope is not null then
    raise exception 'Only global admins may create campuses.';
  end if;
  if p_code is null or length(trim(p_code)) = 0 then
    raise exception 'code is required.';
  end if;
  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'name is required.';
  end if;
  if p_timezone is null or length(trim(p_timezone)) = 0 then
    raise exception 'timezone is required.';
  end if;
  -- The hostname-safe CHECK on campuses.code surfaces here as a clean error
  -- if p_code violates the RFC 1035 charset.
  insert into public.campuses(code, name, timezone)
  values (upper(trim(p_code)), trim(p_name), trim(p_timezone))
  returning * into v_row;

  insert into public.audit_events(event_type, actor_profile_id, actor_campus, metadata)
  values ('admin_create_campus', v_admin.profile_id, v_admin.campus,
          jsonb_build_object('code', v_row.code, 'name', v_row.name, 'timezone', v_row.timezone));

  return to_jsonb(v_row);
end;
$$;

create or replace function public.admin_rename_campus(
  p_old_code text,
  p_new_code text
)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_admin public.profiles;
  v_row public.campuses;
begin
  v_admin := public.assert_admin_scope();
  if v_admin.admin_campus_scope is not null then
    raise exception 'Only global admins may rename campuses.';
  end if;
  if p_old_code is null or p_new_code is null then
    raise exception 'Both old and new codes are required.';
  end if;
  -- The ON UPDATE CASCADE on profiles.campus / system_secrets.campus /
  -- audit_events.actor_campus / notifications.target_campus propagates the
  -- rename automatically. Synthetic auth emails encode the campus code, so
  -- after a rename, every account's auth.users.email must be rewritten too;
  -- callers should run scripts/migrate-synthetic-emails.mjs (or a similar
  -- targeted script) after this RPC.
  update public.campuses
     set code = upper(trim(p_new_code))
   where code = upper(trim(p_old_code))
   returning * into v_row;
  if v_row.code is null then
    raise exception 'Campus % not found.', p_old_code;
  end if;

  insert into public.audit_events(event_type, actor_profile_id, actor_campus, metadata)
  values ('admin_rename_campus', v_admin.profile_id, v_admin.campus,
          jsonb_build_object('old_code', upper(trim(p_old_code)), 'new_code', v_row.code));

  return to_jsonb(v_row);
end;
$$;

create or replace function public.admin_delete_campus(p_code text)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_admin public.profiles;
  v_active_count integer;
  v_code text;
begin
  v_admin := public.assert_admin_scope();
  if v_admin.admin_campus_scope is not null then
    raise exception 'Only global admins may delete campuses.';
  end if;
  v_code := upper(trim(coalesce(p_code, '')));
  if v_code = '' then
    raise exception 'code is required.';
  end if;
  -- Refuse if any non-archived profile still belongs to this campus. Daily
  -- temp rows in system_secrets are pruned automatically; we don't gate on
  -- them.
  select count(*) into v_active_count
  from public.profiles
  where campus = v_code and archived_at is null;
  if v_active_count > 0 then
    raise exception 'Campus % still has % active profile(s). Revoke them first.',
      v_code, v_active_count;
  end if;
  delete from public.campuses where code = v_code;

  insert into public.audit_events(event_type, actor_profile_id, actor_campus, metadata)
  values ('admin_delete_campus', v_admin.profile_id, v_admin.campus,
          jsonb_build_object('code', v_code));

  return jsonb_build_object('code', v_code, 'deleted', true);
end;
$$;

create or replace function public.admin_set_geofence(
  p_code text,
  p_lat double precision,
  p_lon double precision,
  p_radius_metres integer
)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_admin public.profiles;
  v_row public.campuses;
  v_code text;
  v_all_null boolean;
  v_all_set boolean;
begin
  v_code := upper(trim(coalesce(p_code, '')));
  if v_code = '' then
    raise exception 'code is required.';
  end if;
  -- assert_admin_scope allows global admins (NULL scope) and per-campus admins
  -- whose scope matches v_code; rejects everyone else.
  v_admin := public.assert_admin_scope(p_target_campus => v_code);

  v_all_null := p_lat is null and p_lon is null and p_radius_metres is null;
  v_all_set  := p_lat is not null and p_lon is not null and p_radius_metres is not null;
  if not (v_all_null or v_all_set) then
    raise exception 'lat, lon, radius_metres must all be set or all be null.';
  end if;
  if p_lat is not null and (p_lat < -90 or p_lat > 90) then
    raise exception 'lat must be in [-90, 90].';
  end if;
  if p_lon is not null and (p_lon < -180 or p_lon > 180) then
    raise exception 'lon must be in [-180, 180].';
  end if;
  if p_radius_metres is not null and p_radius_metres <= 0 then
    raise exception 'radius_metres must be positive.';
  end if;

  update public.campuses
     set center_lat = p_lat,
         center_lon = p_lon,
         radius_metres = p_radius_metres
   where code = v_code
   returning * into v_row;
  if v_row.code is null then
    raise exception 'Campus % not found.', v_code;
  end if;

  insert into public.audit_events(event_type, actor_profile_id, actor_campus, metadata)
  values ('admin_set_geofence', v_admin.profile_id, v_admin.campus,
          jsonb_build_object(
            'code', v_row.code,
            'lat', p_lat, 'lon', p_lon, 'radius_metres', p_radius_metres,
            'cleared', v_all_null));

  return to_jsonb(v_row);
end;
$$;

-- Revoke every refresh token for a user. Used by the reset-password Edge
-- Function as an explicit force-logout that doesn't depend on GoTrue's
-- side effects from a password change. Returns the deleted row count.
create or replace function public.revoke_user_refresh_tokens(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deleted integer;
begin
  with d as (
    delete from auth.refresh_tokens where user_id = p_user_id::text returning 1
  )
  select count(*) into v_deleted from d;
  return v_deleted;
end;
$$;

-- Cleanup helper. Deletes auth.users rows with a synthetic attendance email
-- that no longer have a matching public.profiles row. Called from the revoke
-- Edge Function on every batch so future provisioning of the same pass-ID
-- never gets blocked by an orphan, and also re-runnable manually as
-- `select public.cleanup_orphaned_synthetic_auth_users();`.
--
-- Two email shapes are recognised:
--   * Legacy `{pass_id}@passid.local` (pre per-campus-uniqueness migration).
--   * Current `{pass_id}@{campus}.local` where {campus} matches a row in
--     public.campuses (lower-cased). The legacy clause is kept so any orphans
--     created mid-cutover are still swept; it can be removed in a follow-up
--     once `select 1 from auth.users where email like '%@passid.local'` is
--     empty for an extended period.
create or replace function public.cleanup_orphaned_synthetic_auth_users()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deleted integer;
begin
  with d as (
    delete from auth.users u
    where (
        u.email like '%@passid.local'
        or split_part(u.email, '@', 2) in (
          select lower(code) || '.local' from public.campuses
        )
      )
      and not exists (
        -- Treat archived profiles as "doesn't count": if the only profile
        -- match is archived, the auth user is still an orphan from the
        -- re-provisioning standpoint and should be cleaned up.
        select 1 from public.profiles p
        where p.profile_id = u.id
          and p.archived_at is null
      )
    returning 1
  )
  select count(*) into v_deleted from d;
  return v_deleted;
end;
$$;

-- -----------------------------------------------------------------------------
-- RLS policies
-- -----------------------------------------------------------------------------

alter table public.campuses enable row level security;
alter table public.profiles enable row level security;
alter table public.attendance_sessions enable row level security;
alter table public.attendance_attempts enable row level security;
alter table public.audit_events enable row level security;
alter table public.notifications enable row level security;
alter table public.system_secrets enable row level security;

-- campuses: any authenticated user can list (UI needs the campus dropdown).
create policy campuses_select_authenticated on public.campuses
  for select to authenticated using (true);

-- profiles: caller can read their own row. All other access is via RPC.
create policy profiles_select_self on public.profiles
  for select to authenticated
  using (profile_id = auth.uid());

-- notifications: visible to a user when any non-NULL targeting column matches
-- their profile or is NULL. expires_at, if set, must be in the future.
create policy notifications_select_targeted on public.notifications
  for select to authenticated
  using (
    (expires_at is null or expires_at > now())
    and exists (
      select 1 from public.profiles p
      where p.profile_id = auth.uid()
        and p.archived_at is null
        and (notifications.target_campus is null or notifications.target_campus = p.campus)
        and (notifications.target_group_name is null or notifications.target_group_name = p.group_name)
        and (notifications.target_sub_group is null or notifications.target_sub_group = p.sub_group)
        and (notifications.target_profile_id is null or notifications.target_profile_id = p.profile_id)
    )
  );

-- All write paths on these tables go through SECURITY DEFINER RPCs.
create policy attendance_sessions_deny_all on public.attendance_sessions for all using (false) with check (false);
create policy attendance_attempts_deny_all on public.attendance_attempts for all using (false) with check (false);
create policy audit_events_deny_all on public.audit_events for all using (false) with check (false);
create policy system_secrets_deny_all on public.system_secrets for all using (false) with check (false);

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------

revoke all on public.campuses from anon, authenticated;
revoke all on public.profiles from anon, authenticated;
revoke all on public.attendance_sessions from anon, authenticated;
revoke all on public.attendance_attempts from anon, authenticated;
revoke all on public.audit_events from anon, authenticated;
revoke all on public.notifications from anon, authenticated;
revoke all on public.system_secrets from anon, authenticated;

grant select on public.campuses to authenticated;
grant select on public.profiles to authenticated;
grant select on public.notifications to authenticated;

-- service_role bypasses RLS but still needs table-level privileges. Used by
-- the seed script and the provision/revoke/rotate-daily Edge Functions.
grant all on public.campuses to service_role;
grant all on public.profiles to service_role;
grant all on public.attendance_sessions to service_role;
grant all on public.attendance_attempts to service_role;
grant all on public.audit_events to service_role;
grant all on public.notifications to service_role;
grant all on public.system_secrets to service_role;

revoke all on function public.assert_password_policy(text) from public, anon, authenticated;
revoke all on function public.distance_metres(double precision, double precision, double precision, double precision) from public, anon, authenticated;
revoke all on function public.csv_cell(text) from public, anon, authenticated;
revoke all on function public.assert_authenticated(boolean) from public, anon, authenticated;
revoke all on function public.assert_admin_scope(text) from public, anon, authenticated;
revoke all on function public.ensure_today_temp(text, text) from public, anon, authenticated;
revoke all on function public.rotate_today_temp(text, text) from public, anon, authenticated;
revoke all on function public.campuses_due_for_rotation() from public, anon, authenticated;

revoke all on function public.get_current_login_profile(uuid) from public, anon, authenticated;
revoke all on function public.mark_password_set() from public, anon, authenticated;
revoke all on function public.validate_password(text) from public, anon, authenticated;
revoke all on function public.create_attendance_session(text, text, timestamptz, integer, double precision, double precision, uuid, boolean, boolean, text, text, text) from public, anon, authenticated;
revoke all on function public.list_open_geofence_sessions() from public, anon, authenticated;
revoke all on function public.submit_geofence_attendance(uuid, uuid, double precision, double precision) from public, anon, authenticated;
revoke all on function public.list_manageable_sessions(integer) from public, anon, authenticated;
revoke all on function public.submit_attendance(jsonb, uuid, double precision, double precision) from public, anon, authenticated;
revoke all on function public.view_session_attendance(uuid) from public, anon, authenticated;
revoke all on function public.export_canonical_attendance_csv(uuid) from public, anon, authenticated;
revoke all on function public.get_current_batch_temp_password(text) from public, anon, authenticated;
revoke all on function public.list_unclaimed_profiles(text) from public, anon, authenticated;
revoke all on function public.post_notification(text, text, text, text, text, text, uuid, boolean, timestamptz) from public, anon, authenticated;
revoke all on function public.pin_notification(uuid) from public, anon, authenticated;
revoke all on function public.view_audit_events(integer, integer, text) from public, anon, authenticated;
revoke all on function public.admin_create_campus(text, text, text) from public, anon, authenticated;
revoke all on function public.admin_rename_campus(text, text) from public, anon, authenticated;
revoke all on function public.admin_delete_campus(text) from public, anon, authenticated;
revoke all on function public.admin_set_geofence(text, double precision, double precision, integer) from public, anon, authenticated;

grant execute on function public.get_current_login_profile(uuid) to authenticated;
grant execute on function public.mark_password_set() to authenticated;
grant execute on function public.validate_password(text) to authenticated;
grant execute on function public.create_attendance_session(text, text, timestamptz, integer, double precision, double precision, uuid, boolean, boolean, text, text, text) to authenticated;
grant execute on function public.list_open_geofence_sessions() to authenticated;
grant execute on function public.submit_geofence_attendance(uuid, uuid, double precision, double precision) to authenticated;
grant execute on function public.list_manageable_sessions(integer) to authenticated;
grant execute on function public.submit_attendance(jsonb, uuid, double precision, double precision) to authenticated;
grant execute on function public.view_session_attendance(uuid) to authenticated;
grant execute on function public.export_canonical_attendance_csv(uuid) to authenticated;
grant execute on function public.get_current_batch_temp_password(text) to authenticated;
grant execute on function public.list_unclaimed_profiles(text) to authenticated;
grant execute on function public.post_notification(text, text, text, text, text, text, uuid, boolean, timestamptz) to authenticated;
grant execute on function public.pin_notification(uuid) to authenticated;
grant execute on function public.view_audit_events(integer, integer, text) to authenticated;
grant execute on function public.admin_create_campus(text, text, text) to authenticated;
grant execute on function public.admin_rename_campus(text, text) to authenticated;
grant execute on function public.admin_delete_campus(text) to authenticated;
grant execute on function public.admin_set_geofence(text, double precision, double precision, integer) to authenticated;

-- Edge Function helpers called via service_role (provision, rotate-daily,
-- revoke, reset-password).
grant execute on function public.ensure_today_temp(text, text) to service_role;
grant execute on function public.rotate_today_temp(text, text) to service_role;
grant execute on function public.campuses_due_for_rotation() to service_role;
grant execute on function public.get_current_login_profile(uuid) to service_role;

revoke all on function public.cleanup_orphaned_synthetic_auth_users() from public, anon, authenticated;
grant execute on function public.cleanup_orphaned_synthetic_auth_users() to service_role;

-- Sign-in screen reads this before the user has a session.
grant execute on function public.list_public_campuses() to anon, authenticated;

revoke all on function public.revoke_user_refresh_tokens(uuid) from public, anon, authenticated;
grant execute on function public.revoke_user_refresh_tokens(uuid) to service_role;

-- -----------------------------------------------------------------------------
-- Realtime publications
-- -----------------------------------------------------------------------------
-- Enable postgres_changes streaming for the tables the client subscribes to:
--   - notifications: live admin-posted alerts in the settings menu.
--   - profiles:      force-logout when archived_at is set (revoke flow).
-- Idempotent so reapplies don't fail if the publication already includes them.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'profiles'
  ) then
    alter publication supabase_realtime add table public.profiles;
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- Realtime broadcast for live session-list updates.
--
-- attendance_sessions has RLS deny-all (reads go through SECURITY DEFINER RPCs
-- like list_open_geofence_sessions), so postgres_changes streaming would never
-- deliver events. Instead, fire a per-row broadcast on the `sessions:open`
-- topic whenever a session row changes; the client refetches via the RPC,
-- which still enforces scope filtering. The payload carries only scope hints
-- (no session content), so making the topic public via private=false is safe.
-- -----------------------------------------------------------------------------

create or replace function public.attendance_sessions_broadcast()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Wrap in EXCEPTION so a Realtime outage or a project without the realtime
  -- schema cannot block session writes. Live updates degrade to manual refresh.
  begin
    perform realtime.send(
      jsonb_build_object(
        'op', tg_op,
        'scope_campus', coalesce(new.scope_campus, old.scope_campus),
        'scope_group_name', coalesce(new.scope_group_name, old.scope_group_name),
        'scope_sub_group', coalesce(new.scope_sub_group, old.scope_sub_group)
      ),
      'sessions_changed',
      'sessions:open',
      false
    );
  exception when others then
    -- swallow: do not let realtime issues fail the row write
    null;
  end;
  return null;
end;
$$;

drop trigger if exists attendance_sessions_broadcast_trg on public.attendance_sessions;
create trigger attendance_sessions_broadcast_trg
  after insert or update or delete on public.attendance_sessions
  for each row execute function public.attendance_sessions_broadcast();

-- -----------------------------------------------------------------------------
-- Final sweep: drop orphan synthetic-email auth.users left over from earlier
-- runs. The destructive drops above wipe public.profiles cascade but leave
-- auth.users intact, so every reapply would otherwise inherit stale orphans
-- that block re-provisioning ("A user with this email address has already
-- been registered"). Running the cleanup here means a fresh schema.sql
-- application is self-sufficient — no separate manual cleanup step needed.
-- -----------------------------------------------------------------------------
select public.cleanup_orphaned_synthetic_auth_users();

-- -----------------------------------------------------------------------------
-- pg_cron schedule (commented; enable after rotate-daily Edge Function deploys)
-- -----------------------------------------------------------------------------
-- The rotation Edge Function checks each campus's local time and acts only when
-- it is 23:59 there. Schedule it hourly. Replace <PROJECT_REF> and the bearer
-- token (use the service-role key stored in Supabase Vault, do NOT inline it).
--
-- select cron.schedule(
--   'rotate-daily-temps',
--   '59 * * * *',
--   $$
--   select net.http_post(
--     url := 'https://<PROJECT_REF>.supabase.co/functions/v1/rotate-daily',
--     headers := jsonb_build_object(
--       'Content-Type', 'application/json',
--       'Authorization', 'Bearer ' || current_setting('app.rotate_daily_token')
--     ),
--     body := '{}'::jsonb
--   );
--   $$
-- );
-- =============================================================================
