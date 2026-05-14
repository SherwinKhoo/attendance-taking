"use strict";

// =============================================================================
// Attendance app — main.js (Supabase Auth model)
// =============================================================================
// User-facing app. Admin-only screens live in admin.js (loaded in the same
// bundle and gated by profile.role === 'admin').
//
// Auth: Supabase Auth via signInWithPassword. The user picks a campus and
// types a pass-ID + their daily/permanent password; this code synthesises the
// auth email (${pass_id}@${campus}.local). The synthetic email is never
// user-visible. The campus code is required because pass-IDs are unique
// per campus, not globally.
//
// Persistence: localStorage (Supabase JS client default). Logout clears all
// app-local keys. sessionStorage variant is a single-line config flip if ever
// needed (deferred to v2).
// =============================================================================

const ZXING_WASM_VERSION = "3.0.2";
const ZXING_WASM_URL = `https://cdn.jsdelivr.net/npm/zxing-wasm@${ZXING_WASM_VERSION}/dist/full/zxing_full.wasm`;

const STORAGE_KEYS = {
  deviceInstallId: "attendance.deviceInstallId",
  latestCreatorSession: "attendance.latestCreatorSession",
  darkMode: "attendance.darkMode",
  lastCampus: "attendance.lastCampus",
};

const CONFIG = {
  CAMPUS_REGEX: /^[A-Z0-9]([A-Z0-9-]{0,61}[A-Z0-9])?$/i,
  CAMPUS_PATTERN: "[A-Za-z0-9]([A-Za-z0-9\\-]{0,61}[A-Za-z0-9])?",
  PASS_ID_REGEX: /^[A-Z0-9][A-Z0-9_-]{2,31}$/i,
  PASS_ID_PATTERN: "[A-Za-z0-9][A-Za-z0-9_\\-]{2,31}",
  PASSWORD_REGEX: /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*._-])[A-Za-z0-9!@#$%^&*._-]{10,16}$/,
  PASSWORD_PATTERN: "(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)(?=.*[!@#$%^&*._\\-])[A-Za-z0-9!@#$%^&*._\\-]{10,16}",
  PASSWORD_ALLOWED_CHARS_REGEX: /^[A-Za-z0-9!@#$%^&*._-]*$/,
  PASSWORD_ALLOWED_MESSAGE:
    "Use 10-16 characters with upper and lower case letters, numbers, and an approved symbol (!@#$%^&*._-).",
  PASSWORD_UNSUPPORTED_MESSAGE: "This field contains unsupported characters.",
  COORDINATE_DECIMALS: 6,
  LOCATION_MARGIN_METRES: 50,
  GEOLOCATION_OPTIONS: {
    enableHighAccuracy: true,
    timeout: 10000,
    maximumAge: 0,
  },
  QR_MIN_VERSION: 1,
  QR_MAX_VERSION: 40,
  QR_ERROR_CORRECTION: "H",
  QR_MASK_PATTERN: 2,
  BARCODE_FORMATS: {
    QR_CODE: "QRCode",
    AZTEC: "Aztec",
    MAXI_CODE: "MaxiCode",
  },
};

if (window.ZXingWASM) {
  ZXingWASM.setZXingModuleOverrides({
    locateFile: (path, prefix) => {
      if (path === "zxing_full.wasm" || path.endsWith("/zxing_full.wasm")) {
        return ZXING_WASM_URL;
      }
      return prefix + path;
    },
  });
}

const state = {
  deviceInstallId: getOrCreateDeviceInstallId(),
  supabase: createSupabaseClient(),
  profile: null,
  latestSession: null,
  attendanceCamera: createCameraState(),
  notifications: [],
  notificationsChannel: null,
  sessionsChannel: null,
};

// -----------------------------------------------------------------------------
// Layout
// -----------------------------------------------------------------------------

const app = document.createElement("main");
app.id = "app";
app.innerHTML = `
  <header class="app-header">
    <div class="header-actions">
      <button id="settings-toggle" type="button" class="icon-btn" aria-label="Settings" hidden>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
      </button>
    </div>
  </header>

  <div id="connectivity-banner" class="banner banner-warning" hidden>
    Connection lost. Submissions will fail until you reconnect.
  </div>

  <section class="zone" id="attendance-zone" aria-labelledby="attendance-title" hidden>
    <div class="zone-heading">
      <div><h2 id="attendance-title">Submit attendance</h2></div>
    </div>
    <video id="attendance-camera" class="camera" autoplay muted playsinline></video>
    <div class="action-row">
      <button id="attendance-camera-toggle" type="button">Start camera</button>
      <button id="attendance-scan" type="button" disabled>Scan session QR</button>
    </div>
    <p class="status-line" id="attendance-status">Scan the session QR code to submit attendance.</p>
  </section>

  <section class="zone" id="geofence-zone" aria-labelledby="geofence-title" hidden>
    <div class="zone-heading">
      <div><h2 id="geofence-title">Check in (campus grounds)</h2></div>
      <button id="refresh-open-sessions" type="button">Refresh</button>
    </div>
    <ul id="open-sessions-list" class="open-sessions-list">
      <li class="open-sessions-empty">Tap Refresh to load open sessions for your group.</li>
    </ul>
    <p class="status-line" id="geofence-status"></p>
  </section>

  <section class="zone" id="session-zone" aria-labelledby="session-title" hidden>
    <div class="zone-heading">
      <div><h2 id="session-title">Generate Session</h2></div>
      <button id="restore-session" type="button">Restore latest</button>
    </div>
    <form id="session-form" class="form-grid">
      <fieldset class="form-field">
        <legend>Session</legend>
        <label class="field-control" aria-label="Session">
          <input id="session-name" name="session-name" autocomplete="off" maxlength="120" required placeholder="Session Name" />
        </label>
      </fieldset>
      <fieldset class="form-field">
        <legend>Start date</legend>
        <label class="field-control" aria-label="Start date">
          <input id="session-date" name="session-date" type="date" required />
        </label>
      </fieldset>
      <fieldset class="form-field">
        <legend>Start time</legend>
        <label class="field-control" aria-label="Start time">
          <input id="session-time" name="session-time" type="time" required />
        </label>
      </fieldset>
      <fieldset class="form-field">
        <legend>Timeout</legend>
        <label class="field-control" aria-label="Timeout">
          <input id="grace-period" name="grace-period" type="number" min="0" step="1" value="0" required />
        </label>
      </fieldset>
      <fieldset class="form-field">
        <legend>Scope — Campus</legend>
        <label class="field-control" aria-label="Scope campus">
          <input id="session-scope-campus" name="session-scope-campus" type="text" autocomplete="off" maxlength="63" placeholder="Campus code" />
        </label>
      </fieldset>
      <fieldset class="form-field">
        <legend>Scope — Group (optional)</legend>
        <label class="field-control" aria-label="Scope group">
          <input id="session-scope-group" name="session-scope-group" type="text" autocomplete="off" maxlength="120" placeholder="Leave blank for campus-wide" />
        </label>
      </fieldset>
      <fieldset class="form-field">
        <legend>Scope — Sub-group (optional)</legend>
        <label class="field-control" aria-label="Scope sub-group">
          <input id="session-scope-subgroup" name="session-scope-subgroup" type="text" autocomplete="off" maxlength="120" placeholder="Leave blank for group-wide" disabled />
        </label>
      </fieldset>
      <fieldset class="form-field is-hidden-format">
        <legend>QR format</legend>
        <input id="barcode-format" name="barcode-format" type="hidden" value="QRCode" />
        <div class="static-form-value">QR Code</div>
      </fieldset>
      <fieldset class="checkin-modes">
        <legend>Check-in modes</legend>
        <label><input id="mode-qr" type="checkbox" checked /> QR scan</label>
        <label><input id="mode-geofence" type="checkbox" /> Campus grounds (no QR)</label>
      </fieldset>
      <button id="generate-session" type="submit">Generate QR Code</button>
    </form>
    <div class="qr-layout">
      <canvas id="session-qr"></canvas>
      <div class="session-summary" id="session-summary">No session generated yet. Use the form above or click "Restore latest".</div>
    </div>
    <div class="action-row">
      <button id="fullscreen-qr" type="button" disabled>Full-screen poster</button>
      <button id="refresh-attendee-total" type="button" disabled>Refresh attendee total</button>
      <button id="export-csv" type="button" disabled>Export canonical CSV</button>
    </div>
    <p class="status-line" id="attendee-total">Total attendees: 0</p>
    <p class="status-line" id="session-status"></p>
  </section>

  <div id="admin-mount"></div>

  <dialog id="confirm-dialog">
    <form method="dialog" class="modal-panel">
      <h2 id="confirm-session-name"></h2>
      <menu>
        <button id="cancel-submit" value="cancel">Cancel</button>
        <button id="confirm-submit" value="confirm">Confirm</button>
      </menu>
    </form>
  </dialog>

  <dialog id="login-dialog">
    <form id="login-form" class="modal-panel" method="dialog">
      <h2>Pass ID authentication</h2>
      <p id="login-status" class="status-line">Sign in with your pass ID.</p>
      <fieldset class="form-field modal-field">
        <legend>Campus</legend>
        <label class="field-control" aria-label="Campus">
          <input id="login-campus" name="campus" autocomplete="organization" placeholder="Campus code"
                 pattern="${CONFIG.CAMPUS_PATTERN}" maxlength="63" required />
        </label>
      </fieldset>
      <fieldset class="form-field modal-field">
        <legend>Pass ID</legend>
        <label class="field-control" aria-label="Pass ID">
          <input id="pass-id" name="pass-id" autocomplete="username" placeholder="e.g. A-001"
                 pattern="${CONFIG.PASS_ID_PATTERN}" maxlength="32" required />
        </label>
      </fieldset>
      <fieldset class="form-field modal-field">
        <legend>Password</legend>
        <label class="field-control password-field" aria-label="Password">
          <input id="password" name="password" type="password" autocomplete="current-password"
                 placeholder="10-16 characters" minlength="10" maxlength="16"
                 pattern="${CONFIG.PASSWORD_PATTERN}" title="${CONFIG.PASSWORD_ALLOWED_MESSAGE}" required />
          <button id="password-visibility-toggle" type="button" aria-controls="password" aria-pressed="false">Show</button>
        </label>
      </fieldset>
      <menu>
        <button id="login-submit" type="submit" value="submit">Log in</button>
      </menu>
    </form>
  </dialog>

  <dialog id="password-dialog">
    <form id="password-form" class="modal-panel" method="dialog">
      <h2 id="password-dialog-title">Change password</h2>
      <p id="password-dialog-intro" class="status-line"></p>
      <fieldset class="form-field modal-field">
        <legend>Current password</legend>
        <label class="field-control password-field" aria-label="Current password">
          <input id="password-old" type="password" autocomplete="current-password"
                 minlength="10" maxlength="16" pattern="${CONFIG.PASSWORD_PATTERN}"
                 title="${CONFIG.PASSWORD_ALLOWED_MESSAGE}" required />
          <button id="password-old-toggle" type="button" aria-controls="password-old" aria-pressed="false">Show</button>
        </label>
      </fieldset>
      <fieldset class="form-field modal-field">
        <legend>New password</legend>
        <label class="field-control password-field" aria-label="New password">
          <input id="password-new" type="password" autocomplete="new-password"
                 minlength="10" maxlength="16" pattern="${CONFIG.PASSWORD_PATTERN}"
                 title="${CONFIG.PASSWORD_ALLOWED_MESSAGE}" required />
          <button id="password-new-toggle" type="button" aria-controls="password-new" aria-pressed="false">Show</button>
        </label>
      </fieldset>
      <fieldset class="form-field modal-field">
        <legend>Confirm new password</legend>
        <label class="field-control password-field" aria-label="Confirm new password">
          <input id="password-confirm" type="password" autocomplete="new-password"
                 minlength="10" maxlength="16" pattern="${CONFIG.PASSWORD_PATTERN}"
                 title="${CONFIG.PASSWORD_ALLOWED_MESSAGE}" required />
          <button id="password-confirm-toggle" type="button" aria-controls="password-confirm" aria-pressed="false">Show</button>
        </label>
      </fieldset>
      <p class="validation-line" id="password-dialog-validation"></p>
      <menu>
        <button id="password-cancel" type="button" value="cancel">Cancel</button>
        <button id="password-submit" type="submit" value="submit">Save password</button>
      </menu>
    </form>
  </dialog>

  <dialog id="settings-dialog">
    <div class="modal-panel">
      <header class="settings-header">
        <h2>Settings</h2>
        <button id="settings-close" type="button" class="icon-btn" aria-label="Close">&times;</button>
      </header>
      <section class="settings-section">
        <div class="settings-mode-row">
          <span class="status" id="attendance-login-status"></span>
          <label class="switch" aria-label="Dark mode">
            <input id="dark-mode-toggle" type="checkbox" />
            <span class="switch-track" aria-hidden="true"></span>
          </label>
        </div>
        <button id="settings-change-password" type="button">Change password</button>
        <button id="settings-logout" type="button">Log out</button>
      </section>
      <section class="settings-section">
        <h3>Notifications</h3>
        <ul id="notifications-list" class="notifications-list"></ul>
      </section>
    </div>
  </dialog>

  <dialog id="qr-fullscreen-dialog" class="qr-fullscreen">
    <button id="qr-fullscreen-close" type="button" class="icon-btn qr-fullscreen-close" aria-label="Close">&times;</button>
    <canvas id="qr-fullscreen-canvas"></canvas>
    <p id="qr-fullscreen-caption"></p>
  </dialog>

  <div id="toast-host" aria-live="polite" aria-atomic="true"></div>
`;

document.body.append(app);

const els = {
  settingsToggle: document.getElementById("settings-toggle"),
  connectivityBanner: document.getElementById("connectivity-banner"),
  attendanceLoginStatus: document.getElementById("attendance-login-status"),
  attendanceCamera: document.getElementById("attendance-camera"),
  attendanceCameraToggle: document.getElementById("attendance-camera-toggle"),
  attendanceScan: document.getElementById("attendance-scan"),
  attendanceStatus: document.getElementById("attendance-status"),
  attendanceZone: document.getElementById("attendance-zone"),
  geofenceZone: document.getElementById("geofence-zone"),
  refreshOpenSessions: document.getElementById("refresh-open-sessions"),
  openSessionsList: document.getElementById("open-sessions-list"),
  geofenceStatus: document.getElementById("geofence-status"),
  modeQr: document.getElementById("mode-qr"),
  modeGeofence: document.getElementById("mode-geofence"),
  sessionZone: document.getElementById("session-zone"),
  sessionForm: document.getElementById("session-form"),
  sessionName: document.getElementById("session-name"),
  sessionDate: document.getElementById("session-date"),
  sessionTime: document.getElementById("session-time"),
  gracePeriod: document.getElementById("grace-period"),
  sessionScopeCampus: document.getElementById("session-scope-campus"),
  sessionScopeGroup: document.getElementById("session-scope-group"),
  sessionScopeSubgroup: document.getElementById("session-scope-subgroup"),
  barcodeFormat: document.getElementById("barcode-format"),
  restoreSession: document.getElementById("restore-session"),
  sessionQr: document.getElementById("session-qr"),
  sessionSummary: document.getElementById("session-summary"),
  attendeeTotal: document.getElementById("attendee-total"),
  sessionStatus: document.getElementById("session-status"),
  fullscreenQr: document.getElementById("fullscreen-qr"),
  refreshAttendeeTotal: document.getElementById("refresh-attendee-total"),
  exportCsv: document.getElementById("export-csv"),
  loginDialog: document.getElementById("login-dialog"),
  loginForm: document.getElementById("login-form"),
  loginCampus: document.getElementById("login-campus"),
  passId: document.getElementById("pass-id"),
  password: document.getElementById("password"),
  passwordVisibilityToggle: document.getElementById("password-visibility-toggle"),
  loginSubmit: document.getElementById("login-submit"),
  loginStatus: document.getElementById("login-status"),
  confirmDialog: document.getElementById("confirm-dialog"),
  confirmSessionName: document.getElementById("confirm-session-name"),
  confirmSubmit: document.getElementById("confirm-submit"),
  cancelSubmit: document.getElementById("cancel-submit"),
  passwordDialog: document.getElementById("password-dialog"),
  passwordDialogTitle: document.getElementById("password-dialog-title"),
  passwordDialogIntro: document.getElementById("password-dialog-intro"),
  passwordForm: document.getElementById("password-form"),
  passwordOld: document.getElementById("password-old"),
  passwordOldToggle: document.getElementById("password-old-toggle"),
  passwordNew: document.getElementById("password-new"),
  passwordNewToggle: document.getElementById("password-new-toggle"),
  passwordConfirm: document.getElementById("password-confirm"),
  passwordConfirmToggle: document.getElementById("password-confirm-toggle"),
  passwordDialogValidation: document.getElementById("password-dialog-validation"),
  passwordCancel: document.getElementById("password-cancel"),
  passwordSubmit: document.getElementById("password-submit"),
  settingsDialog: document.getElementById("settings-dialog"),
  settingsClose: document.getElementById("settings-close"),
  darkModeToggle: document.getElementById("dark-mode-toggle"),
  settingsChangePassword: document.getElementById("settings-change-password"),
  settingsLogout: document.getElementById("settings-logout"),
  notificationsList: document.getElementById("notifications-list"),
  qrFullscreenDialog: document.getElementById("qr-fullscreen-dialog"),
  qrFullscreenClose: document.getElementById("qr-fullscreen-close"),
  qrFullscreenCanvas: document.getElementById("qr-fullscreen-canvas"),
  qrFullscreenCaption: document.getElementById("qr-fullscreen-caption"),
  adminMount: document.getElementById("admin-mount"),
  toastHost: document.getElementById("toast-host"),
};

let pendingSessionPayload = null;
let forcedPasswordChange = false;
// Suppress onAuthStateChange re-entry while the password-change flow is
// running — re-auth + updateUser fire SIGNED_IN/USER_UPDATED events that
// would otherwise re-open the dialog before mark_password_set has run.
let passwordChangeInProgress = false;
// Set true by handleAuthSubmit immediately after a successful signInWithPassword.
// Read once by onAuthenticated to distinguish a fresh sign-in (allowed to open
// the forced-change modal) from a cached-session resume (must sign out so the
// next person at the device doesn't inherit a mid-claim session).
let justSignedIn = false;

// Watchdog budgets for Supabase calls. Declared here (before the top-level
// bootstrap block) so async functions invoked at module load can read them
// synchronously without tripping the temporal dead zone.
const TIMEOUT_RPC_MS = 15000;
const TIMEOUT_AUTH_MS = 15000;
const TIMEOUT_INVOKE_MS = 20000;

// -----------------------------------------------------------------------------
// Bootstrap
// -----------------------------------------------------------------------------

setDefaultStartTime();
applyDarkMode(localStorage.getItem(STORAGE_KEYS.darkMode) === "1");
attachEventListeners();
attachConnectivityListeners();
attachWakeRecovery();
bootstrapAuth();

// -----------------------------------------------------------------------------
// State helpers
// -----------------------------------------------------------------------------

function createCameraState() {
  return { isActive: false, mediaStream: null };
}

function getOrCreateDeviceInstallId() {
  const existing = localStorage.getItem(STORAGE_KEYS.deviceInstallId);
  if (existing) return existing;
  const created = crypto.randomUUID();
  localStorage.setItem(STORAGE_KEYS.deviceInstallId, created);
  return created;
}

function createSupabaseClient() {
  const config = window.ATTENDANCE_CONFIG || {};
  const url = config.supabaseUrl || localStorage.getItem("attendance.supabaseUrl");
  const key = config.supabaseAnonKey || localStorage.getItem("attendance.supabaseAnonKey");
  if (!url || !key || !window.supabase?.createClient) {
    return null;
  }
  return window.supabase.createClient(url, key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // Wrap the default `navigator.locks` lock with an AbortController so a
      // deadlocked lock (orphaned by a hard refresh, a crashed tab, or an OS
      // sleep that killed the refresh-token fetch) cannot wedge every
      // subsequent Supabase call. Falls through to fn() if the lock can't be
      // acquired in time — at worst, two same-browser tabs race a refresh and
      // one is bounced to login. Strictly better than an app-wide silent hang.
      lock: async (name, acquireTimeoutMs, fn) => {
        if (!globalThis.navigator?.locks?.request) return fn();
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), acquireTimeoutMs || 10000);
        try {
          return await navigator.locks.request(
            name,
            { mode: "exclusive", signal: ctrl.signal },
            fn,
          );
        } catch (err) {
          if (err?.name === "AbortError") return fn();
          throw err;
        } finally {
          clearTimeout(timer);
        }
      },
    },
  });
}

