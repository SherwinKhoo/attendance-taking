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
drop function if exists public.get_latest_active_session_qr_for_creator(text, uuid, uuid);
drop function if exists public.submit_attendance(jsonb, text, uuid, uuid, double precision, double precision);
drop function if exists public.view_session_attendance(uuid, text, uuid, uuid);
drop function if exists public.export_canonical_attendance_csv(uuid, text, uuid, uuid);

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
  created_at timestamptz not null default now()
);

create table public.profiles (
  -- profile_id matches auth.users.id; populated by the provision Edge Function
  -- after auth.admin.createUser. RLS keys off auth.uid() = profile_id.
  profile_id uuid primary key references auth.users(id) on delete cascade,
  pass_id text,
  role text not null default 'user'
    check (role in ('user', 'representative', 'coordinator', 'admin')),
  campus text references public.campuses(code) on update cascade,
  group_name text,
  sub_group text,
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

-- Active pass_ids must be unique; archived rows are excluded so a string can recur.
create unique index profiles_pass_id_active_unique
  on public.profiles(pass_id)
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
  creator_profile_id uuid not null references public.profiles(profile_id),
  creator_device_install_id uuid not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index attendance_sessions_code_unique_idx
  on public.attendance_sessions(code);
create index attendance_sessions_creator_active_idx
  on public.attendance_sessions(creator_profile_id, active, created_at desc);

create table public.attendance_attempts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.attendance_sessions(id),
  session_code text not null,
  session_name text not null,
  scanned_session_payload jsonb not null,
  profile_id uuid not null references public.profiles(profile_id),
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
  actor_profile_id uuid references public.profiles(profile_id),
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
  created_by uuid references public.profiles(profile_id),
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
  p_device_install_id uuid
)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_caller public.profiles;
  v_session public.attendance_sessions;
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

  insert into public.attendance_sessions(
    code, name, intended_start_at, grace_period_minutes,
    creator_lat, creator_lon, creator_profile_id, creator_device_install_id
  )
  values (
    upper(trim(p_code)), trim(p_name), p_intended_start_at, p_grace_period_minutes,
    p_creator_lat, p_creator_lon, v_caller.profile_id, p_device_install_id
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
    'created_at', v_session.created_at
  );
end;
$$;

create or replace function public.get_latest_active_session_qr_for_creator(
  p_device_install_id uuid
)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_caller public.profiles;
  v_session public.attendance_sessions;
begin
  v_caller := public.assert_authenticated();

  if v_caller.role not in ('representative', 'coordinator', 'admin') then
    raise exception 'Only Representatives, Coordinators, and Admins can restore session QR codes.';
  end if;

  select * into v_session
  from public.attendance_sessions
  where active
    and creator_profile_id = v_caller.profile_id
    and creator_device_install_id = p_device_install_id
  order by created_at desc
  limit 1;

  if v_session.id is null then
    return null;
  end if;

  insert into public.audit_events(event_type, actor_profile_id, actor_campus, device_install_id, session_id)
  values ('restore_latest_active_session_qr', v_caller.profile_id, v_caller.campus, p_device_install_id, v_session.id);

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
    'created_at', v_session.created_at
  );
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
    profile_id, device_install_id, submitter_lat, submitter_lon,
    status, flags, canonical, distance_from_session_m
  )
  values (
    v_session.id, v_session.code, v_session.name, p_session_payload,
    v_caller.profile_id, p_device_install_id, p_submitter_lat, p_submitter_lon,
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
      'pass_id', p.pass_id,
      'submitted_at', a.submitted_at,
      'status', a.status,
      'flags', a.flags,
      'canonical', a.canonical,
      'attempt_count', (
        select count(*) from public.attendance_attempts attempts
        where attempts.session_id = a.session_id
          and attempts.profile_id = a.profile_id
      )
    ) order by a.submitted_at)
    from public.attendance_attempts a
    join public.profiles p on p.profile_id = a.profile_id
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

  select string_agg(line, E'\n')
  into v_csv
  from (
    select 0 as sort_order,
      'session code,session name,pass ID,canonical submitted timestamp,attempt count,flag count,flags,device install ID,submitter coordinates,late flag status,distance from session QR location' as line
    union all
    select 1,
      concat_ws(',',
        public.csv_cell(a.session_code),
        public.csv_cell(a.session_name),
        public.csv_cell(p.pass_id),
        public.csv_cell(a.submitted_at::text),
        (
          select count(*)::text from public.attendance_attempts attempts
          where attempts.session_id = a.session_id
            and attempts.profile_id = a.profile_id
        ),
        cardinality(a.flags)::text,
        public.csv_cell(array_to_string(a.flags, '|')),
        public.csv_cell(a.device_install_id::text),
        public.csv_cell(a.submitter_lat::text || ',' || a.submitter_lon::text),
        (array_position(a.flags, 'LATE_AFTER_GRACE_PERIOD') is not null)::text,
        coalesce(round(a.distance_from_session_m::numeric, 2)::text, '')
      )
    from public.attendance_attempts a
    join public.profiles p on p.profile_id = a.profile_id
    where a.session_id = p_session_id
      and a.canonical
  ) rows
  order by sort_order;

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
revoke all on function public.create_attendance_session(text, text, timestamptz, integer, double precision, double precision, uuid) from public, anon, authenticated;
revoke all on function public.get_latest_active_session_qr_for_creator(uuid) from public, anon, authenticated;
revoke all on function public.submit_attendance(jsonb, uuid, double precision, double precision) from public, anon, authenticated;
revoke all on function public.view_session_attendance(uuid) from public, anon, authenticated;
revoke all on function public.export_canonical_attendance_csv(uuid) from public, anon, authenticated;
revoke all on function public.get_current_batch_temp_password(text) from public, anon, authenticated;
revoke all on function public.list_unclaimed_profiles(text) from public, anon, authenticated;
revoke all on function public.post_notification(text, text, text, text, text, text, uuid, boolean, timestamptz) from public, anon, authenticated;
revoke all on function public.pin_notification(uuid) from public, anon, authenticated;
revoke all on function public.view_audit_events(integer, integer, text) from public, anon, authenticated;

grant execute on function public.get_current_login_profile(uuid) to authenticated;
grant execute on function public.mark_password_set() to authenticated;
grant execute on function public.validate_password(text) to authenticated;
grant execute on function public.create_attendance_session(text, text, timestamptz, integer, double precision, double precision, uuid) to authenticated;
grant execute on function public.get_latest_active_session_qr_for_creator(uuid) to authenticated;
grant execute on function public.submit_attendance(jsonb, uuid, double precision, double precision) to authenticated;
grant execute on function public.view_session_attendance(uuid) to authenticated;
grant execute on function public.export_canonical_attendance_csv(uuid) to authenticated;
grant execute on function public.get_current_batch_temp_password(text) to authenticated;
grant execute on function public.list_unclaimed_profiles(text) to authenticated;
grant execute on function public.post_notification(text, text, text, text, text, text, uuid, boolean, timestamptz) to authenticated;
grant execute on function public.pin_notification(uuid) to authenticated;
grant execute on function public.view_audit_events(integer, integer, text) to authenticated;

-- Edge Function helpers called via service_role (provision, rotate-daily).
grant execute on function public.ensure_today_temp(text, text) to service_role;
grant execute on function public.rotate_today_temp(text, text) to service_role;
grant execute on function public.campuses_due_for_rotation() to service_role;
grant execute on function public.get_current_login_profile(uuid) to service_role;

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
