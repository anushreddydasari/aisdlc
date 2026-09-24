/**
 * GET /repositories — a static admin page for the Repository Registry.
 *
 * This is an INTERFACE, not a second source of truth: it is a single
 * self-contained HTML/CSS/JS document (no build step, no framework — this
 * project has never had one, see package.json) whose only job is to call
 * the EXISTING `/repository-registry` JSON API (`api/repository-registry.ts`)
 * from the browser via `fetch`. Every business rule — repository URL
 * validation, branch validation, duplicate-mapping detection, and
 * authorization — is enforced exactly once, server-side, by the code that
 * already enforced it before this page existed. Nothing here re-implements
 * or bypasses any of it; the client-side checks in this page's script are
 * pure UX (fail fast, show a helpful message) and are never trusted as a
 * security boundary — the same "URL format validation is not
 * authorization" posture `repository-registry/repository.ts`'s own module
 * comment states.
 *
 * AUTHORIZATION. This page has no login of its own and introduces no new
 * authorization mechanism. It asks the admin to paste the existing
 * OPERATOR_TOKEN into a field (stored only in this browser tab's
 * `sessionStorage`, never sent anywhere except as the `Authorization:
 * Bearer` header on calls to the already-existing, already-gated
 * `/repository-registry` endpoints) — the exact same shared-secret bearer
 * check every other operator-gated route in this codebase already
 * performs (`verifyOperatorToken`, see `api/operator-auth.ts`). A caller
 * who calls the JSON API directly, bypassing this page entirely, is
 * subject to precisely the same 401 this page's own fetch calls would hit
 * — this page cannot make an unauthorized request succeed, and cannot make
 * an authorized one fail.
 *
 * NO SECRETS RENDERED. The page never requests or displays a GitHub
 * token, installation token, private key, JWT, or `Authorization` header
 * value belonging to anyone but the admin's own pasted operator token
 * (which this page never transmits anywhere except back to this same
 * service, and never displays back after the admin types it). The GitHub
 * App installation id shown in the table is a non-secret numeric
 * identifier — see `repository-registry/repository.ts`'s own
 * `accessPolicy` doc comment.
 */

/** server.ts swaps these when the test-mode delete route is mounted; the page shows Delete only then. */
export const REPOSITORY_UI_DELETE_FLAG_OFF = 'var CAN_DELETE = false;';
export const REPOSITORY_UI_DELETE_FLAG_ON = 'var CAN_DELETE = true;';