function syntheticEmail(passId, campus) {
  return `${String(passId).trim().toLowerCase()}@${String(campus).trim().toLowerCase()}.local`;
}

// Race a promise against a timeout. On timeout, reject with a user-facing
// message so a wedged Supabase call surfaces as a visible error instead of a
// silently hung UI. Used by rpc(), auth bootstrap, and admin functions.invoke().
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(
        `${label} timed out after ${Math.round(ms / 1000)}s. Network or session may be stalled — try reloading.`,
      )),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function rpc(name, params) {
  if (!state.supabase) {
    throw new Error("Supabase configuration is required.");
  }
  const { data, error } = await withTimeout(
    state.supabase.rpc(name, params ?? {}),
    TIMEOUT_RPC_MS,
    `rpc("${name}")`,
  );
  if (error) throw new Error(error.message);
  return data;
}

// -----------------------------------------------------------------------------
// Auth bootstrap
// -----------------------------------------------------------------------------

async function bootstrapAuth() {
  if (!state.supabase) {
    renderLoggedOut();
    els.loginStatus.textContent = "Supabase configuration is required. Add config.local.js locally or configure GitHub Pages to publish runtime config.";
    return;
  }
  let data, error;
  try {
    ({ data, error } = await withTimeout(
      state.supabase.auth.getSession(),
      TIMEOUT_AUTH_MS,
      "auth.getSession()",
    ));
  } catch (err) {
    renderLoggedOut();
    els.loginStatus.textContent = `${err.message} If this persists, reload the page.`;
    return;
  }
  if (error) {
    els.loginStatus.textContent = error.message;
  }
  if (data?.session) {
    await onAuthenticated();
  } else {
    renderLoggedOut();
  }

  state.supabase.auth.onAuthStateChange(async (event) => {
    if (event === "SIGNED_OUT") {
      renderLoggedOut();
    } else if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED" || event === "USER_UPDATED") {
      if (passwordChangeInProgress) return;
      // TOKEN_REFRESHED fires on every silent access-token rotation, which
      // happens on most tab wake-ups via the wake-recovery handler. The
      // profile data doesn't change just because the token rotated, so skip
      // the full onAuthenticated() re-render when a profile is already in
      // hand. This avoids a spurious logout when a wake-time RPC times out.
      if (event === "TOKEN_REFRESHED" && state.profile) return;
      await onAuthenticated();
    }
  });
}

