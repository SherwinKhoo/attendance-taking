"use strict";

// =============================================================================
// admin.js — admin panel module (gated by profile.role === 'admin')
// =============================================================================
// Exposes window.AttendanceAdmin = { mount, unmount }. main.js calls mount()
// after a successful login when the profile role is 'admin', and unmount() on
// logout.
//
// Surface:
//   * Today's per-campus temp password (read-only, refreshable).
//   * Unclaimed accounts list (password_set_at IS NULL, scoped).
//   * Provision: paste CSV or fill single-row form. Calls /functions/v1/provision.
//   * Revoke:    by filter (campus / group / sub_group) or by pass-ID list. /functions/v1/revoke.
//   * Notifications: title/body/scope/pinned. RPC post_notification.
//   * Audit log viewer (paginated). RPC view_audit_events.
// =============================================================================

(function () {
  const PASS_ID_PATTERN = "[A-Za-z0-9][A-Za-z0-9_-]{2,31}";

  const state = {
    supabase: null,
    profile: null,
    rpc: null,
    mountEl: null,
    root: null,
    auditOffset: 0,
  };

  // Edge functions can cold-start; budget 20 s. withTimeout is provided by
  // main.js via window.AttendanceMain so a wedged Supabase client surfaces as
  // a visible error instead of a silent hang.
  function invokeWithTimeout(name, opts) {
    const wt = window.AttendanceMain?.withTimeout;
    const ms = window.AttendanceMain?.TIMEOUT_INVOKE_MS ?? 20000;
    const call = state.supabase.functions.invoke(name, opts);
    return wt ? wt(call, ms, `functions.invoke("${name}")`) : call;
  }

  // Disable a button while an async handler runs and surface its error to the
  // given target. Eliminates the silent-failure path where an uncaught
  // rejection left the button visually responsive but functionally inert.
  // Also enforces a 3-second minimum disable window after the click to
  // throttle DB-touching admin buttons against spam.
  const COOLDOWN_MS = 3000;
  async function withButtonGuard(buttonEl, asyncFn, errorTargetEl) {
    if (!buttonEl) return asyncFn();
    if (buttonEl.disabled) return; // already in flight or cooling down
    buttonEl.disabled = true;
    const start = performance.now();
    try {
      await asyncFn();
    } catch (err) {
      const message = err?.message ?? String(err);
      if (errorTargetEl) {
        errorTargetEl.hidden = false;
        errorTargetEl.textContent = `Error: ${message}`;
      } else {
        // Fall through to console as a last resort.
        console.error("[admin]", message);
      }
    } finally {
      const elapsed = performance.now() - start;
      const remaining = Math.max(0, COOLDOWN_MS - elapsed);
      setTimeout(() => {
        buttonEl.disabled = false;
      }, remaining);
    }
  }

  function mount({ supabase, profile, rpc, mountEl }) {
    state.supabase = supabase;
    state.profile = profile;
    state.rpc = rpc;
    state.mountEl = mountEl;
    render();
    refreshTodaysTemp();
    refreshUnclaimed();
    refreshAudit();
  }

  function unmount() {
    if (state.root) state.root.remove();
    state.root = null;
    state.supabase = null;
    state.profile = null;
    state.rpc = null;
    state.mountEl = null;
    state.auditOffset = 0;
  }

  function render() {
    state.mountEl.innerHTML = "";
    const root = document.createElement("section");
    root.className = "zone admin-zone";
    root.innerHTML = `
      <div class="zone-heading"><h2>Admin panel</h2><span class="status">Role: admin${
        state.profile.admin_campus_scope
          ? " (" + state.profile.admin_campus_scope + ")"
          : " (global)"
      }</span></div>

      <div class="admin-section">
        <h3>Today's temp password</h3>
        <div class="admin-row">
          <input id="admin-temp-campus" type="text" placeholder="Campus code"
                 value="${state.profile.admin_campus_scope ?? ""}" />
          <button id="admin-temp-refresh" type="button">Refresh</button>
        </div>
        <p class="status-line" id="admin-temp-display">—</p>
      </div>

      <div class="admin-section">
        <h3>Unclaimed accounts</h3>
        <div class="admin-row">
          <button id="admin-unclaimed-refresh" type="button">Refresh</button>
        </div>
        <ul id="admin-unclaimed-list" class="admin-list"></ul>
      </div>

      <div class="admin-section">
        <h3>Add single account</h3>
        <div class="admin-row">
          <input id="admin-single-pass-id" type="text" placeholder="Pass ID"
                 pattern="${PASS_ID_PATTERN}" maxlength="32" required />
          <select id="admin-single-role" required>
            <option value="">Role…</option>
            <option value="user">user</option>
            <option value="representative">representative</option>
            <option value="coordinator">coordinator</option>
            <option value="admin">admin</option>
          </select>
        </div>
        <div class="admin-row">
          <input id="admin-single-campus" type="text" placeholder="Campus" value="${state.profile.admin_campus_scope ?? ""}" required />
          <input id="admin-single-group" type="text" placeholder="Group" required />
          <input id="admin-single-subgroup" type="text" placeholder="Sub-group" required />
        </div>
        <div class="admin-row">
          <input id="admin-single-display-name" type="text" placeholder="Display name (optional)" />
          <label class="toggle">
            <input id="admin-single-ingest-name" type="checkbox" />
            <span>Ingest name</span>
          </label>
          <button id="admin-single-submit" type="button">Add</button>
        </div>
        <pre id="admin-single-result" class="admin-output" hidden></pre>
      </div>

      <div class="admin-section">
        <h3>Provision (CSV batch)</h3>
        <p class="status-line">Required columns: <code>pass_id, role, campus, group_name, sub_group</code>.<br>Optional: <code>display_name</code>.</p>
        <textarea id="admin-provision-csv" rows="8" placeholder="pass_id,role,campus,group_name,sub_group,display_name
X-100,user,${state.profile.admin_campus_scope ?? "PROTO"},Group A,Sub 1,"></textarea>
        <label class="toggle">
          <input id="admin-provision-ingest-names" type="checkbox" />
          <span>Ingest display_name from CSV (default: drop)</span>
        </label>
        <div class="admin-row">
          <input type="file" id="admin-provision-file" accept=".csv,text/csv" />
          <button id="admin-provision-submit" type="button">Provision</button>
        </div>
        <pre id="admin-provision-result" class="admin-output" hidden></pre>
      </div>
      <div class="admin-section">
        <h3>Revoke</h3>
        <div class="admin-row">
          <input id="admin-revoke-campus" type="text" placeholder="Campus" value="${state.profile.admin_campus_scope ?? ""}" />
          <input id="admin-revoke-group" type="text" placeholder="Group (optional)" />
          <input id="admin-revoke-subgroup" type="text" placeholder="Sub-group (optional)" />
        </div>
        <textarea id="admin-revoke-passids" rows="4" placeholder="Or paste pass-IDs, one per line"></textarea>
        <div class="admin-row">
          <button id="admin-revoke-submit" type="button">Revoke matching</button>
        </div>
        <pre id="admin-revoke-result" class="admin-output" hidden></pre>
      </div>
      <div class="admin-section">
        <h3>Reset password</h3>
        <p class="status-line">Sends the user back to today's per-campus daily temp. Unclaimed accounts are not touched. Claimed accounts are signed out from every device.</p>
        <div class="admin-row">
          <input id="admin-reset-pass-id" type="text" placeholder="Pass ID"
                 pattern="${PASS_ID_PATTERN}" maxlength="32" required />
          <button id="admin-reset-submit" type="button">Reset to daily temp</button>
        </div>
        <pre id="admin-reset-result" class="admin-output" hidden></pre>
      </div>

      <div class="admin-section">
        <h3>Post notification</h3>
        <input id="admin-notif-title" type="text" placeholder="Title (max 200 chars)" maxlength="200" required />
        <textarea id="admin-notif-body" rows="3" placeholder="Body (max 2000 chars)" maxlength="2000" required></textarea>
        <input id="admin-notif-link" type="url" placeholder="Optional link URL" />
        <div class="admin-row">
          <input id="admin-notif-campus" type="text" placeholder="Target campus (blank = any)" value="${state.profile.admin_campus_scope ?? ""}" />
          <input id="admin-notif-group" type="text" placeholder="Target group (blank = any)" />
          <input id="admin-notif-subgroup" type="text" placeholder="Target sub-group (blank = any)" />
        </div>
        <label class="toggle">
          <input id="admin-notif-pinned" type="checkbox" />
          <span>Pin (replaces any existing pin at this scope)</span>
        </label>
        <div class="admin-row">
          <button id="admin-notif-submit" type="button">Post</button>
        </div>
        <p class="status-line" id="admin-notif-status"></p>
      </div>

      <div class="admin-section">
        <h3>Audit log</h3>
        <div class="admin-row">
          <input id="admin-audit-event" type="text" placeholder="Event type filter (optional)" />
          <button id="admin-audit-prev" type="button">Prev</button>
          <button id="admin-audit-next" type="button">Next</button>
          <button id="admin-audit-refresh" type="button">Refresh</button>
        </div>
        <ul id="admin-audit-list" class="admin-list"></ul>
      </div>
    `;
    state.mountEl.append(root);
    state.root = root;

    bind("admin-temp-refresh", refreshTodaysTemp, "admin-temp-display");
    bind("admin-unclaimed-refresh", refreshUnclaimed, "admin-unclaimed-list");
    bind("admin-single-submit", handleSingleAdd, "admin-single-result");
    bind("admin-provision-submit", handleProvision, "admin-provision-result");
    document
      .getElementById("admin-provision-file")
      .addEventListener("change", handleProvisionFile);
    bind("admin-revoke-submit", handleRevoke, "admin-revoke-result");
    bind("admin-reset-submit", handleReset, "admin-reset-result");
    bind("admin-notif-submit", handleNotify, "admin-notif-status");
    bind(
      "admin-audit-prev",
      () => {
        state.auditOffset = Math.max(0, state.auditOffset - 100);
        return refreshAudit();
      },
      "admin-audit-list",
    );
    bind(
      "admin-audit-next",
      () => {
        state.auditOffset += 100;
        return refreshAudit();
      },
      "admin-audit-list",
    );
    bind(
      "admin-audit-refresh",
      () => {
        state.auditOffset = 0;
        return refreshAudit();
      },
      "admin-audit-list",
    );
  }

  function bind(buttonId, handler, errorTargetId) {
    const button = document.getElementById(buttonId);
    const errorTarget = errorTargetId
      ? document.getElementById(errorTargetId)
      : null;
    button.addEventListener("click", () =>
      withButtonGuard(button, handler, errorTarget),
    );
  }

  function reportValidityFor(ids) {
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el && !el.reportValidity()) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Single-add
  // ---------------------------------------------------------------------------

  async function handleSingleAdd() {
    if (
      !reportValidityFor([
        "admin-single-pass-id",
        "admin-single-role",
        "admin-single-campus",
        "admin-single-group",
        "admin-single-subgroup",
      ])
    ) {
      return;
    }
    const passId = document
      .getElementById("admin-single-pass-id")
      .value.trim()
      .toUpperCase();
    const role = document.getElementById("admin-single-role").value;
    const campus = document
      .getElementById("admin-single-campus")
      .value.trim()
      .toUpperCase();
    const groupName = document
      .getElementById("admin-single-group")
      .value.trim();
    const subGroup = document
      .getElementById("admin-single-subgroup")
      .value.trim();
    const displayName = document
      .getElementById("admin-single-display-name")
      .value.trim();
    const ingestName = document.getElementById(
      "admin-single-ingest-name",
    ).checked;
    const result = document.getElementById("admin-single-result");
    result.hidden = false;

    const missing = [];
    if (!passId) missing.push("pass_id");
    if (!role) missing.push("role");
    if (!campus) missing.push("campus");
    if (!groupName) missing.push("group_name");
    if (!subGroup) missing.push("sub_group");
    if (missing.length > 0) {
      result.textContent = `Missing required fields: ${missing.join(", ")}.`;
      return;
    }

    result.textContent = "Calling provision function...";
    const { data, error } = await invokeWithTimeout("provision", {
      body: {
        ingest_names: ingestName,
        rows: [
          {
            pass_id: passId,
            role,
            campus,
            group_name: groupName,
            sub_group: subGroup,
            display_name: displayName || null,
          },
        ],
      },
    });
    if (error) {
      result.textContent = `provision failed: ${error.message}`;
      return;
    }
    result.textContent = JSON.stringify(data, null, 2);

    // Clear pass-ID and role for the next add; keep campus/group/sub-group as
    // sticky defaults since the admin is usually adding multiples in a row.
    document.getElementById("admin-single-pass-id").value = "";
    document.getElementById("admin-single-display-name").value = "";

    refreshTodaysTemp();
    refreshUnclaimed();
  }

  // ---------------------------------------------------------------------------
  // Today's temp password
  // ---------------------------------------------------------------------------

  async function refreshTodaysTemp() {
    const campus =
      document.getElementById("admin-temp-campus").value.trim().toUpperCase() ||
      state.profile.admin_campus_scope ||
      "";
    const display = document.getElementById("admin-temp-display");
    if (!campus) {
      display.textContent = "Enter a campus code.";
      return;
    }
    try {
      const data = await state.rpc("get_current_batch_temp_password", {
        p_campus: campus,
      });
      if (!data?.temp_password) {
        display.textContent = `${campus}: no temp password yet (no provision today).`;
        return;
      }
      display.textContent = `${data.campus} (${data.rotation_date}): ${data.temp_password}`;
    } catch (err) {
      display.textContent = err.message;
    }
  }

  // ---------------------------------------------------------------------------
  // Unclaimed list
  // ---------------------------------------------------------------------------

  async function refreshUnclaimed() {
    const list = document.getElementById("admin-unclaimed-list");
    list.innerHTML = "";
    try {
      const rows = await state.rpc("list_unclaimed_profiles", {
        p_campus: state.profile.admin_campus_scope ?? null,
      });
      if (!rows || rows.length === 0) {
        const li = document.createElement("li");
        li.textContent = "No unclaimed accounts.";
        list.append(li);
        return;
      }
      for (const r of rows) {
        const li = document.createElement("li");
        li.textContent = `${r.pass_id} — ${r.role} — ${r.campus ?? "—"} (created ${new Date(r.created_at).toLocaleString()})`;
        list.append(li);
      }
    } catch (err) {
      const li = document.createElement("li");
      li.textContent = err.message;
      list.append(li);
    }
  }

  // ---------------------------------------------------------------------------
  // Provision
  // ---------------------------------------------------------------------------

  async function handleProvisionFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    document.getElementById("admin-provision-csv").value = text;
  }

  async function handleProvision() {
    const csv = document.getElementById("admin-provision-csv").value;
    const ingestNames = document.getElementById(
      "admin-provision-ingest-names",
    ).checked;
    const result = document.getElementById("admin-provision-result");
    result.hidden = false;
    result.textContent = "Parsing CSV...";

    let rows;
    try {
      rows = parseCsvToRows(csv);
    } catch (err) {
      result.textContent = `CSV parse error: ${err.message}`;
      return;
    }
    if (rows.length === 0) {
      result.textContent = "No rows to provision.";
      return;
    }

    result.textContent = "Calling provision function...";
    const { data, error } = await invokeWithTimeout("provision", {
      body: { ingest_names: ingestNames, rows },
    });
    if (error) {
      result.textContent = `provision failed: ${error.message}`;
      return;
    }
    result.textContent = JSON.stringify(data, null, 2);
    refreshTodaysTemp();
    refreshUnclaimed();
  }

  // CSV parser: supports quoted fields with embedded commas / newlines / quotes.
  function parseCsv(text) {
    const out = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"' && text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        if (ch === '"') {
          inQuotes = false;
          i++;
          continue;
        }
        field += ch;
        i++;
        continue;
      }
      if (ch === '"') {
        inQuotes = true;
        i++;
        continue;
      }
      if (ch === ",") {
        row.push(field);
        field = "";
        i++;
        continue;
      }
      if (ch === "\r") {
        i++;
        continue;
      }
      if (ch === "\n") {
        row.push(field);
        out.push(row);
        row = [];
        field = "";
        i++;
        continue;
      }
      field += ch;
      i++;
    }
    if (field !== "" || row.length > 0) {
      row.push(field);
      out.push(row);
    }
    return out;
  }

  function parseCsvToRows(text) {
    const cells = parseCsv(text.trim());
    if (cells.length < 1) return [];
    const header = cells[0].map((c) => c.trim().toLowerCase());
    const required = ["pass_id", "role"];
    for (const r of required) {
      if (!header.includes(r)) {
        throw new Error(`Missing required column: ${r}`);
      }
    }
    const rows = [];
    for (let r = 1; r < cells.length; r++) {
      if (cells[r].every((v) => v === "")) continue;
      const row = {};
      for (let c = 0; c < header.length; c++) {
        row[header[c]] = (cells[r][c] ?? "").trim();
      }
      rows.push(row);
    }
    return rows;
  }

  // ---------------------------------------------------------------------------
  // Revoke
  // ---------------------------------------------------------------------------

  async function handleRevoke() {
    const campus = document
      .getElementById("admin-revoke-campus")
      .value.trim()
      .toUpperCase();
    const group_name = document
      .getElementById("admin-revoke-group")
      .value.trim();
    const sub_group = document
      .getElementById("admin-revoke-subgroup")
      .value.trim();
    const passIdsRaw = document
      .getElementById("admin-revoke-passids")
      .value.trim();
    const pass_ids = passIdsRaw
      ? passIdsRaw
          .split(/[\n,]+/)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    if (!campus && !group_name && !sub_group && pass_ids.length === 0) {
      alert("Provide a filter or a pass-ID list.");
      return;
    }
    if (
      !confirm(
        "Revoke matching accounts? This deletes auth users and archives profiles.",
      )
    ) {
      return;
    }

    const body = {};
    if (campus) body.campus = campus;
    if (group_name) body.group_name = group_name;
    if (sub_group) body.sub_group = sub_group;
    if (pass_ids.length > 0) body.pass_ids = pass_ids;

    const result = document.getElementById("admin-revoke-result");
    result.hidden = false;
    result.textContent = "Calling revoke function...";
    const { data, error } = await invokeWithTimeout("revoke", { body });
    if (error) {
      result.textContent = `revoke failed: ${error.message}`;
      return;
    }
    result.textContent = JSON.stringify(data, null, 2);
    refreshUnclaimed();
  }

  // ---------------------------------------------------------------------------
  // Reset password
  // ---------------------------------------------------------------------------

  async function handleReset() {
    if (!reportValidityFor(["admin-reset-pass-id"])) return;
    const passId = document
      .getElementById("admin-reset-pass-id")
      .value.trim()
      .toUpperCase();
    const result = document.getElementById("admin-reset-result");
    result.hidden = false;
    if (!passId) {
      result.textContent = "Pass ID is required.";
      return;
    }
    result.textContent = "Calling reset-password function...";
    const { data, error } = await invokeWithTimeout("reset-password", {
      body: { pass_id: passId },
    });
    if (error) {
      result.textContent = `reset-password failed: ${error.message}`;
      return;
    }
    if (!data?.ok) {
      result.textContent = `reset-password failed: ${data?.error ?? "unknown error"}`;
      return;
    }
    const verb = data.claimed_before
      ? "Password reset. User signed out from all devices."
      : "Unclaimed account — no change. Re-share today's temp.";
    result.textContent = `${verb}\nPass ID: ${data.pass_id}\nCampus: ${data.campus}\nToday's temp: ${data.temp_password}`;
    document.getElementById("admin-reset-pass-id").value = "";
    refreshUnclaimed();
  }

  // ---------------------------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------------------------

  async function handleNotify() {
    if (
      !reportValidityFor([
        "admin-notif-title",
        "admin-notif-body",
        "admin-notif-link",
      ])
    ) {
      return;
    }
    const title = document.getElementById("admin-notif-title").value.trim();
    const body = document.getElementById("admin-notif-body").value.trim();
    const linkUrl =
      document.getElementById("admin-notif-link").value.trim() || null;
    const campus =
      document
        .getElementById("admin-notif-campus")
        .value.trim()
        .toUpperCase() || null;
    const group_name =
      document.getElementById("admin-notif-group").value.trim() || null;
    const sub_group =
      document.getElementById("admin-notif-subgroup").value.trim() || null;
    const pinned = document.getElementById("admin-notif-pinned").checked;
    const status = document.getElementById("admin-notif-status");

    if (!title || !body) {
      status.textContent = "Title and body are required.";
      return;
    }
    try {
      await state.rpc("post_notification", {
        p_title: title,
        p_body: body,
        p_link_url: linkUrl,
        p_target_campus: campus,
        p_target_group_name: group_name,
        p_target_sub_group: sub_group,
        p_target_profile_id: null,
        p_pinned: pinned,
        p_expires_at: null,
      });
      status.textContent = "Notification posted.";
      document.getElementById("admin-notif-title").value = "";
      document.getElementById("admin-notif-body").value = "";
      document.getElementById("admin-notif-link").value = "";
    } catch (err) {
      status.textContent = err.message;
    }
  }

  // ---------------------------------------------------------------------------
  // Audit log
  // ---------------------------------------------------------------------------

  async function refreshAudit() {
    const list = document.getElementById("admin-audit-list");
    list.innerHTML = "";
    const eventType =
      document.getElementById("admin-audit-event").value.trim() || null;
    try {
      const rows = await state.rpc("view_audit_events", {
        p_limit: 100,
        p_offset: state.auditOffset,
        p_event_type: eventType,
      });
      if (!rows || rows.length === 0) {
        const li = document.createElement("li");
        li.textContent = "No events.";
        list.append(li);
        return;
      }
      for (const e of rows) {
        const li = document.createElement("li");
        li.textContent = `${new Date(e.created_at).toLocaleString()} — ${e.event_type} — ${e.actor_campus ?? "—"} — ${e.actor_profile_id ?? "—"}`;
        list.append(li);
      }
    } catch (err) {
      const li = document.createElement("li");
      li.textContent = err.message;
      list.append(li);
    }
  }

  window.AttendanceAdmin = { mount, unmount };
})();