export const REPOSITORY_UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Repository Management</title>
<style>
  :root {
    color-scheme: light;
    --bg: #f5f6f8;
    --panel: #ffffff;
    --border: #d9dde3;
    --text: #1b1f24;
    --muted: #5b6572;
    --accent: #2452c8;
    --accent-contrast: #ffffff;
    --danger: #b3261e;
    --danger-bg: #fbeceb;
    --success: #1e7d32;
    --success-bg: #eaf5ec;
    --warn-bg: #fff6e5;
    --warn: #8a5a00;
    --active-bg: #e6f4ea;
    --active-text: #1e7d32;
    --inactive-bg: #f1f2f4;
    --inactive-text: #5b6572;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: var(--bg);
    color: var(--text);
  }
  header.page-header {
    padding: 20px 24px 8px;
  }
  header.page-header h1 {
    margin: 0 0 4px;
    font-size: 22px;
  }
  header.page-header p.subtitle {
    margin: 0;
    color: var(--muted);
    font-size: 13px;
  }
  main {
    padding: 16px 24px 48px;
    max-width: 1080px;
  }
  .panel {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 16px;
  }
  .session-panel { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; }
  .field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
  .field label { font-weight: 600; color: var(--muted); }
  .field input, .field select, .field textarea {
    padding: 7px 9px;
    border: 1px solid var(--border);
    border-radius: 6px;
    font-size: 13px;
    min-width: 220px;
    font-family: inherit;
  }
  .field.checkbox { flex-direction: row; align-items: center; gap: 6px; }
  .field.checkbox label { font-weight: 500; color: var(--text); }
  .help {
    font-size: 12px;
    color: var(--muted);
    margin: 6px 0 0;
    max-width: 640px;
  }
  button {
    font: inherit;
    cursor: pointer;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--panel);
    padding: 7px 14px;
    font-size: 13px;
  }
  button.primary { background: var(--accent); color: var(--accent-contrast); border-color: var(--accent); }
  button.primary:hover { filter: brightness(1.05); }
  button.danger { background: var(--danger-bg); color: var(--danger); border-color: var(--danger); }
  button.small { padding: 4px 10px; font-size: 12px; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
  .toolbar .filters { display: flex; gap: 8px; align-items: center; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.02em; }
  tr:last-child td { border-bottom: none; }
  .repo-id { font-weight: 600; }
  .repo-url { display: block; color: var(--muted); font-size: 12px; word-break: break-all; }
  .badge { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .badge.active { background: var(--active-bg); color: var(--active-text); }
  .badge.inactive { background: var(--inactive-bg); color: var(--inactive-text); }
  .updated-by { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .row-actions { display: flex; gap: 6px; flex-wrap: wrap; }
  .banner { padding: 10px 14px; border-radius: 6px; font-size: 13px; margin-bottom: 12px; display: none; }
  .banner.show { display: block; }
  .banner.error { background: var(--danger-bg); color: var(--danger); }
  .banner.success { background: var(--success-bg); color: var(--success); }
  .banner.info { background: var(--warn-bg); color: var(--warn); }
  .empty-state, .loading-state { padding: 24px; text-align: center; color: var(--muted); font-size: 13px; }
  .overlay {
    display: none;
    position: fixed; inset: 0; background: rgba(20, 22, 26, 0.45);
    align-items: center; justify-content: center; padding: 16px; z-index: 50;
  }
  .overlay.show { display: flex; }
  .modal {
    background: var(--panel);
    border-radius: 10px;
    padding: 20px;
    width: 100%;
    max-width: 440px;
    max-height: calc(100vh - 32px);
    overflow-y: auto;
  }
  .modal h2 { margin: 0 0 4px; font-size: 17px; }
  .modal p.modal-sub { margin: 0 0 14px; color: var(--muted); font-size: 13px; }
  .modal form { display: flex; flex-direction: column; gap: 12px; }
  .modal .field input[readonly] { background: var(--bg); color: var(--muted); }
  .modal .field-error { color: var(--danger); font-size: 12px; min-height: 14px; }
  .modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
  .confirm-modal { max-width: 400px; }
  .confirm-modal p { font-size: 14px; }
  .note {
    font-size: 12px;
    color: var(--muted);
    background: var(--bg);
    border: 1px dashed var(--border);
    border-radius: 6px;
    padding: 8px 10px;
    margin-top: 10px;
  }
  .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); }
  /* ?embedded=1 — shown as the AISDLC Console's Repositories tab, whose own
     header already holds the title and the (shared, same-tab) token. */
  html.embedded .page-header, html.embedded .session-panel { display: none; }
  html.embedded body { background: transparent; }
</style>
</head>
<body>
<header class="page-header">
  <h1>Repository Management</h1>
  <p class="subtitle">Administers the AISDLC Repository Registry — the single source of truth a ticket's repository is resolved through. This page only calls the existing /repository-registry API; it enforces no rules of its own.</p>
</header>
<main>

  <section class="panel session-panel">
    <div class="field">
      <label for="operator-token">Operator token</label>
      <input id="operator-token" type="password" autocomplete="off" placeholder="Paste OPERATOR_TOKEN">
    </div>
    <div class="field">
      <label for="operator-name">Your name</label>
      <input id="operator-name" type="text" autocomplete="off" placeholder="e.g. alice">
    </div>
    <div>
      <button id="save-session" class="primary" type="button">Save</button>
    </div>
    <p class="help" style="flex-basis:100%;">
      This token is sent as the same <code>Authorization: Bearer</code> header every AISDLC admin endpoint already
      requires, and is stored only in this browser tab (<code>sessionStorage</code>) — never persisted server-side by
      this page. Only holders of the operator token can add, edit, activate, or deactivate a repository; the backend
      rejects any request with a missing or wrong token, even if this page is skipped entirely and the API is called
      directly.
    </p>
  </section>

  <div id="banner" class="banner" role="status"></div>

  <div class="toolbar">
    <button id="add-repository-btn" class="primary" type="button">+ Add Repository</button>
    <div class="filters">
      <label class="visually-hidden" for="status-filter">Filter by status</label>
      <select id="status-filter">
        <option value="">All statuses</option>
        <option value="active">Active only</option>
        <option value="inactive">Inactive only</option>
      </select>
      <button id="refresh-btn" type="button">Refresh</button>
    </div>
  </div>

  <section class="panel" style="padding:0;">
    <div id="table-wrap">
      <div id="loading-state" class="loading-state">Loading repositories…</div>
    </div>
  </section>
</main>

<div id="form-overlay" class="overlay">
  <div class="modal">
    <h2 id="form-title">Add Repository</h2>
    <p class="modal-sub" id="form-sub">Registers a new mapping. The repository only becomes selectable for a ticket once it is registered here.</p>
    <form id="repo-form">
      <input type="hidden" id="form-id" value="">
      <div class="field">
        <label for="field-project">Space / Project</label>
        <input id="field-project" type="text" placeholder="e.g. TESTIN" required>
        <div class="field-error" id="error-project"></div>
      </div>
      <div class="field">
        <label for="field-url">GitHub Repository</label>
        <input id="field-url" type="text" placeholder="https://github.com/org/repo" required>
        <div class="field-error" id="error-url"></div>
      </div>
      <div class="field">
        <label for="field-repoid">Repository ID (stable name, unique within this project)</label>
        <input id="field-repoid" type="text" placeholder="auto-filled from the URL">
        <div class="field-error" id="error-repoid"></div>
      </div>
      <div class="field">
        <label for="field-branch">Base Branch</label>
        <input id="field-branch" type="text" placeholder="main" required>
        <div class="field-error" id="error-branch"></div>
      </div>
      <div class="field">
        <label for="field-allowed">Allowed Branches (comma-separated; optional — defaults to the base branch)</label>
        <input id="field-allowed" type="text" placeholder="main, feature/*">
        <div class="field-error" id="error-allowed"></div>
      </div>
      <div class="field">
        <label for="field-installation">GitHub App Installation (numeric id)</label>
        <input id="field-installation" type="text" inputmode="numeric" placeholder="e.g. 12345678">
        <div class="field-error" id="error-installation"></div>
      </div>
      <div class="field checkbox" id="active-row">
        <input id="field-active" type="checkbox" checked disabled>
        <label for="field-active">Active</label>
      </div>
      <p class="note" id="active-note">New repositories are always created as Active — this is enforced by the
        existing backend, not by this page. Use the Deactivate action afterwards if needed.</p>
      <div class="field-error" id="error-form"></div>
      <div class="modal-actions">
        <button type="button" id="form-cancel">Cancel</button>
        <button type="submit" class="primary" id="form-save">Save Repository</button>
      </div>
    </form>
  </div>
</div>

<div id="confirm-overlay" class="overlay">
  <div class="modal confirm-modal">
    <h2 id="confirm-title">Deactivate repository?</h2>
    <p id="confirm-message"></p>
    <div class="field-error" id="confirm-error"></div>
    <div class="modal-actions">
      <button type="button" id="confirm-cancel">Cancel</button>
      <button type="button" id="confirm-ok" class="danger">Deactivate</button>
    </div>
  </div>
</div>

<script>
(function () {
  'use strict';

  // ?embedded=1: shown inside the AISDLC Console, which supplies the header and token.
  if (/[?&]embedded=1(&|$)/.test(location.search)) document.documentElement.className += ' embedded';
  var TOKEN_KEY = 'aisdlc_operator_token';
  var NAME_KEY = 'aisdlc_operator_name';
  var API_BASE = '/repository-registry';
  // Local test mode only (set by the server): inactive entries get a Delete button.
  var CAN_DELETE = false;

  var state = { entries: [], filterStatus: '', editingId: null, pendingStatusChange: null };

  function qs(id) { return document.getElementById(id); }

  function safeSessionGet(key) {
    try { return sessionStorage.getItem(key) || ''; } catch (e) { return ''; }
  }
  function safeSessionSet(key, value) {
    try { sessionStorage.setItem(key, value); } catch (e) { /* private-browsing or blocked storage: session simply is not remembered */ }
  }

  function getToken() { return safeSessionGet(TOKEN_KEY); }
  function getOperatorName() { return safeSessionGet(NAME_KEY); }

  function showBanner(kind, message) {
    var el = qs('banner');
    el.className = 'banner show ' + kind;
    el.textContent = message;
    if (kind === 'success') {
      window.setTimeout(function () {
        el.className = 'banner';
        el.textContent = '';
      }, 4000);
    }
  }
  function clearBanner() {
    var el = qs('banner');
    el.className = 'banner';
    el.textContent = '';
  }

  function apiFetch(path, method, bodyObj) {
    var headers = { 'content-type': 'application/json' };
    var token = getToken();
    if (token) headers['authorization'] = 'Bearer ' + token;
    var opts = { method: method, headers: headers };
    if (bodyObj !== undefined) opts.body = JSON.stringify(bodyObj);
    return fetch(path, opts)
      .then(function (res) {
        return res.text().then(function (text) {
          var data = null;
          if (text) {
            try { data = JSON.parse(text); } catch (e) { data = null; }
          }
          return { status: res.status, ok: res.ok, data: data };
        });
      })
      .catch(function () {
        return { status: 0, ok: false, data: null, networkError: true };
      });
  }

  /** Maps this API's existing error shape ({error, field, detail}) to a readable message. Never invents new error text the backend didn't already provide when it's available. */
  function describeError(result) {
    if (result.networkError) return 'Could not reach the AISDLC service. Check your connection and try again.';
    if (result.status === 401) return 'Unauthorized — check the operator token above.';
    if (result.status === 404) return 'Not found — this repository entry may have been changed elsewhere. Refresh and try again.';
    if (result.status === 409) {
      var detail409 = result.data && result.data.detail;
      return 'Conflict: ' + (detail409 || 'an active mapping already exists for this project and repository.');
    }
    if (result.status === 413) return 'Request too large.';
    if (result.status === 503) return 'The AISDLC database is currently unavailable. Try again shortly.';
    if (result.status === 400) {
      var data = result.data || {};
      if (data.field && data.detail) return data.field + ': ' + data.detail;
      if (data.detail) return data.detail;
      return 'Invalid request — check the highlighted fields.';
    }
    if (result.status >= 500) return 'The AISDLC service hit an unexpected error.';
    return 'Request failed (status ' + result.status + ').';
  }

  function formatInstallation(accessPolicy) {
    if (!accessPolicy || typeof accessPolicy !== 'object') return '—';
    var id = accessPolicy.installationId;
    if (typeof id !== 'number') return '—';
    return '#' + id;
  }

  function clearNode(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function renderTable() {
    var wrap = qs('table-wrap');
    clearNode(wrap);

    var visible = state.entries;
    if (visible.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = state.filterStatus
        ? 'No repositories match this filter.'
        : 'No repositories are registered yet. Click "+ Add Repository" to register the first one.';
      wrap.appendChild(empty);
      return;
    }

    var table = document.createElement('table');
    var thead = document.createElement('thead');
    var headRow = document.createElement('tr');
    ['Space / Project', 'Repository', 'Branch', 'Installation', 'Status', 'Actions'].forEach(function (label) {
      var th = document.createElement('th');
      th.textContent = label;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    visible.forEach(function (entry) {
      var tr = document.createElement('tr');

      var tdProject = document.createElement('td');
      tdProject.textContent = entry.projectIdentifier;
      tr.appendChild(tdProject);

      var tdRepo = document.createElement('td');
      var repoIdEl = document.createElement('span');
      repoIdEl.className = 'repo-id';
      repoIdEl.textContent = entry.repositoryId;
      var repoUrlEl = document.createElement('a');
      repoUrlEl.className = 'repo-url';
      repoUrlEl.href = entry.repositoryUrl;
      repoUrlEl.textContent = entry.repositoryUrl;
      repoUrlEl.target = '_blank';
      repoUrlEl.rel = 'noopener noreferrer';
      tdRepo.appendChild(repoIdEl);
      tdRepo.appendChild(repoUrlEl);
      var updatedEl = document.createElement('div');
      updatedEl.className = 'updated-by';
      updatedEl.textContent = 'Updated by ' + entry.updatedBy;
      tdRepo.appendChild(updatedEl);
      tr.appendChild(tdRepo);

      var tdBranch = document.createElement('td');
      tdBranch.textContent = entry.defaultBranch;
      var allowedEl = document.createElement('div');
      allowedEl.className = 'updated-by';
      allowedEl.textContent = 'Allowed: ' + entry.allowedBranches.join(', ');
      tdBranch.appendChild(allowedEl);
      tr.appendChild(tdBranch);

      var tdInstall = document.createElement('td');
      tdInstall.textContent = formatInstallation(entry.accessPolicy);
      tr.appendChild(tdInstall);

      var tdStatus = document.createElement('td');
      var badge = document.createElement('span');
      badge.className = 'badge ' + (entry.status === 'active' ? 'active' : 'inactive');
      badge.textContent = entry.status === 'active' ? 'Active' : 'Inactive';
      tdStatus.appendChild(badge);
      tr.appendChild(tdStatus);

      var tdActions = document.createElement('td');
      var actionsWrap = document.createElement('div');
      actionsWrap.className = 'row-actions';

      var editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'small';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', function () { openEditModal(entry); });
      actionsWrap.appendChild(editBtn);

      var statusBtn = document.createElement('button');
      statusBtn.type = 'button';
      statusBtn.className = 'small' + (entry.status === 'active' ? ' danger' : '');
      statusBtn.textContent = entry.status === 'active' ? 'Deactivate' : 'Activate';
      statusBtn.addEventListener('click', function () { openConfirmModal(entry); });
      actionsWrap.appendChild(statusBtn);

      if (CAN_DELETE && entry.status === 'inactive') {
        var deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'small danger';
        deleteBtn.textContent = 'Delete';
        deleteBtn.addEventListener('click', function () { deleteEntry(entry, deleteBtn); });
        actionsWrap.appendChild(deleteBtn);
      }

      tdActions.appendChild(actionsWrap);
      tr.appendChild(tdActions);

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  function loadEntries() {
    var wrap = qs('table-wrap');
    clearNode(wrap);
    var loading = document.createElement('div');
    loading.className = 'loading-state';
    loading.textContent = 'Loading repositories…';
    wrap.appendChild(loading);

    var qsParams = '';
    if (state.filterStatus) qsParams = '?status=' + encodeURIComponent(state.filterStatus);

    apiFetch(API_BASE + qsParams, 'GET').then(function (result) {
      if (!result.ok) {
        clearNode(wrap);
        var errEl = document.createElement('div');
        errEl.className = 'empty-state';
        errEl.textContent = describeError(result);
        wrap.appendChild(errEl);
        return;
      }
      state.entries = (result.data && result.data.entries) || [];
      renderTable();
    });
  }

  // ---- Add / Edit modal ----

  function slugFromUrl(url) {
    var match = /\\/([A-Za-z0-9_.-]+?)(?:\\.git)?\\/?$/.exec((url || '').trim());
    return match ? match[1] : '';
  }

  function resetFormErrors() {
    ['project', 'url', 'repoid', 'branch', 'allowed', 'installation', 'form'].forEach(function (key) {
      qs('error-' + key).textContent = '';
    });
  }

  function openAddModal() {
    state.editingId = null;
    qs('form-title').textContent = 'Add Repository';
    qs('form-sub').textContent = 'Registers a new mapping. The repository only becomes selectable for a ticket once it is registered here.';
    qs('form-id').value = '';
    qs('field-project').value = '';
    qs('field-project').disabled = false;
    qs('field-url').value = '';
    qs('field-repoid').value = '';
    qs('field-repoid').readOnly = false;
    qs('field-repoid').placeholder = 'auto-filled from the URL';
    qs('field-branch').value = '';
    qs('field-allowed').value = '';
    qs('field-installation').value = '';
    qs('field-active').checked = true;
    qs('field-active').disabled = true;
    qs('active-note').style.display = '';
    resetFormErrors();
    qs('form-overlay').className = 'overlay show';
    qs('field-project').focus();
  }

  function openEditModal(entry) {
    state.editingId = entry.id;
    qs('form-title').textContent = 'Edit Repository';
    qs('form-sub').textContent = 'Space/Project and Repository ID are immutable once a repository is registered — the same rule the existing backend enforces for every caller, not something this page adds.';
    qs('form-id').value = entry.id;
    qs('field-project').value = entry.projectIdentifier;
    qs('field-project').disabled = true;
    qs('field-url').value = entry.repositoryUrl;
    qs('field-repoid').value = entry.repositoryId;
    qs('field-repoid').readOnly = true;
    qs('field-branch').value = entry.defaultBranch;
    qs('field-allowed').value = entry.allowedBranches.join(', ');
    qs('field-installation').value = (entry.accessPolicy && typeof entry.accessPolicy.installationId === 'number') ? String(entry.accessPolicy.installationId) : '';
    qs('field-active').checked = entry.status === 'active';
    qs('field-active').disabled = true;
    qs('active-note').style.display = 'none';
    resetFormErrors();
    qs('form-overlay').className = 'overlay show';
    qs('field-url').focus();
  }

  function closeFormModal() {
    qs('form-overlay').className = 'overlay';
  }

  qs('field-url').addEventListener('input', function () {
    if (state.editingId !== null) return; // repositoryId is immutable once created
    var repoIdField = qs('field-repoid');
    if (repoIdField.dataset.userEdited === 'true') return;
    repoIdField.value = slugFromUrl(qs('field-url').value);
  });
  qs('field-repoid').addEventListener('input', function () {
    qs('field-repoid').dataset.userEdited = 'true';
  });

  function parseAllowedBranches(raw, fallbackBranch) {
    var trimmed = (raw || '').trim();
    if (trimmed === '') return fallbackBranch ? [fallbackBranch] : [];
    return trimmed.split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s !== ''; });
  }

  function validateFormClientSide(payload, isEdit) {
    var ok = true;
    resetFormErrors();
    if (!isEdit && payload.projectIdentifier === '') {
      qs('error-project').textContent = 'Required.';
      ok = false;
    }
    if (!/^https:\\/\\/github\\.com\\/[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+\\/?$/.test(payload.repositoryUrl)) {
      qs('error-url').textContent = 'Expected https://github.com/<org>/<repo> — the backend re-checks this regardless.';
      ok = false;
    }
    if (!isEdit && payload.repositoryId === '') {
      qs('error-repoid').textContent = 'Required.';
      ok = false;
    }
    if (payload.defaultBranch === '') {
      qs('error-branch').textContent = 'Required.';
      ok = false;
    }
    if (payload.installationRaw !== '' && !/^[0-9]+$/.test(payload.installationRaw)) {
      qs('error-installation').textContent = 'Must be a positive whole number.';
      ok = false;
    }
    return ok;
  }

  qs('repo-form').addEventListener('submit', function (event) {
    event.preventDefault();

    var operator = getOperatorName();
    if (!getToken() || !operator) {
      qs('error-form').textContent = 'Set your operator token and name above first.';
      return;
    }

    var isEdit = state.editingId !== null;
    var branch = qs('field-branch').value.trim();
    var installationRaw = qs('field-installation').value.trim();
    var payload = {
      projectIdentifier: qs('field-project').value.trim(),
      repositoryUrl: qs('field-url').value.trim(),
      repositoryId: qs('field-repoid').value.trim(),
      defaultBranch: branch,
      installationRaw: installationRaw,
    };
    if (!validateFormClientSide(payload, isEdit)) return;

    var allowedBranches = parseAllowedBranches(qs('field-allowed').value, branch);
    var accessPolicy = installationRaw === '' ? null : { installationId: parseInt(installationRaw, 10) };

    var saveBtn = qs('form-save');
    saveBtn.disabled = true;

    var request;
    if (isEdit) {
      request = apiFetch(API_BASE + '/' + encodeURIComponent(state.editingId), 'PATCH', {
        repositoryUrl: payload.repositoryUrl,
        defaultBranch: branch,
        allowedBranches: allowedBranches,
        accessPolicy: accessPolicy,
        operator: operator,
      });
    } else {
      request = apiFetch(API_BASE, 'POST', {
        projectIdentifier: payload.projectIdentifier,
        repositoryId: payload.repositoryId,
        repositoryUrl: payload.repositoryUrl,
        defaultBranch: branch,
        allowedBranches: allowedBranches,
        accessPolicy: accessPolicy,
        operator: operator,
      });
    }

    request.then(function (result) {
      saveBtn.disabled = false;
      if (!result.ok) {
        qs('error-form').textContent = describeError(result);
        return;
      }
      closeFormModal();
      showBanner('success', isEdit ? 'Repository updated.' : 'Repository added.');
      loadEntries();
    });
  });

  qs('form-cancel').addEventListener('click', closeFormModal);
  qs('add-repository-btn').addEventListener('click', openAddModal);

  // ---- Delete (local test mode only, inactive entries only) ----

  function deleteEntry(entry, btn) {
    var operator = getOperatorName();
    if (!getToken() || !operator) { showBanner('error', 'Set your operator token and name first.'); return; }
    if (!window.confirm('Permanently delete ' + entry.repositoryId + ' (' + entry.repositoryUrl + ') for ' + entry.projectIdentifier + '?' +
      ' Runs already confirmed on it keep their own copy and are not affected. This cannot be undone.')) return;
    btn.disabled = true;
    apiFetch(API_BASE + '/' + encodeURIComponent(entry.id) + '/delete', 'POST', { operator: operator, confirm: entry.repositoryId }).then(function (result) {
      btn.disabled = false;
      if (!result.ok) {
        var d = result.data && result.data.detail;
        showBanner('error', result.status === 403 || result.status === 409 ? (d || describeError(result)) : describeError(result));
        return;
      }
      showBanner('success', 'Repository ' + entry.repositoryId + ' (' + entry.projectIdentifier + ') deleted.');
      loadEntries();
    });
  }

  // ---- Activate / Deactivate confirmation ----

  function openConfirmModal(entry) {
    state.pendingStatusChange = entry;
    var nextStatus = entry.status === 'active' ? 'inactive' : 'active';
    var verb = nextStatus === 'inactive' ? 'Deactivate' : 'Activate';
    qs('confirm-title').textContent = verb + ' repository?';
    qs('confirm-message').textContent = verb + ' repository ' + entry.repositoryId + ' (' + entry.repositoryUrl + ') for ' + entry.projectIdentifier + '?';
    qs('confirm-error').textContent = '';
    var okBtn = qs('confirm-ok');
    okBtn.textContent = verb;
    okBtn.className = nextStatus === 'inactive' ? 'danger' : 'primary';
    qs('confirm-overlay').className = 'overlay show';
  }

  function closeConfirmModal() {
    qs('confirm-overlay').className = 'overlay';
    state.pendingStatusChange = null;
  }

  qs('confirm-cancel').addEventListener('click', closeConfirmModal);

  qs('confirm-ok').addEventListener('click', function () {
    var entry = state.pendingStatusChange;
    if (!entry) return;
    var operator = getOperatorName();
    if (!getToken() || !operator) {
      qs('confirm-error').textContent = 'Set your operator token and name above first.';
      return;
    }
    var nextStatus = entry.status === 'active' ? 'inactive' : 'active';
    var action = nextStatus === 'inactive' ? 'deactivate' : 'reactivate';
    var okBtn = qs('confirm-ok');
    okBtn.disabled = true;
    apiFetch(API_BASE + '/' + encodeURIComponent(entry.id) + '/' + action, 'POST', { operator: operator }).then(function (result) {
      okBtn.disabled = false;
      if (!result.ok) {
        qs('confirm-error').textContent = describeError(result);
        return;
      }
      closeConfirmModal();
      showBanner('success', 'Repository ' + entry.repositoryId + ' is now ' + nextStatus + '.');
      loadEntries();
    });
  });

  // ---- Session bar ----

  qs('operator-token').value = getToken();
  qs('operator-name').value = getOperatorName();

  qs('save-session').addEventListener('click', function () {
    safeSessionSet(TOKEN_KEY, qs('operator-token').value.trim());
    safeSessionSet(NAME_KEY, qs('operator-name').value.trim());
    showBanner('info', 'Session saved for this browser tab.');
    loadEntries();
  });

  qs('status-filter').addEventListener('change', function () {
    state.filterStatus = qs('status-filter').value;
    loadEntries();
  });
  qs('refresh-btn').addEventListener('click', function () {
    clearBanner();
    loadEntries();
  });

  loadEntries();
})();
</script>
</body>
</html>
`;