// When the tab returns to the foreground after long idle, the access token may
// have expired and the OS may have killed the refresh-token socket. Nudge the
// Supabase client to refresh proactively so the user's next click doesn't hang
// for the watchdog timeout.
function attachWakeRecovery() {
  const nudge = async () => {
    if (!state.supabase || document.visibilityState !== "visible") return;
    try {
      await withTimeout(
        state.supabase.auth.getSession(),
        TIMEOUT_AUTH_MS,
        "auth.getSession() on wake",
      );
    } catch {
      // Swallow — the next user action will hit its own watchdog and surface
      // an error there. We don't want to spam the UI on every focus event.
    }
  };
  document.addEventListener("visibilitychange", nudge);
  window.addEventListener("focus", nudge);
}

async function onAuthenticated() {
  try {
    const profile = await rpc("get_current_login_profile", { p_device_install_id: state.deviceInstallId });
    if (!profile) {
      // Profile row is gone but the JWT is still valid — usually because a
      // destructive schema reapply dropped public.profiles while leaving
      // auth.users intact. Tear down the in-app state cleanly (handleLogout
      // signs out + clears local storage + calls renderLoggedOut, which
      // hides every zone and opens the login modal).
      els.loginStatus.textContent = "Your account is no longer active. Please sign in again.";
      await handleLogout();
      return;
    }
    state.profile = profile;
    if (profile.archived_at) {
      els.loginStatus.textContent = "This account has been archived. Please contact your administrator.";
      try {
        await withTimeout(state.supabase.auth.signOut(), TIMEOUT_AUTH_MS, "auth.signOut()");
      } catch (err) {
        console.warn("[auth] signOut error (continuing):", err);
      }
      return;
    }
    if (profile.needs_password_change) {
      if (!justSignedIn) {
        // Cached-session resume of an unclaimed account. Auto-resuming
        // would let the next person at this device step straight into the
        // previous user's mid-claim flow. Sign out and require an explicit
        // login.
        els.loginStatus.textContent = "Sign in to continue.";
        await handleLogout();
        return;
      }
      justSignedIn = false;
      forcedPasswordChange = true;
      openPasswordDialog({
        title: "Set a new password",
        intro: "You're using a temporary password. Set a new one to continue.",
        force: true,
      });
      return;
    }
    justSignedIn = false;
    forcedPasswordChange = false;
    renderLoggedIn(profile);
    subscribeNotifications(profile);
    subscribeSessionsBroadcast();
    if (profile.role === "admin" && window.AttendanceAdmin?.mount) {
      window.AttendanceAdmin.mount({
        supabase: state.supabase,
        profile,
        rpc,
        mountEl: els.adminMount,
      });
    }
    // Note: latest session is NOT auto-restored on login/refresh.
    // The user must click "Restore latest" explicitly.
  } catch (err) {
    // Two paths reach this catch with very different recovery semantics:
    //
    //   - Initial bootstrap (no state.profile yet): UI is in its hidden
    //     initial state. Without renderLoggedOut() the login modal never
    //     opens and the page is blank. Common trigger on the deployed
    //     site: a stale JWT for an auth.users row that was wiped by a
    //     schema reapply or cleanup sweep.
    //
    //   - Tab wake / TOKEN_REFRESHED (state.profile already set): the
    //     session is still legitimate; a transient RPC error here is not
    //     a logout signal. Surface the message but preserve the UI.
    if (!state.profile) {
      renderLoggedOut();
    }
    els.loginStatus.textContent = err.message;
  }
}

