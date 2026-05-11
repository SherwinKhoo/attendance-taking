-- Add campus-grounds (no-QR) check-in mode alongside QR scanning.
--
-- 1. Per-campus geofence (centre + radius). Nullable; campuses without all
--    three set are blocked from enabling campus-grounds mode on a session.
-- 2. Two boolean mode flags on attendance_sessions with a CHECK that at least
--    one is on. Existing rows default to allow_qr=true / allow_geofence=false.
-- 3. Extend create_attendance_session with two boolean params.
-- 4. Add list_open_geofence_sessions and submit_geofence_attendance RPCs.
--
-- Idempotent: column adds use IF NOT EXISTS, constraint adds are guarded by
-- pg_constraint lookups, and function bodies use CREATE OR REPLACE.

-- 1. Campus geofence columns.
alter table public.campuses
  add column if not exists center_lat double precision,
  add column if not exists center_lon double precision,
  add column if not exists radius_metres integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'campuses_radius_positive'
  ) then
    alter table public.campuses
      add constraint campuses_radius_positive
      check (radius_metres is null or radius_metres > 0);
  end if;
end $$;

-- 2. Session mode flags.
alter table public.attendance_sessions
  add column if not exists allow_qr boolean not null default true,
  add column if not exists allow_geofence boolean not null default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'attendance_sessions_at_least_one_mode'
  ) then
    alter table public.attendance_sessions
      add constraint attendance_sessions_at_least_one_mode
      check (allow_qr or allow_geofence);
  end if;
end $$;

-- 3. create_attendance_session — drop the old 7-arg signature so the new
--    9-arg version replaces (rather than overloads) it.
drop function if exists public.create_attendance_session(
  text, text, timestamptz, integer, double precision, double precision, uuid
);

create or replace function public.create_attendance_session(
  p_code text,
  p_name text,
  p_intended_start_at timestamptz,
  p_grace_period_minutes integer,
  p_creator_lat double precision,
  p_creator_lon double precision,
  p_device_install_id uuid,
  p_allow_qr boolean default true,
  p_allow_geofence boolean default false
)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_caller public.profiles;
  v_session public.attendance_sessions;
  v_campus public.campuses;
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

  if p_allow_geofence then
    select * into v_campus from public.campuses where code = v_caller.campus;
    if v_campus.center_lat is null
       or v_campus.center_lon is null
       or v_campus.radius_metres is null then
      raise exception 'Campus % has no geofence configured; campus-grounds mode unavailable.',
        v_caller.campus;
    end if;
  end if;

  insert into public.attendance_sessions(
    code, name, intended_start_at, grace_period_minutes,
    creator_lat, creator_lon, creator_profile_id, creator_device_install_id,
    allow_qr, allow_geofence
  )
  values (
    upper(trim(p_code)), trim(p_name), p_intended_start_at, p_grace_period_minutes,
    p_creator_lat, p_creator_lon, v_caller.profile_id, p_device_install_id,
    p_allow_qr, p_allow_geofence
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
    'created_at', v_session.created_at
  );
end;
$$;

-- 4a. List active campus-grounds sessions targeted at the caller's exact
--     campus + group + sub-group bundle.
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
      'creator_pass_id', cp.pass_id,
      'created_at', s.created_at
    ) order by s.created_at desc)
    from public.attendance_sessions s
    join public.profiles cp on cp.profile_id = s.creator_profile_id
    where s.active
      and s.allow_geofence
      and cp.archived_at is null
      and cp.campus = v_caller.campus
      and cp.group_name = v_caller.group_name
      and cp.sub_group = v_caller.sub_group
  ), '[]'::jsonb);
end;
$$;

-- 4b. Submit attendance via the campus-grounds path. Hard-rejects when the
--     submitter is outside the campus geofence; QR's submit_attendance keeps
--     its softer "OUTSIDE_LOCATION_MARGIN" flag for 50 m proximity to creator.
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
  v_creator public.profiles;
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

  -- Defence-in-depth: the list RPC scopes by campus/group/sub-group, but
  -- enforce again here in case a client sends a session_id directly.
  select * into v_creator
  from public.profiles
  where profile_id = v_session.creator_profile_id;
  if v_creator.profile_id is null
     or v_creator.archived_at is not null
     or v_creator.campus is distinct from v_caller.campus
     or v_creator.group_name is distinct from v_caller.group_name
     or v_creator.sub_group is distinct from v_caller.sub_group then
    raise exception 'You are not in the target group for this session.';
  end if;

  select * into v_campus from public.campuses where code = v_caller.campus;
  if v_campus.center_lat is null
     or v_campus.center_lon is null
     or v_campus.radius_metres is null then
    raise exception 'Campus % has no geofence configured.', v_caller.campus;
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
    profile_id, device_install_id, submitter_lat, submitter_lon,
    status, flags, canonical, distance_from_session_m
  )
  values (
    v_session.id, v_session.code, v_session.name, v_payload,
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
    'submit_geofence_attendance', v_caller.profile_id, v_caller.campus, p_device_install_id,
    v_session.id, v_attempt.id, jsonb_build_object('flags', v_flags, 'distance_m', v_distance)
  );

  return to_jsonb(v_attempt);
end;
$$;

-- Grants. Mirror the lock-down style used elsewhere in schema.sql.
revoke all on function public.create_attendance_session(
  text, text, timestamptz, integer, double precision, double precision, uuid, boolean, boolean
) from public, anon, authenticated;
revoke all on function public.list_open_geofence_sessions() from public, anon, authenticated;
revoke all on function public.submit_geofence_attendance(
  uuid, uuid, double precision, double precision
) from public, anon, authenticated;

grant execute on function public.create_attendance_session(
  text, text, timestamptz, integer, double precision, double precision, uuid, boolean, boolean
) to authenticated;
grant execute on function public.list_open_geofence_sessions() to authenticated;
grant execute on function public.submit_geofence_attendance(
  uuid, uuid, double precision, double precision
) to authenticated;
