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
  const state = {
    supabase: null,
    profile: null,
    rpc: null,
    mountEl: null,
    root: null,
    auditOffset: 0,
  };

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
        state.profile.admin_campus_scope ? " (" + state.profile.admin_campus_scope + ")" : " (global)"
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
        <h3>Provision</h3>
        <p class="status-line">CSV header: <code>pass_id,role,campus,group_name,sub_group,display_name</code>. Only <code>pass_id</code> and <code>role</code> are required.</p>
        <textarea id="admin-provision-csv" rows="8" placeholder="pass_id,role,campus,group_name,sub_group,display_name
X-100,user,${state.profile.admin_campus_scope ?? "PROTO"},,,"></textarea>
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
        <h3>Post notification</h3>
        <input id="admin-notif-title" type="text" placeholder="Title (max 200 chars)" />
        <textarea id="admin-notif-body" rows="3" placeholder="Body (max 2000 chars)"></textarea>
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

    document.getElementById("admin-temp-refresh").addEventListener("click", refreshTodaysTemp);
    document.getElementById("admin-unclaimed-refresh").addEventListener("click", refreshUnclaimed);
    document.getElementById("admin-provision-submit").addEventListener("click", handleProvision);
    document.getElementById("admin-provision-file").addEventListener("change", handleProvisionFile);
    document.getElementById("admin-revoke-submit").addEventListener("click", handleRevoke);
    document.getElementById("admin-notif-submit").addEventListener("click", handleNotify);
    document.getElementById("admin-audit-prev").addEventListener("click", () => {
      state.auditOffset = Math.max(0, state.auditOffset - 100);
      refreshAudit();
    });
    document.getElementById("admin-audit-next").addEventListener("click", () => {
      state.auditOffset += 100;
      refreshAudit();
    });
    document.getElementById("admin-audit-refresh").addEventListener("click", () => {
      state.auditOffset = 0;
      refreshAudit();
    });
  }

  // ---------------------------------------------------------------------------
  // Today's temp password
  // ---------------------------------------------------------------------------

  async function refreshTodaysTemp() {
    const campus = document.getElementById("admin-temp-campus").value.trim().toUpperCase()
      || state.profile.admin_campus_scope || "";
    const display = document.getElementById("admin-temp-display");
    if (!campus) {
      display.textContent = "Enter a campus code.";
      return;
    }
    try {
      const data = await state.rpc("get_current_batch_temp_password", { p_campus: campus });
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
    const ingestNames = document.getElementById("admin-provision-ingest-names").checked;
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
    const { data, error } = await state.supabase.functions.invoke("provision", {
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
          field += '"'; i += 2; continue;
        }
        if (ch === '"') { inQuotes = false; i++; continue; }
        field += ch; i++; continue;
      }
      if (ch === '"') { inQuotes = true; i++; continue; }
      if (ch === ",") { row.push(field); field = ""; i++; continue; }
      if (ch === "\r") { i++; continue; }
      if (ch === "\n") { row.push(field); out.push(row); row = []; field = ""; i++; continue; }
      field += ch; i++;
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
    const campus = document.getElementById("admin-revoke-campus").value.trim().toUpperCase();
    const group_name = document.getElementById("admin-revoke-group").value.trim();
    const sub_group = document.getElementById("admin-revoke-subgroup").value.trim();
    const passIdsRaw = document.getElementById("admin-revoke-passids").value.trim();
    const pass_ids = passIdsRaw
      ? passIdsRaw.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)
      : [];

    if (!campus && !group_name && !sub_group && pass_ids.length === 0) {
      alert("Provide a filter or a pass-ID list.");
      return;
    }
    if (!confirm("Revoke matching accounts? This deletes auth users and archives profiles.")) {
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
    const { data, error } = await state.supabase.functions.invoke("revoke", { body });
    if (error) {
      result.textContent = `revoke failed: ${error.message}`;
      return;
    }
    result.textContent = JSON.stringify(data, null, 2);
    refreshUnclaimed();
  }

  // ---------------------------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------------------------

  async function handleNotify() {
    const title = document.getElementById("admin-notif-title").value.trim();
    const body = document.getElementById("admin-notif-body").value.trim();
    const linkUrl = document.getElementById("admin-notif-link").value.trim() || null;
    const campus = document.getElementById("admin-notif-campus").value.trim().toUpperCase() || null;
    const group_name = document.getElementById("admin-notif-group").value.trim() || null;
    const sub_group = document.getElementById("admin-notif-subgroup").value.trim() || null;
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
    const eventType = document.getElementById("admin-audit-event").value.trim() || null;
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