function renderLoggedOut() {
  state.profile = null;
  state.latestSession = null;
  pendingSessionPayload = null;
  forcedPasswordChange = false;
  justSignedIn = false;
  if (state.notificationsChannel) {
    state.supabase.removeChannel(state.notificationsChannel);
    state.notificationsChannel = null;
  }
  if (state.sessionsChannel) {
    state.supabase.removeChannel(state.sessionsChannel);
    state.sessionsChannel = null;
  }
  els.settingsToggle.hidden = true;
  els.attendanceLoginStatus.textContent = "Not logged in";
  els.passId.value = "";
  els.password.value = "";
  els.loginCampus.value = localStorage.getItem(STORAGE_KEYS.lastCampus) ?? "";
  els.loginStatus.textContent = "Sign in with your pass ID.";
  els.fullscreenQr.disabled = true;
  els.refreshAttendeeTotal.disabled = true;
  els.exportCsv.disabled = true;
  els.attendeeTotal.textContent = "Total attendees: 0";
  els.sessionStatus.textContent = "";
  els.sessionSummary.textContent = "No session generated yet. Use the form above or click \"Restore latest\".";
  els.attendanceZone.hidden = true;
  els.geofenceZone.hidden = true;
  els.sessionZone.hidden = true;
  resetOpenSessionsList();
  if (window.AttendanceAdmin?.unmount) window.AttendanceAdmin.unmount();
  clearBarcodeDisplay();
  closeIfOpen(els.passwordDialog);
  closeIfOpen(els.settingsDialog);
  if (!els.loginDialog.open) els.loginDialog.showModal();
}

function renderLoggedIn(profile) {
  closeIfOpen(els.loginDialog);
  els.settingsToggle.hidden = false;
  els.passId.value = profile.pass_id ?? "";
  els.password.value = "";
  els.attendanceZone.hidden = false;
  els.geofenceZone.hidden = false;
  // Hide the Generate-Session card entirely for the plain `user` role.
  // Server-side `create_attendance_session` still rejects unauthorised
  // creators as a backstop.
  els.sessionZone.hidden = profile.role === "user";
  els.attendanceLoginStatus.textContent = profile.pass_id ?? profile.profile_id;
  applySessionScopeDefaults(profile);
}

// Pre-fill and gate the scope fields based on the caller's role. Global admins
// (role=admin AND admin_campus_scope IS NULL) get fully editable fields (campus
// may be cleared for cross-campus sessions). Everyone else is pinned to their
// own campus; representatives and coordinators are additionally pinned to their
// own group and sub-group. The server enforces all of this — these client
// settings are UX scaffolding so the operator can't accidentally enter values
// the server will reject.
function applySessionScopeDefaults(profile) {
  if (!els.sessionScopeCampus) return;
  const isGlobalAdmin = profile.role === "admin" && profile.admin_campus_scope == null;
  const isCampusAdmin = profile.role === "admin" && profile.admin_campus_scope != null;
  const pinnedCampus = isCampusAdmin ? profile.admin_campus_scope : profile.campus;
  els.sessionScopeCampus.value = pinnedCampus ?? "";
  els.sessionScopeCampus.readOnly = !isGlobalAdmin;
  if (isGlobalAdmin || profile.role === "admin") {
    // Admins (global or per-campus) may scope anywhere in their campus.
    els.sessionScopeGroup.value = "";
    els.sessionScopeGroup.readOnly = false;
    els.sessionScopeSubgroup.value = "";
    els.sessionScopeSubgroup.readOnly = false;
  } else {
    // Representatives and coordinators are pinned to their own group/sub_group.
    els.sessionScopeGroup.value = profile.group_name ?? "";
    els.sessionScopeGroup.readOnly = true;
    els.sessionScopeSubgroup.value = profile.sub_group ?? "";
    els.sessionScopeSubgroup.readOnly = true;
  }
  syncSessionScopeSubgroupEnabled();
}

function syncSessionScopeSubgroupEnabled() {
  if (!els.sessionScopeGroup || !els.sessionScopeSubgroup) return;
  const hasGroup = els.sessionScopeGroup.value.trim() !== "";
  // Keep readonly pinning intact for non-admins — only toggle the enabled state
  // when the field is editable (admins clearing the group blanks the sub-group).
  if (els.sessionScopeSubgroup.readOnly) return;
  els.sessionScopeSubgroup.disabled = !hasGroup;
  if (!hasGroup) els.sessionScopeSubgroup.value = "";
}

function closeIfOpen(dialogEl) {
  if (dialogEl?.open) dialogEl.close();
}

// Disable a button while an async handler runs and for at least 3 s after
// the click — whichever takes longer. Spam-protection for DB-touching
// buttons (Restore latest, Refresh attendee total, Export CSV, etc.). Apply
// at attach time via `bindCooldown(button, fn)`.
const BUTTON_COOLDOWN_MS = 3000;
async function withCooldown(button, fn) {
  if (!button || button.disabled) return;
  button.disabled = true;
  const start = performance.now();
  try {
    await fn();
  } finally {
    const elapsed = performance.now() - start;
    const remaining = Math.max(0, BUTTON_COOLDOWN_MS - elapsed);
    setTimeout(() => { button.disabled = false; }, remaining);
  }
}
function bindCooldown(button, fn) {
  button.addEventListener("click", () => withCooldown(button, fn));
}

function resetOpenSessionsList() {
  if (!els.openSessionsList) return;
  els.openSessionsList.innerHTML = "";
  const li = document.createElement("li");
  li.className = "open-sessions-empty";
  li.textContent = "Tap Refresh to load open sessions for your group.";
  els.openSessionsList.append(li);
  if (els.geofenceStatus) els.geofenceStatus.textContent = "";
}

// -----------------------------------------------------------------------------
// Listeners
// -----------------------------------------------------------------------------

function attachEventListeners() {
  els.attendanceCameraToggle.addEventListener("click", () =>
    toggleCamera(state.attendanceCamera, els.attendanceCamera, els.attendanceCameraToggle, els.attendanceScan, els.attendanceStatus),
  );
  els.attendanceScan.addEventListener("click", handleAttendanceScan);
  els.sessionForm.addEventListener("submit", handleSessionCreate);
  els.sessionScopeGroup.addEventListener("input", syncSessionScopeSubgroupEnabled);
  bindCooldown(els.restoreSession, restoreLatestSession);
  els.fullscreenQr.addEventListener("click", openFullscreenQr);
  bindCooldown(els.refreshAttendeeTotal, refreshAttendeeTotal);
  bindCooldown(els.exportCsv, handleCsvExport);
  bindCooldown(els.refreshOpenSessions, refreshOpenSessions);
  els.loginForm.addEventListener("submit", handleAuthSubmit);
  bindPasswordCharacterPolicy(els.password);
  els.passwordVisibilityToggle.addEventListener("click", () =>
    toggleFieldVisibility(els.password, els.passwordVisibilityToggle),
  );
  // Login dialog is non-dismissable: Esc fires `cancel`, we suppress it.
  els.loginDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
  });
  els.settingsLogout.addEventListener("click", handleLogout);
  // Per-field show/hide toggles in the change-password modal.
  els.passwordOldToggle.addEventListener("click", () =>
    toggleFieldVisibility(els.passwordOld, els.passwordOldToggle),
  );
  els.passwordNewToggle.addEventListener("click", () =>
    toggleFieldVisibility(els.passwordNew, els.passwordNewToggle),
  );
  els.passwordConfirmToggle.addEventListener("click", () =>
    toggleFieldVisibility(els.passwordConfirm, els.passwordConfirmToggle),
  );
  [els.passwordOld, els.passwordNew, els.passwordConfirm].forEach((input) => {
    bindPasswordCharacterPolicy(input);
    input.addEventListener("input", syncPasswordCustomValidity);
  });
  els.confirmSubmit.addEventListener("click", (event) => {
    event.preventDefault();
    submitPendingAttendance();
  });
  els.cancelSubmit.addEventListener("click", () => {
    pendingSessionPayload = null;
  });
  els.settingsToggle.addEventListener("click", () => els.settingsDialog.showModal());
  els.settingsClose.addEventListener("click", () => els.settingsDialog.close());
  els.darkModeToggle.addEventListener("change", (e) => {
    applyDarkMode(e.target.checked);
    localStorage.setItem(STORAGE_KEYS.darkMode, e.target.checked ? "1" : "0");
  });
  els.darkModeToggle.checked = document.body.classList.contains("dark");
  els.settingsChangePassword.addEventListener("click", () => {
    els.settingsDialog.close();
    openPasswordDialog({
      title: "Change password",
      intro: "Enter your current password and a new one.",
      force: false,
    });
  });
  els.passwordCancel.addEventListener("click", () => {
    if (forcedPasswordChange) {
      // User declined the forced change; sign them out so the app stays gated.
      state.supabase.auth.signOut();
    }
    closePasswordDialog();
  });
  // Esc dismissal: during a forced change, treat as "Sign out" rather than
  // letting the modal close silently and leave the app in a stuck state.
  els.passwordDialog.addEventListener("cancel", (event) => {
    if (forcedPasswordChange) {
      event.preventDefault();
      state.supabase.auth.signOut();
    }
  });
  els.passwordForm.addEventListener("submit", (event) => {
    event.preventDefault();
    handlePasswordSubmit();
  });
  els.qrFullscreenClose.addEventListener("click", () => els.qrFullscreenDialog.close());
}

function attachConnectivityListeners() {
  const update = () => {
    els.connectivityBanner.hidden = navigator.onLine;
  };
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  update();
}

function applyDarkMode(on) {
  document.body.classList.toggle("dark", !!on);
  if (els.darkModeToggle) els.darkModeToggle.checked = !!on;
}

// -----------------------------------------------------------------------------
// Auth handlers
// -----------------------------------------------------------------------------

async function handleAuthSubmit(event) {
  event.preventDefault();
  if (!state.supabase) {
    els.loginStatus.textContent = "Supabase configuration is required.";
    return;
  }
  const campus = els.loginCampus.value.trim().toUpperCase();
  const passId = els.passId.value.trim().toUpperCase();
  const password = els.password.value;
  if (!campus) {
    els.loginStatus.textContent = "Enter your campus code.";
    return;
  }
  if (!CONFIG.CAMPUS_REGEX.test(campus)) {
    els.loginStatus.textContent = "Enter a valid campus code.";
    return;
  }
  if (!CONFIG.PASS_ID_REGEX.test(passId)) {
    els.loginStatus.textContent = "Enter a valid pass ID.";
    return;
  }
  if (!password) {
    els.loginStatus.textContent = "Enter your password.";
    return;
  }
  localStorage.setItem(STORAGE_KEYS.lastCampus, campus);
  els.loginStatus.textContent = "Signing in...";
  // Set BEFORE awaiting signInWithPassword: Supabase fires its SIGNED_IN
  // callback synchronously from inside signInWithPassword, so the
  // onAuthenticated handler runs before the await ever resolves. Setting
  // the flag after would mean onAuthenticated sees justSignedIn=false and
  // (for unclaimed profiles) bounces the user straight back to the login
  // modal. Cleared on failure paths below so a wrong-password attempt
  // doesn't leak the flag into a later cached-session resume.
  justSignedIn = true;
  let error;
  try {
    ({ error } = await withTimeout(
      state.supabase.auth.signInWithPassword({
        email: syntheticEmail(passId, campus),
        password,
      }),
      TIMEOUT_AUTH_MS,
      "signInWithPassword",
    ));
  } catch (err) {
    justSignedIn = false;
    els.loginStatus.textContent = err.message;
    return;
  }
  if (error) {
    justSignedIn = false;
    els.loginStatus.textContent = "Pass ID or password is incorrect.";
    return;
  }
  // onAuthStateChange will fire and run onAuthenticated().
}

async function handleLogout() {
  closeIfOpen(els.settingsDialog);
  // Local scope: revoke only this client's session. Avoids the failure mode
  // where a stale access token (e.g. after a destructive schema reapply)
  // makes a global signOut throw and never emit SIGNED_OUT.
  try {
    await withTimeout(
      state.supabase.auth.signOut({ scope: "local" }),
      TIMEOUT_AUTH_MS,
      "auth.signOut()",
    );
  } catch (err) {
    console.warn("[auth] signOut error (continuing):", err);
  }
  // Drop app-local non-auth state. (Supabase's own keys are cleared by signOut.)
  for (const key of Object.values(STORAGE_KEYS)) {
    if (key === STORAGE_KEYS.deviceInstallId) continue; // keep device id stable
    if (key === STORAGE_KEYS.darkMode) continue;        // user UI preference
    localStorage.removeItem(key);
  }
  // Force the logged-out UI even if SIGNED_OUT didn't fire.
  renderLoggedOut();
}

function toggleFieldVisibility(inputEl, toggleBtn) {
  const isVisible = inputEl.type === "text";
  inputEl.type = isVisible ? "password" : "text";
  toggleBtn.textContent = isVisible ? "Show" : "Hide";
  toggleBtn.setAttribute("aria-pressed", String(!isVisible));
}

function bindPasswordCharacterPolicy(inputEl) {
  if (!inputEl) return;
  inputEl.addEventListener("beforeinput", (event) => {
    if (!event.data || CONFIG.PASSWORD_ALLOWED_CHARS_REGEX.test(event.data)) {
      return;
    }
    event.preventDefault();
    inputEl.setCustomValidity(CONFIG.PASSWORD_UNSUPPORTED_MESSAGE);
    inputEl.reportValidity();
  });
  inputEl.addEventListener("paste", (event) => {
    const pasted = event.clipboardData?.getData("text") ?? "";
    if (CONFIG.PASSWORD_ALLOWED_CHARS_REGEX.test(pasted)) return;
    event.preventDefault();
    inputEl.setCustomValidity(CONFIG.PASSWORD_UNSUPPORTED_MESSAGE);
    inputEl.reportValidity();
  });
  inputEl.addEventListener("input", () => {
    if (CONFIG.PASSWORD_ALLOWED_CHARS_REGEX.test(inputEl.value)) {
      inputEl.setCustomValidity("");
    }
  });
}

// -----------------------------------------------------------------------------
// Password change modal
// -----------------------------------------------------------------------------

function openPasswordDialog({ title, intro, force }) {
  els.passwordDialogTitle.textContent = title;
  els.passwordDialogIntro.textContent = intro;
  els.passwordOld.value = "";
  els.passwordNew.value = "";
  els.passwordConfirm.value = "";
  els.passwordDialogValidation.textContent = "";
  syncPasswordCustomValidity();
  els.passwordCancel.textContent = force ? "Sign out" : "Cancel";
  els.passwordDialog.showModal();
}

function closePasswordDialog() {
  els.passwordDialog.close();
}

async function handlePasswordSubmit() {
  syncPasswordCustomValidity();
  if (!els.passwordForm.reportValidity()) return;

  const oldPassword = els.passwordOld.value;
  const newPassword = els.passwordNew.value;
  const confirmPassword = els.passwordConfirm.value;
  if (!CONFIG.PASSWORD_REGEX.test(newPassword)) {
    els.passwordDialogValidation.textContent = CONFIG.PASSWORD_ALLOWED_MESSAGE;
    return;
  }

  const passId = state.profile?.pass_id || els.passId.value.trim().toUpperCase();
  const campus = state.profile?.campus;
  if (!passId || !campus) {
    els.passwordDialogValidation.textContent = "Pass ID unknown — please log in again.";
    return;
  }

  passwordChangeInProgress = true;
  try {
    // Verify old password by re-authenticating. signInWithPassword refreshes
    // the session on success and yields a clear error on failure, without
    // requiring a separate "verify only" RPC.
    let reauthErr;
    try {
      ({ error: reauthErr } = await withTimeout(
        state.supabase.auth.signInWithPassword({
          email: syntheticEmail(passId, campus),
          password: oldPassword,
        }),
        TIMEOUT_AUTH_MS,
        "signInWithPassword (re-auth)",
      ));
    } catch (err) {
      els.passwordDialogValidation.textContent = err.message;
      return;
    }
    if (reauthErr) {
      els.passwordDialogValidation.textContent = "Current password is incorrect.";
      return;
    }

    let updateErr;
    try {
      ({ error: updateErr } = await withTimeout(
        state.supabase.auth.updateUser({ password: newPassword }),
        TIMEOUT_AUTH_MS,
        "auth.updateUser",
      ));
    } catch (err) {
      els.passwordDialogValidation.textContent = err.message;
      return;
    }
    if (updateErr) {
      els.passwordDialogValidation.textContent = updateErr.message;
      return;
    }

    try {
      await rpc("mark_password_set");
    } catch (err) {
      els.passwordDialogValidation.textContent = err.message;
      return;
    }

    closePasswordDialog();
    forcedPasswordChange = false;
    showToast("Password changed.");
  } finally {
    passwordChangeInProgress = false;
  }
  // Refresh profile + render after the guard is released so the resulting
  // render reflects the post-change profile.
  await onAuthenticated();
}

function syncPasswordCustomValidity() {
  if (!els.passwordOld || !els.passwordNew || !els.passwordConfirm) return;
  for (const input of [els.passwordOld, els.passwordNew, els.passwordConfirm]) {
    input.setCustomValidity("");
    if (!CONFIG.PASSWORD_ALLOWED_CHARS_REGEX.test(input.value)) {
      input.setCustomValidity(CONFIG.PASSWORD_UNSUPPORTED_MESSAGE);
    }
  }
  if (
    els.passwordConfirm.value &&
    els.passwordNew.value !== els.passwordConfirm.value
  ) {
    els.passwordConfirm.setCustomValidity("New password and confirmation do not match.");
    return;
  }
  if (
    els.passwordOld.value &&
    els.passwordNew.value &&
    els.passwordOld.value === els.passwordNew.value
  ) {
    els.passwordNew.setCustomValidity("New password must be different from current password.");
  }
}

// -----------------------------------------------------------------------------
// Toast
// -----------------------------------------------------------------------------

function showToast(message, durationMs = 3000) {
  const el = document.createElement("div");
  el.className = "toast";
  el.role = "status";
  el.textContent = message;
  els.toastHost.append(el);
  // Trigger transition: rAF so the initial opacity:0 is committed first.
  requestAnimationFrame(() => el.classList.add("toast-visible"));
  setTimeout(() => {
    el.classList.remove("toast-visible");
    setTimeout(() => el.remove(), 400);
  }, durationMs);
}

// -----------------------------------------------------------------------------
// Notifications
// -----------------------------------------------------------------------------

async function subscribeNotifications(profile) {
  if (state.notificationsChannel) {
    state.supabase.removeChannel(state.notificationsChannel);
    state.notificationsChannel = null;
  }
  await refreshNotifications();
  // Single channel covers both live notifications and force-logout on revoke.
  // RLS handles scope filtering for notifications; the profile filter scopes
  // the revoke event to this user only. Default REPLICA IDENTITY is sufficient
  // because we only need new_record.archived_at to know the user was archived.
  state.notificationsChannel = state.supabase
    .channel(`user-events-${profile.profile_id}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "notifications" },
      () => refreshNotifications(),
    )
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "notifications" },
      () => refreshNotifications(),
    )
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "profiles",
        filter: `profile_id=eq.${profile.profile_id}`,
      },
      (payload) => handleProfileUpdate(payload),
    )
    .on(
      "postgres_changes",
      {
        // Revoke now cascade-deletes the profile (auth.users → profiles
        // ON DELETE CASCADE). The DELETE event is the only signal the
        // client gets that the account is gone, so handle it explicitly.
        event: "DELETE",
        schema: "public",
        table: "profiles",
        filter: `profile_id=eq.${profile.profile_id}`,
      },
      () => handleProfileDelete(),
    )
    .subscribe();
}

// Live updates for the open-sessions list. A Postgres trigger on
// attendance_sessions fires realtime.send on the `sessions:open` topic for any
// INSERT/UPDATE/DELETE. We subscribe here and refetch via the scope-aware RPC
// when the geofence panel is visible. Channels are multiplexed over the same
// websocket as notificationsChannel, so this does not add a concurrent
// connection on the Supabase free tier.
function subscribeSessionsBroadcast() {
  if (state.sessionsChannel) {
    state.supabase.removeChannel(state.sessionsChannel);
    state.sessionsChannel = null;
  }
  state.sessionsChannel = state.supabase
    .channel("sessions:open")
    .on("broadcast", { event: "sessions_changed" }, () => {
      if (!els.geofenceZone?.hidden) refreshOpenSessions();
    })
    .subscribe();
}

async function handleProfileDelete() {
  showToast("This account has been revoked. Signing you out.");
  await handleLogout();
  els.loginStatus.textContent = "This account has been revoked. Please contact your administrator.";
}

async function handleProfileUpdate(payload) {
  const archivedAt = payload?.new?.archived_at;
  if (archivedAt) {
    // Account was revoked. Surface a brief notice, then force-logout. The
    // server has already deleted auth.users for this profile in the revoke
    // Edge Function, so any subsequent API call would 401 anyway; this just
    // makes the UI react immediately instead of waiting for the next request.
    showToast("This account has been revoked. Signing you out.");
    await handleLogout();
    els.loginStatus.textContent = "This account has been revoked. Please contact your administrator.";
    return;
  }

  // Admin reset this account's password back to today's temp. Detect via the
  // password_set_at → NULL transition. Discriminator on our side is
  // state.profile.needs_password_change: get_current_login_profile only
  // exposes the boolean, not the raw timestamp, so we use it to confirm the
  // locally-cached profile thinks the password *was* set (false) — i.e.
  // this is a transition, not the user's initial unclaimed sign-in.
  const newPasswordSetAt = payload?.new?.password_set_at;
  if (newPasswordSetAt === null && state.profile?.needs_password_change === false) {
    showToast("Your password has been reset. Signing you out.");
    await handleLogout();
    els.loginStatus.textContent = "Your password was reset by an administrator. Sign in with today's daily temp.";
  }
}

async function refreshNotifications() {
  let data, error;
  try {
    ({ data, error } = await withTimeout(
      state.supabase
        .from("notifications")
        .select("id, title, body, link_url, pinned, created_at, expires_at")
        .order("pinned", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(50),
      TIMEOUT_RPC_MS,
      "notifications.select",
    ));
  } catch (err) {
    console.warn("[notifications]", err.message);
    state.notifications = [];
    renderNotifications();
    return;
  }
  if (error) {
    state.notifications = [];
  } else {
    state.notifications = data ?? [];
  }
  renderNotifications();
}

function renderNotifications() {
  if (!els.notificationsList) return;
  els.notificationsList.innerHTML = "";
  if (state.notifications.length === 0) {
    const li = document.createElement("li");
    li.className = "notifications-empty";
    li.textContent = "No notifications.";
    els.notificationsList.append(li);
    return;
  }
  for (const n of state.notifications) {
    const li = document.createElement("li");
    li.className = "notification-item" + (n.pinned ? " is-pinned" : "");
    const title = document.createElement("strong");
    title.textContent = n.title;
    const body = document.createElement("p");
    body.textContent = n.body;
    li.append(title, body);
    const safeHref = sanitiseLinkUrl(n.link_url);
    if (safeHref) {
      const link = document.createElement("a");
      link.href = safeHref;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = safeHref;
      li.append(link);
    }
    const meta = document.createElement("span");
    meta.className = "notification-meta";
    meta.textContent = new Date(n.created_at).toLocaleString();
    li.append(meta);
    els.notificationsList.append(li);
  }
}

// -----------------------------------------------------------------------------
// Camera & scanning
// -----------------------------------------------------------------------------

async function toggleCamera(cameraState, video, toggleButton, scanButton, statusElement) {
  try {
    if (!cameraState.isActive) {
      cameraState.mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      video.srcObject = cameraState.mediaStream;
      await video.play();
      cameraState.isActive = true;
      toggleButton.textContent = "Stop camera";
      scanButton.disabled = false;
      statusElement.textContent = "Camera is active.";
    } else {
      stopCamera(cameraState, video);
      toggleButton.textContent = "Start camera";
      scanButton.disabled = true;
      statusElement.textContent = "Camera stopped.";
    }
  } catch (error) {
    statusElement.textContent = error.message || "Error accessing camera.";
    scanButton.disabled = true;
  }
}

function stopCamera(cameraState, video) {
  cameraState.mediaStream?.getTracks().forEach((t) => t.stop());
  cameraState.mediaStream = null;
  cameraState.isActive = false;
  video.srcObject = null;
}

async function handleAttendanceScan() {
  if (!requireLogin(els.attendanceStatus)) return;
  try {
    const scanned = await scanBarcodeFromVideo(els.attendanceCamera);
    const payload = parseSessionPayload(scanned);
    pendingSessionPayload = payload;
    els.confirmSessionName.textContent = payload.session_name;
    els.confirmDialog.showModal();
  } catch (error) {
    els.attendanceStatus.textContent = error.message;
  }
}

async function submitPendingAttendance() {
  if (!pendingSessionPayload) return;
  const payload = pendingSessionPayload;
  pendingSessionPayload = null;
  els.confirmDialog.close();

  els.attendanceScan.disabled = true;
  try {
    els.attendanceStatus.textContent = "Getting submitter location...";
    const position = await getDeviceLocation();
    els.attendanceStatus.textContent = "Submitting attendance...";
    const result = await rpc("submit_attendance", {
      p_session_payload: payload,
      p_device_install_id: state.deviceInstallId,
      p_submitter_lat: roundCoordinate(position.coords.latitude),
      p_submitter_lon: roundCoordinate(position.coords.longitude),
    });
    const flags = result.flags?.length ? ` Flags: ${result.flags.join(", ")}.` : "";
    els.attendanceStatus.textContent = `Submitted attendance for ${payload.session_name}. Status: ${result.status || "accepted"}.${flags}`;
  } catch (error) {
    els.attendanceStatus.textContent = error.message || "Attendance submission failed.";
  } finally {
    els.attendanceScan.disabled = !state.attendanceCamera.isActive;
  }
}

// -----------------------------------------------------------------------------
// Session creation
// -----------------------------------------------------------------------------

async function handleSessionCreate(event) {
  event.preventDefault();
  if (!requireLogin(els.sessionStatus)) return;

  const intendedStart = toIsoFromDateAndTime(els.sessionDate.value, els.sessionTime.value);
  if (!intendedStart) {
    els.sessionStatus.textContent = "Choose an intended start date and time.";
    return;
  }

  const allowQr = els.modeQr.checked;
  const allowGeofence = els.modeGeofence.checked;
  if (!allowQr && !allowGeofence) {
    els.sessionStatus.textContent = "Select at least one check-in mode.";
    return;
  }

  const scopeCampus = els.sessionScopeCampus.value.trim() || null;
  const scopeGroup = els.sessionScopeGroup.value.trim() || null;
  const scopeSubgroup = els.sessionScopeSubgroup.value.trim() || null;
  if (scopeSubgroup && !scopeGroup) {
    els.sessionStatus.textContent = "Sub-group scope requires a group scope.";
    return;
  }
  if (scopeGroup && !scopeCampus) {
    els.sessionStatus.textContent = "Group scope requires a campus scope.";
    return;
  }
  if (allowGeofence && !scopeCampus) {
    els.sessionStatus.textContent = "Campus-grounds mode requires a campus scope.";
    return;
  }

  const submitBtn = event.submitter ?? document.getElementById("generate-session");
  submitBtn.disabled = true;
  try {
    els.sessionStatus.textContent = "Getting creator location...";
    const position = await getDeviceLocation();
    els.sessionStatus.textContent = allowQr ? "Generating QR code..." : "Creating session...";
    const payload = await rpc("create_attendance_session", {
      p_code: crypto.randomUUID(),
      p_name: els.sessionName.value.trim(),
      p_intended_start_at: intendedStart,
      p_grace_period_minutes: Number(els.gracePeriod.value),
      p_creator_lat: roundCoordinate(position.coords.latitude),
      p_creator_lon: roundCoordinate(position.coords.longitude),
      p_device_install_id: state.deviceInstallId,
      p_allow_qr: allowQr,
      p_allow_geofence: allowGeofence,
      p_scope_campus: scopeCampus,
      p_scope_group_name: scopeGroup,
      p_scope_sub_group: scopeSubgroup,
    });

    state.latestSession = payload;
    localStorage.setItem(STORAGE_KEYS.latestCreatorSession, JSON.stringify(payload));
    if (allowQr) {
      await renderSessionQr(payload);
      els.fullscreenQr.disabled = false;
    } else {
      clearBarcodeDisplay();
      els.fullscreenQr.disabled = true;
    }
    renderSessionSummary(payload);
    els.exportCsv.disabled = false;
    els.refreshAttendeeTotal.disabled = false;
    els.sessionStatus.textContent = allowQr
      ? "Session QR generated."
      : "Campus-grounds session opened. Attendees can find it under Check in.";
    await refreshAttendeeTotal();
  } catch (error) {
    els.sessionStatus.textContent = error.message || "Could not create session.";
  } finally {
    submitBtn.disabled = false;
  }
}

// -----------------------------------------------------------------------------
// Campus-grounds (geofence) check-in
// -----------------------------------------------------------------------------

async function refreshOpenSessions() {
  if (!requireLogin(els.geofenceStatus)) return;
  els.geofenceStatus.textContent = "Loading open sessions...";
  let rows;
  try {
    rows = await rpc("list_open_geofence_sessions");
  } catch (err) {
    els.geofenceStatus.textContent = err.message || "Could not load open sessions.";
    return;
  }
  els.openSessionsList.innerHTML = "";
  if (!rows || rows.length === 0) {
    const li = document.createElement("li");
    li.className = "open-sessions-empty";
    li.textContent = "No open campus-grounds sessions for your group.";
    els.openSessionsList.append(li);
    els.geofenceStatus.textContent = "";
    return;
  }
  for (const row of rows) {
    const li = document.createElement("li");
    li.className = "open-session-item";
    const meta = document.createElement("div");
    meta.className = "open-session-meta";
    const title = document.createElement("strong");
    title.textContent = row.session_name;
    const sub = document.createElement("span");
    const startedAt = row.intended_start_at
      ? new Date(row.intended_start_at).toLocaleString()
      : "";
    sub.textContent = `${row.creator_pass_id ?? ""} · ${startedAt}`.trim();
    meta.append(title, sub);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Check in";
    btn.dataset.sessionId = row.session_id;
    bindCooldown(btn, () => handleGeofenceCheckIn(row, btn));
    li.append(meta, btn);
    els.openSessionsList.append(li);
  }
  els.geofenceStatus.textContent = `${rows.length} open session${rows.length === 1 ? "" : "s"}.`;
}

async function handleGeofenceCheckIn(row, btn) {
  if (!requireLogin(els.geofenceStatus)) return;
  els.geofenceStatus.textContent = "Getting your location...";
  let position;
  try {
    position = await getDeviceLocation();
  } catch (err) {
    els.geofenceStatus.textContent = err.message || "Could not get location.";
    return;
  }
  els.geofenceStatus.textContent = "Submitting...";
  try {
    const result = await rpc("submit_geofence_attendance", {
      p_session_id: row.session_id,
      p_device_install_id: state.deviceInstallId,
      p_submitter_lat: roundCoordinate(position.coords.latitude),
      p_submitter_lon: roundCoordinate(position.coords.longitude),
    });
    const flagsNote = Array.isArray(result?.flags) && result.flags.length > 0
      ? ` (flags: ${result.flags.join(", ")})`
      : "";
    els.geofenceStatus.textContent = `Checked in to "${row.session_name}".${flagsNote}`;
    if (btn) btn.textContent = "Checked in";
  } catch (err) {
    els.geofenceStatus.textContent = err.message || "Check-in failed.";
  }
}

async function restoreLatestSession() {
  if (!state.profile) return;
  if (!["representative", "coordinator", "admin"].includes(state.profile.role)) return;

  try {
    const payload = await rpc("get_latest_active_session_qr_for_creator", {
      p_device_install_id: state.deviceInstallId,
    });
    if (!payload) return;
    state.latestSession = payload;
    await renderSessionQr(payload);
    renderSessionSummary(payload);
    els.fullscreenQr.disabled = false;
    els.exportCsv.disabled = false;
    els.refreshAttendeeTotal.disabled = false;
    els.sessionStatus.textContent = "Latest active session QR restored.";
    await refreshAttendeeTotal();
  } catch (error) {
    els.sessionStatus.textContent = error.message;
  }
}

async function refreshAttendeeTotal() {
  if (!requireLogin(els.sessionStatus)) return;
  if (!state.latestSession) {
    els.attendeeTotal.textContent = "Total attendees: 0";
    return;
  }
  try {
    const rows = await rpc("view_session_attendance", { p_session_id: state.latestSession.session_id });
    const canonical = new Set((rows || []).filter((r) => r.canonical).map((r) => r.pass_id));
    els.attendeeTotal.textContent = `Total attendees: ${canonical.size}`;
  } catch (error) {
    els.sessionStatus.textContent = error.message || "Could not refresh attendee total.";
  }
}

async function handleCsvExport() {
  if (!requireLogin(els.sessionStatus)) return;
  if (!state.latestSession) return;
  try {
    const csv = await rpc("export_canonical_attendance_csv", {
      p_session_id: state.latestSession.session_id,
    });
    downloadText(`${state.latestSession.session_code}-canonical-attendance.csv`, csv, "text/csv");
    els.sessionStatus.textContent = "Canonical attendance CSV exported.";
  } catch (error) {
    els.sessionStatus.textContent = error.message || "CSV export failed.";
  }
}

// -----------------------------------------------------------------------------
// QR rendering & full-screen poster
// -----------------------------------------------------------------------------

async function renderSessionQr(payload) {
  await renderBarcodeToCanvas(JSON.stringify(payload), els.sessionQr, els.barcodeFormat.value);
}

async function renderBarcodeToCanvas(payloadText, canvas, format) {
  const writeOutput = await writeBarcodeWithBestSize(payloadText, format);
  const imageBitmap = await createImageBitmap(writeOutput.image);
  const displaySize = Math.max(canvas.clientWidth || 320, 260);
  canvas.width = displaySize;
  canvas.height = displaySize;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const scale = Math.min(canvas.width / imageBitmap.width, canvas.height / imageBitmap.height);
  const w = imageBitmap.width * scale;
  const h = imageBitmap.height * scale;
  ctx.drawImage(imageBitmap, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
  imageBitmap.close();
}

async function writeBarcodeWithBestSize(payloadText, format) {
  if (format === CONFIG.BARCODE_FORMATS.QR_CODE) {
    let lastError = null;
    for (let v = CONFIG.QR_MIN_VERSION; v <= CONFIG.QR_MAX_VERSION; v++) {
      try {
        const out = await ZXingWASM.writeBarcode(payloadText, {
          format,
          scale: 4,
          withQuietZones: true,
          ecLevel: CONFIG.QR_ERROR_CORRECTION,
          options: `version=${v},dataMask=${CONFIG.QR_MASK_PATTERN}`,
        });
        if (out.image) return out;
        lastError = new Error(out.error || `QR version ${v} failed.`);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error("QR payload is too large.");
  }
  const out = await ZXingWASM.writeBarcode(payloadText, { format, scale: 4, withQuietZones: true });
  if (!out.image) throw new Error(out.error || "Barcode generation failed.");
  return out;
}

async function openFullscreenQr() {
  if (!state.latestSession) return;
  els.qrFullscreenCaption.textContent = state.latestSession.session_name;
  els.qrFullscreenDialog.showModal();
  await renderBarcodeToCanvas(
    JSON.stringify(state.latestSession),
    els.qrFullscreenCanvas,
    els.barcodeFormat.value,
  );
}

function renderSessionSummary(payload) {
  els.sessionSummary.innerHTML = `
    <dl>
      <div><dt>Name</dt><dd>${escapeHtml(payload.session_name)}</dd></div>
      <div><dt>Start</dt><dd>${new Date(payload.intended_start_at).toLocaleString()}</dd></div>
      <div><dt>Grace</dt><dd>${formatGracePeriod(payload.grace_period_minutes)}</dd></div>
      <div><dt>Location</dt><dd>${Number(payload.creator_lat).toFixed(5)}, ${Number(payload.creator_lon).toFixed(5)}</dd></div>
    </dl>
  `;
}

function formatGracePeriod(value) {
  const m = Number(value);
  return m === 0 ? "Indefinite" : `${m} minutes`;
}

function clearBarcodeDisplay() {
  if (!els.sessionQr) return;
  const ctx = els.sessionQr.getContext("2d");
  ctx?.clearRect(0, 0, els.sessionQr.width, els.sessionQr.height);
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function requireLogin(statusElement) {
  if (!state.profile) {
    statusElement.textContent = "Log in with a pass ID before continuing.";
    return false;
  }
  if (state.profile.needs_password_change) {
    statusElement.textContent = "Set a new password first.";
    return false;
  }
  return true;
}

async function scanBarcodeFromVideo(video) {
  if (!window.ZXingWASM) throw new Error("Barcode library failed to load.");
  if (!video.videoWidth || !video.videoHeight) throw new Error("Camera is not ready yet.");
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const results = await ZXingWASM.readBarcodesFromImageData(imageData, {
    formats: Object.values(CONFIG.BARCODE_FORMATS),
    maxNumberOfSymbols: 1,
    textMode: "Plain",
    tryHarder: true,
  });
  const barcode = results[0];
  if (!barcode?.text) throw new Error("No barcode detected.");
  return barcode.text;
}

function parseSessionPayload(scannedText) {
  let payload;
  try {
    payload = JSON.parse(scannedText);
  } catch {
    throw new Error("Scanned QR is not a session payload.");
  }
  const required = [
    "session_code", "session_name", "intended_start_at",
    "grace_period_minutes", "creator_lat", "creator_lon",
  ];
  const missing = required.filter((k) => payload[k] === undefined || payload[k] === null || payload[k] === "");
  if (missing.length) throw new Error("Session QR is missing required fields.");
  if (!Number.isFinite(new Date(payload.intended_start_at).getTime())) {
    throw new Error("Session QR contains an invalid start time.");
  }
  return payload;
}

async function getDeviceLocation() {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      resolve,
      (err) => reject(new Error(getGeoErrorMessage(err))),
      CONFIG.GEOLOCATION_OPTIONS,
    );
  });
}

function getGeoErrorMessage(err) {
  switch (err.code) {
    case err.PERMISSION_DENIED:
      return "Geolocation required. Enable location access in browser settings.";
    case err.POSITION_UNAVAILABLE:
      return "Location unavailable.";
    case err.TIMEOUT:
      return "Location request timed out.";
    default:
      return `Could not retrieve location: ${err.message}`;
  }
}

function roundCoordinate(value) {
  return Number(Number(value).toFixed(CONFIG.COORDINATE_DECIMALS));
}

function setDefaultStartTime() {
  const date = new Date();
  date.setSeconds(0, 0);
  const local = toDateTimeLocalValue(date);
  els.sessionDate.value = local.slice(0, 10);
  els.sessionTime.value = local.slice(11, 16);
}

function toDateTimeLocalValue(date) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function toIsoFromDateAndTime(dateValue, timeValue) {
  if (!dateValue || !timeValue) return "";
  const d = new Date(`${dateValue}T${timeValue}`);
  return Number.isFinite(d.getTime()) ? d.toISOString() : "";
}

function downloadText(filename, text, mimeType) {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(url);
  }, 100);
}

// Reject any URL whose scheme isn't http/https. Defends against javascript: and
// data: URLs in admin-authored notification links.
function sanitiseLinkUrl(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol === "http:" || u.protocol === "https:") return u.toString();
  } catch {
    /* not a valid URL */
  }
  return null;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Exposed for admin.js to share the helpers without re-implementing.
window.AttendanceMain = {
  rpc,
  getSupabase: () => state.supabase,
  withTimeout,
  TIMEOUT_INVOKE_MS,
};
