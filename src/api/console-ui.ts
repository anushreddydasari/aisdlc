/**
 * GET /console — the AISDLC Console: one page for tracking tickets, the
 * human gates, the Repository Registry and (local mock mode only) creating
 * test tickets.
 *
 * Same posture as repository-ui.ts: a single self-contained HTML/CSS/JS
 * document with no build step and no business logic of its own. Every
 * action goes through a pre-existing, operator-gated route:
 *
 *   Tickets       GET  /operator/tickets              (read-only, derived)
 *   Approvals     GET  /operator/queue
 *                 POST /intake/:issueKey/approve | /reject          Gate 1
 *                 POST /repository-selections/:runId/confirm        Gate 2
 *   Repositories  the existing /repositories page, embedded (?embedded=1)
 *   Test ticket   the local mock's /__mock/tickets (see below)
 *
 * TEST TICKETS. Real tickets arrive from Neutara as signed webhooks; the
 * service itself can never mint one. The Create tab therefore exists only
 * when the server passes `ticketCreatorUrl` — which it does only outside
 * production AND with NEUTARA_API_BASE_URL pointing at a loopback mock —
 * and it calls that mock (scripts/mock-ticket-creator.ts), which signs and
 * sends the webhook itself. The mock accepts this origin explicitly and
 * nothing else; the webhook secret never reaches the browser.
 *
 * The operator token lives in this tab's sessionStorage under the same keys
 * the Repository Management page uses, so the embedded page shares it.
 * Ticket content originates outside this service and is only ever rendered
 * via textContent.
 */

export interface ConsoleUiOptions {
  /** The local mock's origin in mock mode; null hides the Create tab entirely. */
  readonly ticketCreatorUrl: string | null;
  /** True when the GitHub App is configured, so POST /runs/:runId/coding-agent is mounted. */
  readonly codingAgentEnabled?: boolean;
}

export function renderConsoleUi(options: ConsoleUiOptions): string {
  // JSON, with '<' escaped so no value can close the <script> element.
  const config = JSON.stringify({ ticketCreatorUrl: options.ticketCreatorUrl, codingAgentEnabled: options.codingAgentEnabled === true }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AISDLC Console</title>
<style>
  :root {
    color-scheme: light;
    --bg: #f5f6f8;
    --panel: #ffffff;
    --border: #d9dde3;
    --text: #1b1f24;
    --muted: #5b6572;
    --accent: #2452c8;
    --accent-bg: #e9efff;
    --accent-contrast: #ffffff;
    --danger: #b3261e;
    --danger-bg: #fbeceb;
    --success: #1e7d32;
    --success-bg: #eaf5ec;
    --warn: #7a5200;
    --warn-bg: #fff6e0;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { background: var(--panel); border-bottom: 1px solid var(--border); padding: 12px 24px 0; position: sticky; top: 0; z-index: 5; }
  .top { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
  .top h1 { margin: 0; font-size: 18px; }
  .top .mode { color: var(--muted); font-size: 12px; }
  .auth { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .auth input { padding: 6px 9px; border: 1px solid var(--border); border-radius: 6px; font: inherit; width: 190px; }
  .auth .state { font-size: 12px; font-weight: 600; }
  .auth .state.ok { color: var(--success); }
  .auth .state.bad { color: var(--danger); }
  nav.tabs { display: flex; gap: 2px; margin-top: 10px; overflow-x: auto; }
  nav.tabs button { border: none; border-bottom: 3px solid transparent; background: none; padding: 9px 14px; font: inherit; font-weight: 600; color: var(--muted); cursor: pointer; white-space: nowrap; border-radius: 0; }
  nav.tabs button[aria-selected="true"] { color: var(--accent); border-bottom-color: var(--accent); }
  nav.tabs .count { display: inline-block; min-width: 20px; padding: 0 6px; margin-left: 6px; border-radius: 10px; background: var(--warn-bg); color: var(--warn); font-size: 12px; text-align: center; }
  nav.tabs .count:empty { display: none; }
  main { padding: 20px 24px; max-width: 1200px; }
  @media (max-width: 700px) { main { padding: 16px; } header { padding: 10px 16px 0; } .auth input { width: 150px; } }
  .panel[hidden] { display: none; }
  section { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 18px; margin-bottom: 18px; }
  h2 { margin: 0 0 4px; font-size: 16px; }
  .sub { color: var(--muted); margin: 0 0 14px; }
  button { font: inherit; border-radius: 6px; padding: 7px 14px; cursor: pointer; border: 1px solid var(--border); background: #fff; color: var(--text); }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-contrast); font-weight: 600; }
  button.approve { background: var(--success); border-color: var(--success); color: #fff; font-weight: 600; }
  button.reject { color: var(--danger); border-color: var(--danger); }
  button:disabled { opacity: .55; cursor: default; }
  input[type=text], select, textarea { padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; font: inherit; background: #fff; color: var(--text); }
  .banner { padding: 10px 12px; border-radius: 6px; margin-bottom: 14px; display: none; white-space: pre-wrap; }
  .banner.error { display: block; background: var(--danger-bg); color: var(--danger); }
  .banner.ok { display: block; background: var(--success-bg); color: var(--success); }
  .toolbar { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
  .meta { color: var(--muted); font-size: 12px; }
  .empty { color: var(--muted); margin: 0; }
  .key { font-family: ui-monospace, Consolas, monospace; font-weight: 700; }
  .badge { display: inline-block; padding: 1px 9px; border-radius: 10px; font-size: 12px; font-weight: 600; white-space: nowrap; }
  .tone-info { background: var(--accent-bg); color: var(--accent); }
  .tone-warn { background: var(--warn-bg); color: var(--warn); }
  .tone-danger { background: var(--danger-bg); color: var(--danger); }
  .tone-ok { background: var(--success-bg); color: var(--success); }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 9px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { font-size: 12px; color: var(--muted); font-weight: 600; }
  tr.ticket { cursor: pointer; }
  tr.ticket:hover td { background: #fafbfc; }
  tr.detail td { background: #fafbfc; padding: 4px 16px 16px; }
  .next { font-size: 12px; color: var(--muted); margin-top: 2px; }
  ol.timeline { list-style: none; margin: 8px 0 0; padding: 0; }
  ol.timeline li { position: relative; padding: 0 0 12px 26px; }
  ol.timeline li::before { content: ""; position: absolute; left: 6px; top: 5px; width: 10px; height: 10px; border-radius: 50%; background: var(--border); }
  ol.timeline li::after { content: ""; position: absolute; left: 10px; top: 17px; bottom: 0; width: 2px; background: var(--border); }
  ol.timeline li:last-child::after { display: none; }
  ol.timeline li.done::before { background: var(--success); }
  ol.timeline li.current::before { background: var(--warn); box-shadow: 0 0 0 3px var(--warn-bg); }
  ol.timeline li.failed::before { background: var(--danger); }
  ol.timeline .step { font-weight: 600; }
  ol.timeline li.todo .step { color: var(--muted); font-weight: 500; }
  ol.timeline .info { font-size: 12px; color: var(--muted); word-break: break-word; }
  .card { border: 1px solid var(--border); border-radius: 6px; padding: 14px; margin-bottom: 12px; }
  .card-head { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; flex-wrap: wrap; }
  .title { font-weight: 600; margin: 2px 0; }
  .desc { margin: 8px 0; white-space: pre-wrap; }
  details { margin: 8px 0; }
  summary { cursor: pointer; color: var(--accent); font-weight: 600; }
  .analysis h4 { margin: 10px 0 2px; font-size: 13px; }
  .analysis ul { margin: 2px 0; padding-left: 20px; }
  .actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 10px; }
  .actions input { flex: 1; min-width: 160px; }
  .candidate { display: flex; gap: 8px; align-items: baseline; padding: 6px 0; }
  .candidate .url { color: var(--muted); font-size: 12px; word-break: break-all; }
  .candidate.inactive { opacity: .55; }
  iframe.embedded { width: 100%; height: 1100px; border: 0; }
  .agent { margin-top: 12px; padding: 12px; border: 1px dashed var(--border); border-radius: 6px; background: #fff; }
  .agent h4 { margin: 0 0 6px; }
  .agent label { display: block; font-weight: 600; margin: 8px 0 4px; }
  .agent textarea { width: 100%; }
  pre.code { background: #0f1720; color: #e6edf3; padding: 10px 12px; border-radius: 6px; overflow: auto; max-height: 420px; font: 12px/1.45 ui-monospace, Consolas, monospace; white-space: pre; }
  .change { border-top: 1px solid var(--border); padding-top: 8px; margin-top: 8px; }
  .form label { display: block; font-weight: 600; margin: 12px 0 4px; }
  .form label .hint { font-weight: 400; color: var(--muted); }
  .form input, .form select, .form textarea { width: 100%; }
  .form textarea { min-height: 120px; resize: vertical; }
  .row3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; }
  .grid2 { display: grid; grid-template-columns: minmax(300px, 460px) 1fr; gap: 18px; }
  @media (max-width: 860px) { .grid2 { grid-template-columns: 1fr; } }
  .note { background: var(--warn-bg); color: var(--warn); padding: 10px 12px; border-radius: 6px; margin-bottom: 8px; }
  a { color: var(--accent); }
</style>
</head>
<body>
<header>
  <div class="top">
    <div>
      <h1>AISDLC Console</h1>
      <div class="mode" id="mode"></div>
    </div>
    <div class="auth">
      <input id="token" type="password" placeholder="Operator token" autocomplete="off" aria-label="Operator token">
      <input id="name" type="text" placeholder="Your name" aria-label="Your name">
      <button class="primary" id="save" type="button">Save</button>
      <span class="state" id="auth-state"></span>
    </div>
  </div>
  <nav class="tabs" role="tablist">
    <button role="tab" data-tab="tickets" aria-selected="true">Tickets</button>
    <button role="tab" data-tab="approvals" aria-selected="false">Approvals<span class="count" id="approvals-count"></span></button>
    <button role="tab" data-tab="repositories" aria-selected="false">Repositories</button>
    <button role="tab" data-tab="create" aria-selected="false" id="create-tab" hidden>Create test ticket</button>
  </nav>
</header>
<main>
  <div class="banner" id="banner" role="status"></div>

  <div class="panel" data-panel="tickets">
    <section>
      <div class="toolbar">
        <div><h2>Tickets</h2><p class="sub" style="margin:0">Every recent ticket and where it is in the pipeline. Click a row for its timeline.</p></div>
        <div><input type="text" id="filter" placeholder="Filter by key, title or space" aria-label="Filter tickets"> <span class="meta" id="updated"></span> <button id="refresh" type="button">Refresh</button> <button id="delete-shown" class="reject" type="button" hidden>Delete all shown</button></div>
      </div>
      <div class="note" id="tickets-warning" hidden></div>
      <div id="tickets"><p class="empty">Enter the operator token above and click Save.</p></div>
    </section>
  </div>

  <div class="panel" data-panel="approvals" hidden>
    <section>
      <h2>Gate 1 · Requirements approval</h2>
      <p class="sub">Tickets the Requirements Agent has analyzed, waiting for a human decision.</p>
      <div id="gate1"><p class="empty">Enter the operator token above and click Save.</p></div>
    </section>
    <section>
      <h2>Gate 2 · Repository confirmation</h2>
      <p class="sub">Approved tickets matched against the Repository Registry by space key. The service never picks a repository on its own — even a single match waits here.</p>
      <div id="gate2"><p class="empty">Enter the operator token above and click Save.</p></div>
    </section>
    <section>
      <h2>Gate 3 · Review proposed change</h2>
      <p class="sub">What the Coding Agent wants to commit — every file, in full. Nothing is written to GitHub until you approve; approving lets the pipeline apply, validate and open a pull request.</p>
      <div id="gate3"><p class="empty">Enter the operator token above and click Save.</p></div>
    </section>
    <section>
      <h2>Recently confirmed repositories</h2>
      <p class="sub">The repository each run is locked to — a snapshot taken at confirmation, unaffected by later registry edits.</p>
      <div id="recent"><p class="empty">Enter the operator token above and click Save.</p></div>
    </section>
  </div>

  <div class="panel" data-panel="repositories" hidden>
    <section style="padding:8px">
      <iframe class="embedded" id="repo-frame" title="Repository Management" data-src="/repositories?embedded=1"></iframe>
    </section>
  </div>

  <div class="panel" data-panel="create" hidden>
    <div class="grid2">
      <section class="form">
        <h2>New test ticket</h2>
        <p class="sub">Local mock mode only. The mock stores the ticket and sends a signed <code>issue.created</code> webhook to this service — the same path a real Neutara ticket takes.</p>
        <div class="note">The <strong>space key</strong> decides which repositories it can match. Check the Repositories tab has an active entry for it.</div>
        <label for="c-summary">Summary</label>
        <input id="c-summary" type="text" maxlength="512" placeholder="Add a contact section to the README">
        <label for="c-description">Description <span class="hint">— what the Requirements Agent analyzes</span></label>
        <textarea id="c-description" maxlength="20000" placeholder="Describe the change, acceptance criteria, affected files…"></textarea>
        <div class="row3">
          <div><label for="c-type">Type</label><select id="c-type"><option>task</option><option>bug</option><option>story</option><option>epic</option></select></div>
          <div><label for="c-priority">Priority</label><select id="c-priority"><option>low</option><option selected>medium</option><option>high</option><option>critical</option></select></div>
          <div><label for="c-space">Space key</label><input id="c-space" type="text" value="LOCAL" maxlength="20"></div>
        </div>
        <label for="c-labels">Labels <span class="hint">— comma separated, optional; informational only</span></label>
        <input id="c-labels" type="text" placeholder="local, ui-test">
        <div class="actions"><button class="primary" id="c-submit" type="button">Create ticket &amp; send webhook</button></div>
      </section>
      <section>
        <div class="toolbar"><h2 style="margin:0">Created this mock session</h2><button id="c-refresh" type="button">Refresh</button></div>
        <div id="created"><p class="empty">No tickets yet.</p></div>
      </section>
    </div>
  </div>
</main>
<script>
(function () {
  'use strict';
  var CONFIG = ${config};
  var TOKEN_KEY = 'aisdlc_operator_token';
  var NAME_KEY = 'aisdlc_operator_name';
  var TAB_KEY = 'aisdlc_console_tab';
  var REFRESH_MS = 15000;

  function qs(id) { return document.getElementById(id); }
  function sget(k) { try { return sessionStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function sset(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* storage blocked: not remembered */ } }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function when(d) { return d ? new Date(d).toLocaleString() : ''; }
  function plainText(html) {
    if (!html) return '';
    var doc = new DOMParser().parseFromString(String(html).replace(/<br\\s*\\/?>/gi, '\\n').replace(/<\\/p>/gi, '</p>\\n'), 'text/html');
    return (doc.body.textContent || '').trim();
  }

  var banner = qs('banner');
  function show(kind, text) { banner.className = 'banner ' + kind; banner.textContent = text; window.scrollTo({ top: 0, behavior: 'smooth' }); }
  function clear() { banner.className = 'banner'; banner.textContent = ''; }

  function api(method, path, body) {
    var headers = { authorization: 'Bearer ' + sget(TOKEN_KEY) };
    if (body !== undefined) headers['content-type'] = 'application/json';
    return fetch(path, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { status: r.status, data: d }; }); });
  }
  function explain(r) {
    if (r.status === 401) return 'Unauthorized — check the operator token.';
    if (r.status === 409) return 'Conflict — it changed since this page loaded' + (r.data.detail ? ': ' + r.data.detail : '') + '. Refreshed.';
    if (r.status === 503) return 'The service cannot reach the database right now.';
    if (r.status === 400) return 'Rejected: ' + (r.data.detail || r.data.field || 'invalid request');
    return 'Failed: HTTP ' + r.status + (r.data.error ? ' (' + r.data.error + ')' : '');
  }
  function requireName() {
    var name = sget(NAME_KEY).trim();
    if (!name) { show('error', 'Enter your name at the top and click Save first — every decision is attributed to a person.'); return null; }
    return name;
  }
  function setAuth(ok, text) { var s = qs('auth-state'); s.className = 'state ' + (ok ? 'ok' : 'bad'); s.textContent = text; }

  // ── Where a ticket is ───────────────────────────────────────────────
  var STAGES = {
    queued: ['Queued — matching a repository', 'info'],
    repository_selection: ['Gate 2 · confirm repository', 'warn'],
    repository_selection_failed: ['No repository matched', 'danger'],
    repository_confirmed: ['Repository confirmed', 'ok'],
    change_review: ['Gate 3 · review proposed change', 'warn'],
    change_rejected: ['Change rejected', 'danger'],
    executing: ['Applying & validating change', 'info'],
    execution_failed: ['Execution failed', 'danger'],
    publishing: ['Opening pull request', 'info'],
    publish_failed: ['Publish failed', 'danger'],
    awaiting_human_merge: ['Gate 4 · merge the pull request', 'warn'],
    pr_closed_unmerged: ['PR closed without merge', 'danger'],
    deployment_eligible: ['Merged — deployment eligible', 'ok'],
    deploying: ['Deploying', 'info'],
    deployment_failed: ['Deployment failed', 'danger'],
    deployment_validation_failed: ['Post-deploy validation failed', 'danger'],
    deployed: ['Deployed', 'ok'],
    failed: ['Run failed', 'danger'],
    cancelled: ['Cancelled', 'danger']
  };
  function position(t) {
    if (t.run) {
      var s = STAGES[t.run.stage] || [t.run.stage, 'info'];
      if (t.run.stage === 'repository_confirmed') return { label: s[0], tone: s[1], next: 'Next: Coding Agent (needs the GitHub App configured, then triggered with file paths)' };
      return { label: s[0], tone: s[1], next: t.run.humanActionDescription || t.run.failureMessage || '' };
    }
    switch (t.intakeStatus) {
      case 'received': return { label: 'Analyzing requirements', tone: 'info', next: 'The Requirements Agent runs within ~30s' };
      case 'pending_approval': return { label: 'Gate 1 · awaiting approval', tone: 'warn', next: 'Approve or reject it in the Approvals tab' };
      case 'approved': return { label: 'Approved — queuing run', tone: 'info', next: 'A run is created within ~30s' };
      case 'rejected': return { label: 'Rejected', tone: 'danger', next: t.statusReason || '' };
      default: return { label: t.intakeStatus, tone: 'info', next: t.statusReason || '' };
    }
  }

  function step(list, state, title, info) {
    var li = el('li', state);
    li.appendChild(el('div', 'step', title));
    if (info) li.appendChild(el('div', 'info', info));
    list.appendChild(li);
  }
  function timeline(t) {
    var ol = el('ol', 'timeline');
    var r = t.run, repo = t.repository, a = t.analysis;
    step(ol, 'done', 'Ticket received', when(t.receivedAt) + (t.project ? ' · space ' + t.project : ''));
    step(ol, a && a.status === 'completed' ? 'done' : a && a.status === 'failed' ? 'failed' : 'current', 'Requirements analyzed',
      a ? a.status + ' · ' + a.agentVersion + (a.completedAt ? ' · ' + when(a.completedAt) : '') : 'waiting');
    var g1 = t.intakeStatus === 'rejected' ? 'failed' : t.approvedBy ? 'done' : t.intakeStatus === 'pending_approval' ? 'current' : 'todo';
    step(ol, g1, 'Gate 1 · approved by a human', t.approvedBy ? t.approvedBy + ' · ' + when(t.approvedAt) : t.intakeStatus === 'rejected' ? 'rejected' + (t.statusReason ? ': ' + t.statusReason : '') : '');
    step(ol, repo ? (repo.selectionStatus === 'failed' ? 'failed' : 'done') : r ? 'current' : 'todo', 'Repository matched by space key',
      repo ? (repo.candidates.length ? 'candidates: ' + repo.candidates.join(', ') : 'no active repository for this space key') : '');
    step(ol, repo && repo.selectedRepositoryId ? 'done' : repo && repo.selectionStatus !== 'failed' ? 'current' : 'todo', 'Gate 2 · repository confirmed',
      repo && repo.selectedRepositoryId ? repo.selectedRepositoryId + ' · ' + repo.selectedRepositoryUrl + ' · branch ' + repo.selectedDefaultBranch + ' · ' + repo.confirmedBy : '');
    var rs = r && r.reviewStatus;
    step(ol, rs === 'approved' ? 'done' : rs === 'rejected' ? 'failed' : rs ? 'current' : 'todo', 'Coding Agent proposal · Gate 3 review', rs ? 'review ' + rs : '');
    var es = r && r.executionStatus;
    step(ol, es === 'succeeded' ? 'done' : es === 'failed' ? 'failed' : es ? 'current' : 'todo', 'Change applied & validated', es || '');
    step(ol, r && r.pullRequestUrl ? 'done' : r && r.stage === 'publish_failed' ? 'failed' : r && r.stage === 'publishing' ? 'current' : 'todo', 'Pull request opened', r && r.pullRequestUrl ? '#' + r.pullRequestNumber + ' ' + r.pullRequestUrl : '');
    var ds = r && r.deploymentStatus;
    step(ol, r && r.mergeCommitSha ? 'done' : r && r.stage === 'awaiting_human_merge' ? 'current' : 'todo', 'Gate 4 · merged by a human', r && r.mergeCommitSha ? r.mergeCommitSha : '');
    step(ol, r && r.stage === 'deployed' ? 'done' : ds ? 'current' : 'todo', 'Deployed', ds || '');
    if (r && r.failureMessage) step(ol, 'failed', 'Failure', (r.failureCategory ? r.failureCategory + ': ' : '') + r.failureMessage);
    return ol;
  }

  // Test mode (the server enabled the mock ticket creator) is also the only
  // mode in which the server mounts the delete route.
  var testMode = !!CONFIG.ticketCreatorUrl;

  // Deletes one ticket; resolves to the API result. The body repeats the key
  // as \`confirm\`, which the server requires.
  function deleteTicket(key, name) {
    return api('POST', '/operator/tickets/' + encodeURIComponent(key) + '/delete', { operator: name, confirm: key });
  }
  function explainDelete(key, r) {
    if (r.status === 403) return key + ': not deleted — ' + (r.data.detail || 'permission denied');
    if (r.status === 404) return key + ': already gone.';
    return key + ': ' + explain(r);
  }

  // One Delete button, used by the Tickets, Gate 2 and Recently-confirmed lists.
  function deleteButton(key, title) {
    var del = el('button', 'reject', 'Delete');
    del.type = 'button';
    del.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var name = requireName();
      if (!name) return;
      if (!window.confirm('Delete ' + key + (title ? ' (' + title + ')' : '') + '?\\n\\nThis removes the ticket, its analysis, run and repository selection from the test database. It cannot be undone. The audit log keeps its history and records that you deleted it.')) return;
      del.disabled = true;
      deleteTicket(key, name).then(function (r) {
        if (r.status === 200) show('ok', key + ' deleted by operator:' + name + '.');
        else show('error', explainDelete(key, r));
        loadAll(true);
      }, function (e) { show('error', 'Could not reach the service: ' + e.message); del.disabled = false; });
    });
    return del;
  }

  // ── Coding Agent (after Gate 2) ─────────────────────────────────────
  // Which files the agent may read and change is a human decision (there is
  // no repository file discovery yet — see pipeline/coding-agent-trigger.ts),
  // so the operator lists them here.
  var fileDrafts = {};
  function codingAgentPanel(t) {
    var box = el('div', 'agent');
    box.addEventListener('click', function (ev) { ev.stopPropagation(); });
    box.appendChild(el('h4', '', t.run.stage === 'change_rejected' ? 'Run the Coding Agent again' : 'Next: run the Coding Agent'));
    if (!CONFIG.codingAgentEnabled) {
      box.appendChild(el('p', 'note', 'The Coding Agent is off because the GitHub App is not configured. Run  npm run github:configure -- <app-id> <path-to-key.pem>  and restart the service; this button then appears.'));
      return box;
    }
    var repo = t.repository || {};
    box.appendChild(el('p', 'meta', 'It reads the listed files from ' + (repo.selectedRepositoryUrl || 'the confirmed repository') + ' (branch ' + (repo.selectedDefaultBranch || '?') +
      '), proposes changes for Gate 3 review, and changes nothing until a human approves them.'));
    var label = el('label', '', 'Files it may read and change (comma or new line; new files allowed)');
    label.htmlFor = 'files-' + t.run.runId;
    var files = el('textarea');
    files.id = 'files-' + t.run.runId;
    files.rows = 3;
    // A visible "e.g." so the hint is never mistaken for a filled-in value,
    // and the typed text survives the 15s refresh re-rendering this panel.
    files.placeholder = 'e.g. index.html, styles.css';
    files.value = fileDrafts[t.run.runId] || '';
    files.addEventListener('input', function () { fileDrafts[t.run.runId] = files.value; });
    var actions = el('div', 'actions'), run = el('button', 'primary', 'Run Coding Agent');
    run.type = 'button';
    run.addEventListener('click', function () {
      var paths = files.value.split(/[,\\n]/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (!paths.length) { show('error', 'The file box is empty — type the file names into it (for example: index.html), then click Run Coding Agent.'); files.focus(); return; }
      if (paths.length > 25) { show('error', 'At most 25 files per run.'); return; }
      // The API records who ran it: operator is required, like every gate.
      var name = requireName();
      if (!name) return;
      run.disabled = true;
      run.textContent = 'Running… (can take up to a minute)';
      api('POST', '/runs/' + encodeURIComponent(t.run.runId) + '/coding-agent', { candidateFilePaths: paths, operator: name }).then(function (r) {
        if (r.status === 201 || r.status === 200) {
          show('ok', t.issueKey + ': the Coding Agent proposed ' + r.data.changeCount + ' change(s)' + (r.data.created ? '' : ' (same proposal as before)') + '. Review it under Approvals → Gate 3.');
        } else if (r.status === 404) {
          show('error', t.issueKey + ': the Coding Agent is not available on the service — restart it after configuring the GitHub App.');
        } else {
          show('error', t.issueKey + ': Coding Agent failed — ' + (r.data.detail || explain(r)) + (r.data.retryable ? ' (retryable)' : ''));
        }
        loadAll(true);
      }, function (e) { show('error', 'Could not reach the service: ' + e.message); })
        .then(function () { run.disabled = false; run.textContent = 'Run Coding Agent'; });
    });
    box.appendChild(label);
    box.appendChild(files);
    actions.appendChild(run);
    box.appendChild(actions);
    return box;
  }

  var tickets = [], openKey = null;
  function visibleTickets() {
    var f = qs('filter').value.trim().toLowerCase();
    return tickets.filter(function (t) { return !f || (t.issueKey + ' ' + t.title + ' ' + (t.project || '')).toLowerCase().indexOf(f) >= 0; });
  }
  function renderTickets() {
    var root = qs('tickets');
    root.textContent = '';
    var rows = visibleTickets();
    qs('delete-shown').hidden = !testMode || !rows.length;
    qs('delete-shown').textContent = 'Delete all shown (' + rows.length + ')';
    if (!rows.length) { root.appendChild(el('p', 'empty', tickets.length ? 'No tickets match the filter.' : 'No tickets yet.')); return; }
    var wrap = el('div', 'table-wrap'), table = el('table'), head = el('tr');
    ['Ticket', 'Title', 'Space', 'Where it is', 'Repository', 'Received'].concat(testMode ? [''] : []).forEach(function (h) { head.appendChild(el('th', '', h)); });
    table.appendChild(head);
    rows.forEach(function (t) {
      var p = position(t), tr = el('tr', 'ticket');
      tr.appendChild(el('td', 'key', t.issueKey));
      tr.appendChild(el('td', '', t.title));
      tr.appendChild(el('td', '', t.project || '—'));
      var where = el('td');
      where.appendChild(el('span', 'badge tone-' + p.tone, p.label));
      if (p.next) where.appendChild(el('div', 'next', p.next));
      tr.appendChild(where);
      var repo = t.repository;
      tr.appendChild(el('td', '', repo ? (repo.selectedRepositoryId || (repo.candidates.length ? repo.candidates.join(' / ') + ' (unconfirmed)' : 'none matched')) : '—'));
      tr.appendChild(el('td', 'meta', when(t.receivedAt)));
      if (testMode) {
        var cell = el('td');
        cell.appendChild(deleteButton(t.issueKey, t.title));
        tr.appendChild(cell);
      }
      tr.addEventListener('click', function () { openKey = openKey === t.issueKey ? null : t.issueKey; renderTickets(); });
      table.appendChild(tr);
      if (openKey === t.issueKey) {
        var dr = el('tr', 'detail'), td = el('td');
        td.colSpan = testMode ? 7 : 6;
        td.appendChild(timeline(t));
        // A confirmed run (or one whose proposal was rejected) can have the
        // Coding Agent run — again, for a rejected one.
        if (t.run && (t.run.stage === 'repository_confirmed' || t.run.stage === 'change_rejected')) td.appendChild(codingAgentPanel(t));
        if (p.tone === 'warn' && (t.intakeStatus === 'pending_approval' || (t.run && (t.run.stage === 'repository_selection' || t.run.stage === 'change_review')))) {
          var go = el('button', 'primary', 'Open in Approvals');
          go.type = 'button';
          go.addEventListener('click', function (ev) { ev.stopPropagation(); selectTab('approvals'); });
          td.appendChild(go);
        }
        dr.appendChild(td);
        table.appendChild(dr);
      }
    });
    wrap.appendChild(table);
    root.appendChild(wrap);
  }
  qs('filter').addEventListener('input', renderTickets);

  // Bulk: one request per ticket, in order, stopping at the first refusal
  // (a missing permission would refuse every one the same way).
  qs('delete-shown').addEventListener('click', function () {
    var name = requireName();
    if (!name) return;
    var keys = visibleTickets().map(function (t) { return t.issueKey; });
    if (!keys.length) return;
    var typed = window.prompt('Delete ' + keys.length + ' ticket(s) from the test database?\\n\\n' + keys.join(', ') +
      '\\n\\nThis cannot be undone. Type DELETE to confirm.');
    if (typed !== 'DELETE') return;
    var btn = qs('delete-shown'), done = 0;
    btn.disabled = true;
    function next(i) {
      if (i >= keys.length) { show('ok', 'Deleted ' + done + ' ticket(s), by operator:' + name + '.'); return Promise.resolve(); }
      return deleteTicket(keys[i], name).then(function (r) {
        if (r.status === 200 || r.status === 404) { done++; return next(i + 1); }
        show('error', 'Stopped after ' + done + ' of ' + keys.length + '. ' + explainDelete(keys[i], r));
      });
    }
    next(0).then(null, function (e) { show('error', 'Could not reach the service: ' + e.message); })
      .then(function () { btn.disabled = false; loadAll(true); });
  });

  // ── Approvals ───────────────────────────────────────────────────────
  function list(parent, heading, items) {
    if (!items || !items.length) return;
    parent.appendChild(el('h4', '', heading));
    var ul = el('ul');
    items.forEach(function (i) { ul.appendChild(el('li', '', i)); });
    parent.appendChild(ul);
  }
  function renderAnalysis(card, analysis) {
    if (!analysis) { card.appendChild(el('p', 'meta', 'No requirements analysis found.')); return; }
    var det = el('details');
    det.appendChild(el('summary', '', 'Requirements analysis (' + analysis.status + ', ' + analysis.agentVersion + ')'));
    var box = el('div', 'analysis'), r = analysis.result || {};
    if (r.summary) { box.appendChild(el('h4', '', 'Summary')); box.appendChild(el('div', '', r.summary)); }
    if (r.problemStatement) { box.appendChild(el('h4', '', 'Problem')); box.appendChild(el('div', '', r.problemStatement)); }
    list(box, 'Functional requirements', r.functionalRequirements);
    list(box, 'Acceptance criteria', r.acceptanceCriteria);
    list(box, 'Assumptions', r.assumptions);
    list(box, 'Risks', r.risks);
    if (r.suggestedArea) { box.appendChild(el('h4', '', 'Suggested area')); box.appendChild(el('div', '', r.suggestedArea)); }
    det.appendChild(box);
    det.open = true;
    card.appendChild(det);
  }
  function renderGate1(items) {
    var root = qs('gate1');
    root.textContent = '';
    if (!items.length) { root.appendChild(el('p', 'empty', 'Nothing waiting for approval.')); return; }
    items.forEach(function (t) {
      var card = el('div', 'card'), head = el('div', 'card-head');
      head.appendChild(el('span', 'key', t.issueKey));
      head.appendChild(el('span', 'meta', 'received ' + when(t.receivedAt)));
      card.appendChild(head);
      card.appendChild(el('div', 'title', t.title));
      card.appendChild(el('div', 'meta', [t.issueType, t.priority, t.project ? 'space ' + t.project : 'no space key'].filter(Boolean).join(' · ') + (t.labels && t.labels.length ? ' · ' + t.labels.join(', ') : '')));
      var d = plainText(t.description);
      if (d) card.appendChild(el('div', 'desc', d));
      renderAnalysis(card, t.analysis);
      var actions = el('div', 'actions'), reason = el('input');
      reason.type = 'text';
      reason.placeholder = 'Reason (optional, recorded in the audit log)';
      reason.maxLength = 500;
      var approve = el('button', 'approve', 'Approve'), reject = el('button', 'reject', 'Reject');
      approve.type = reject.type = 'button';
      function decide(action) {
        var name = requireName();
        if (!name) return;
        if (action === 'reject' && !window.confirm('Reject ' + t.issueKey + '? This ends its pipeline.')) return;
        approve.disabled = reject.disabled = true;
        var body = { operator: name };
        if (reason.value.trim()) body.reason = reason.value.trim();
        api('POST', '/intake/' + encodeURIComponent(t.issueKey) + '/' + action, body).then(function (r) {
          if (r.status === 200) show('ok', t.issueKey + ' ' + (action === 'approve' ? 'approved' : 'rejected') + ' by operator:' + name +
            (action === 'approve' ? '. A run is queued and matched to a repository within ~60s — it will appear under Gate 2.' : '.'));
          else show('error', t.issueKey + ': ' + explain(r));
          loadAll(true);
        }, function (e) { show('error', 'Could not reach the service: ' + e.message); approve.disabled = reject.disabled = false; });
      }
      approve.addEventListener('click', function () { decide('approve'); });
      reject.addEventListener('click', function () { decide('reject'); });
      actions.appendChild(reason);
      actions.appendChild(approve);
      actions.appendChild(reject);
      card.appendChild(actions);
      root.appendChild(card);
    });
  }
  function renderGate2(items) {
    var root = qs('gate2');
    root.textContent = '';
    if (!items.length) { root.appendChild(el('p', 'empty', 'Nothing waiting for a repository.')); return; }
    items.forEach(function (s) {
      var card = el('div', 'card'), head = el('div', 'card-head'), left = el('div');
      left.appendChild(el('span', 'key', s.issueKey));
      left.appendChild(el('span', 'meta', '  run ' + s.runId));
      head.appendChild(left);
      var activeCount = s.candidates.filter(function (x) { return x.active; }).length;
      var stuck = s.status !== 'failed' && activeCount === 0;
      var tone = s.status === 'failed' || stuck ? 'danger' : 'warn';
      head.appendChild(el('span', 'badge tone-' + tone, stuck ? 'no active candidate' : s.status === 'pending' ? '1 match — confirm' : s.status === 'ambiguous' ? s.candidates.length + ' matches — pick one' : 'no match'));
      card.appendChild(head);
      card.appendChild(el('div', 'meta', 'space ' + (s.projectIdentifier || '(none)') + ' · updated ' + when(s.updatedAt)));
      function finishWithDeleteOnly() {
        if (testMode) { var a = el('div', 'actions'); a.appendChild(deleteButton(s.issueKey)); card.appendChild(a); }
        root.appendChild(card);
      }
      if (s.status === 'failed') {
        card.appendChild(el('p', 'desc', (s.failureReason || 'No active repository matched.') + ' Register one for this space key in the Repositories tab; the service retries automatically.'));
        finishWithDeleteOnly();
        return;
      }
      if (stuck) {
        var ids = s.candidates.map(function (c) { return c.repositoryId; }).join(', ');
        card.appendChild(el('p', 'desc', 'Matched ' + ids + ', which is no longer active in the registry, so it cannot be confirmed. Reactivate it in the Repositories tab to confirm this run.'));
        finishWithDeleteOnly();
        return;
      }
      var group = 'sel-' + s.runId;
      s.candidates.forEach(function (c) {
        var row = el('label', 'candidate' + (c.active ? '' : ' inactive')), radio = el('input');
        radio.type = 'radio';
        radio.name = group;
        radio.value = c.repositoryId;
        radio.disabled = !c.active;
        if (c.active && activeCount === 1) radio.checked = true;
        row.appendChild(radio);
        var text = el('div');
        text.appendChild(el('strong', '', c.repositoryId));
        text.appendChild(el('div', 'url', c.active ? c.repositoryUrl + ' · default branch ' + c.defaultBranch : 'no longer active in the registry — cannot be chosen'));
        row.appendChild(text);
        card.appendChild(row);
      });
      var actions = el('div', 'actions'), btn = el('button', 'primary', 'Confirm repository');
      btn.type = 'button';
      btn.addEventListener('click', function () {
        var name = requireName();
        if (!name) return;
        var picked = card.querySelector('input[name="' + group + '"]:checked');
        if (!picked) { show('error', s.issueKey + ': choose a repository first.'); return; }
        btn.disabled = true;
        api('POST', '/repository-selections/' + encodeURIComponent(s.runId) + '/confirm', { repositoryId: picked.value, operator: name }).then(function (r) {
          if (r.status === 200) show('ok', s.issueKey + ' is locked to ' + r.data.selectedRepositoryId + ' (' + r.data.selectedRepositoryUrl + ', branch ' + r.data.selectedDefaultBranch + '), confirmed by ' + r.data.confirmedBy + '.');
          else show('error', s.issueKey + ': ' + explain(r));
          loadAll(true);
        }, function (e) { show('error', 'Could not reach the service: ' + e.message); btn.disabled = false; });
      });
      actions.appendChild(btn);
      if (testMode) actions.appendChild(deleteButton(s.issueKey));
      card.appendChild(actions);
      root.appendChild(card);
    });
  }
  function renderGate3(items) {
    var root = qs('gate3');
    root.textContent = '';
    if (!items.length) {
      root.appendChild(el('p', 'empty', CONFIG.codingAgentEnabled ? 'Nothing waiting for review.' : 'Nothing waiting for review. (The Coding Agent is off until the GitHub App is configured.)'));
      return;
    }
    items.forEach(function (rv) {
      var card = el('div', 'card'), head = el('div', 'card-head'), left = el('div');
      var ticket = tickets.filter(function (t) { return t.run && t.run.runId === rv.runId; })[0];
      left.appendChild(el('span', 'key', ticket ? ticket.issueKey : 'run ' + rv.runId));
      left.appendChild(el('span', 'meta', '  ' + rv.repository + ' · branch ' + rv.branch));
      head.appendChild(left);
      head.appendChild(el('span', 'badge tone-warn', rv.proposedChanges.length + ' file(s) — review'));
      card.appendChild(head);
      if (ticket) card.appendChild(el('div', 'title', ticket.title));
      var plan = rv.plan || {};
      if (plan.summary) card.appendChild(el('div', 'desc', plan.summary));
      var det = el('details');
      det.appendChild(el('summary', '', 'Plan'));
      var box = el('div', 'analysis');
      if (plan.requirementsUnderstanding) { box.appendChild(el('h4', '', 'Understanding')); box.appendChild(el('div', '', plan.requirementsUnderstanding)); }
      list(box, 'Steps', (plan.items || []).map(function (i) { return i.operation + ' ' + i.filePath + ' — ' + i.changeDescription; }));
      list(box, 'Tests required', plan.testsRequired);
      list(box, 'Impact', plan.dependenciesAndImpact);
      list(box, 'Assumptions', plan.assumptions);
      list(box, 'Risks', plan.risks);
      det.appendChild(box);
      card.appendChild(det);
      rv.proposedChanges.forEach(function (c) {
        var ch = el('div', 'change');
        ch.appendChild(el('div', '', ''));
        ch.firstChild.appendChild(el('strong', '', (c.operation === 'create' ? 'New file ' : 'Change ') + c.filePath));
        ch.appendChild(el('div', 'meta', c.reason));
        var cd = el('details');
        cd.appendChild(el('summary', '', 'Proposed content (' + c.proposedContent.split('\\n').length + ' lines)'));
        cd.appendChild(el('pre', 'code', c.proposedContent));
        ch.appendChild(cd);
        card.appendChild(ch);
      });
      var actions = el('div', 'actions'), comment = el('input');
      comment.type = 'text';
      comment.placeholder = 'Comment (optional, recorded in the audit log)';
      comment.maxLength = 500;
      var approve = el('button', 'approve', 'Approve change'), reject = el('button', 'reject', 'Reject');
      approve.type = reject.type = 'button';
      function decide(action) {
        var name = requireName();
        if (!name) return;
        if (action === 'approve' && !window.confirm('Approve this change? The pipeline will then commit it to a new branch on ' + rv.repository + ' and open a pull request (it never merges).')) return;
        if (action === 'reject' && !window.confirm('Reject this proposal? You can run the Coding Agent again from the ticket.')) return;
        approve.disabled = reject.disabled = true;
        var body = { operator: name };
        if (comment.value.trim()) body.comment = comment.value.trim();
        api('POST', '/change-reviews/' + encodeURIComponent(rv.reviewId) + '/' + action, body).then(function (r) {
          if (r.status === 200) show('ok', (ticket ? ticket.issueKey : 'Review') + ' change ' + (action === 'approve' ? 'approved' : 'rejected') + ' by operator:' + name +
            (action === 'approve' ? '. The pipeline applies it, validates, and opens a pull request within ~30s — track it in the Tickets tab.' : '.'));
          else show('error', explain(r));
          loadAll(true);
        }, function (e) { show('error', 'Could not reach the service: ' + e.message); approve.disabled = reject.disabled = false; });
      }
      approve.addEventListener('click', function () { decide('approve'); });
      reject.addEventListener('click', function () { decide('reject'); });
      actions.appendChild(comment);
      actions.appendChild(approve);
      actions.appendChild(reject);
      card.appendChild(actions);
      root.appendChild(card);
    });
  }
  function renderRecent(items) {
    var root = qs('recent');
    root.textContent = '';
    if (!items.length) { root.appendChild(el('p', 'empty', 'No confirmed runs yet.')); return; }
    var wrap = el('div', 'table-wrap'), table = el('table'), head = el('tr');
    ['Ticket', 'Repository', 'Branch', 'Confirmed by', 'When'].concat(testMode ? [''] : []).forEach(function (h) { head.appendChild(el('th', '', h)); });
    table.appendChild(head);
    items.forEach(function (s) {
      var tr = el('tr'), repo = el('td');
      tr.appendChild(el('td', 'key', s.issueKey));
      repo.appendChild(el('strong', '', s.selectedRepositoryId));
      repo.appendChild(el('div', 'meta', s.selectedRepositoryUrl));
      tr.appendChild(repo);
      tr.appendChild(el('td', '', s.selectedDefaultBranch));
      tr.appendChild(el('td', '', s.confirmedBy));
      tr.appendChild(el('td', 'meta', when(s.confirmedAt)));
      if (testMode) { var cell = el('td'); cell.appendChild(deleteButton(s.issueKey)); tr.appendChild(cell); }
      table.appendChild(tr);
    });
    wrap.appendChild(table);
    root.appendChild(wrap);
  }

  // ── Loading ─────────────────────────────────────────────────────────
  // loadError: the banner currently shows a failed load (not a decision's
  // result), so the next successful load clears it.
  var loading = false, lastTickets = '', lastQueue = '', loadError = false;
  // force: a Save, Refresh or decision. The timer re-renders only on change,
  // so a reason being typed or a repository being picked is not wiped.
  function loadAll(force) {
    if (!sget(TOKEN_KEY)) { setAuth(false, 'no token'); return Promise.resolve(); }
    if (loading) return Promise.resolve();
    loading = true;
    return Promise.all([api('GET', '/operator/tickets'), api('GET', '/operator/queue')]).then(function (rs) {
      var tr = rs[0], qr = rs[1];
      if (tr.status !== 200 || qr.status !== 200) {
        var bad = tr.status !== 200 ? tr : qr;
        setAuth(false, bad.status === 401 ? 'unauthorized' : 'error');
        show('error', explain(bad));
        loadError = true;
        return;
      }
      setAuth(true, 'signed in as ' + (sget(NAME_KEY) || '(no name)'));
      if (loadError) { clear(); loadError = false; }
      qs('updated').textContent = 'updated ' + new Date().toLocaleTimeString();
      var ts = JSON.stringify(tr.data), qsig = JSON.stringify(qr.data);
      if (force === true || ts !== lastTickets) {
        lastTickets = ts;
        tickets = tr.data.tickets || [];
        var warn = qs('tickets-warning'), w = tr.data.warnings || [];
        warn.hidden = !w.length;
        warn.textContent = w.length ? 'Stages after Gate 2 could not be read, so they may show as not started — the service\\'s database role is missing a permission: ' + w.join('; ') : '';
        renderTickets();
      }
      if (force === true || qsig !== lastQueue) {
        lastQueue = qsig;
        var q = qr.data, n = (q.pendingApproval || []).length + (q.pendingChangeReviews || []).length +
          (q.awaitingRepository || []).filter(function (s) { return s.status !== 'failed' && s.candidates.some(function (c) { return c.active; }); }).length;
        qs('approvals-count').textContent = n ? String(n) : '';
        renderGate1(q.pendingApproval || []);
        renderGate2(q.awaitingRepository || []);
        renderGate3(q.pendingChangeReviews || []);
        renderRecent(q.recentlyConfirmed || []);
      }
    }, function (e) { show('error', 'Could not reach the service: ' + e.message); loadError = true; })
      .catch(function (e) { show('error', 'The page could not display the latest data: ' + e.message); loadError = true; })
      .then(function () { loading = false; });
  }

  // ── Test tickets (mock mode only) ──────────────────────────────────
  var creator = CONFIG.ticketCreatorUrl;
  function mock(method, path, body) {
    return fetch(creator + path, {
      method: method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { status: r.status, data: d }; }); });
  }
  function webhookOk(w) { return w && w.httpStatus !== null && w.httpStatus >= 200 && w.httpStatus < 300; }
  function renderCreated(items) {
    var root = qs('created');
    root.textContent = '';
    if (!items.length) { root.appendChild(el('p', 'empty', 'No tickets yet. (The mock forgets this list when it restarts; tickets already received stay in the Tickets tab.)')); return; }
    items.forEach(function (t) {
      var card = el('div', 'card'), head = el('div', 'card-head'), keys = el('span', 'key', t.key + ' ');
      keys.appendChild(el('span', 'meta', '(' + t.cfKey + ')'));
      head.appendChild(keys);
      var w = t.lastWebhook;
      head.appendChild(el('span', 'badge tone-' + (webhookOk(w) ? 'ok' : 'danger'), w ? (w.httpStatus === null ? 'webhook not delivered' : 'webhook HTTP ' + w.httpStatus) : 'no webhook'));
      card.appendChild(head);
      card.appendChild(el('div', 'title', t.summary));
      card.appendChild(el('div', 'meta', t.type + ' · ' + t.priority + ' · space ' + t.spaceKey + (t.labels.length ? ' · ' + t.labels.join(', ') : '') + ' · ' + when(t.createdAt)));
      if (w && !webhookOk(w)) {
        card.appendChild(el('div', 'meta', w.response));
        var resend = el('button', '', 'Resend webhook');
        resend.type = 'button';
        resend.style.marginTop = '8px';
        resend.addEventListener('click', function () { resend.disabled = true; mock('POST', '/__mock/tickets/' + encodeURIComponent(t.key) + '/webhook', {}).then(loadCreated, loadCreated); });
        card.appendChild(resend);
      }
      root.appendChild(card);
    });
  }
  function loadCreated() {
    if (!creator) return Promise.resolve();
    return mock('GET', '/__mock/tickets').then(function (r) { renderCreated((r.data && r.data.tickets) || []); },
      function () { qs('created').textContent = ''; qs('created').appendChild(el('p', 'empty', 'The local mock is not reachable at ' + creator + ' — start it with npm run mock:neutara.')); });
  }
  if (creator) {
    qs('create-tab').hidden = false;
    qs('mode').textContent = 'Local mock mode · test tickets enabled (' + creator + ')';
    qs('c-refresh').addEventListener('click', loadCreated);
    qs('c-submit').addEventListener('click', function () {
      var body = {
        summary: qs('c-summary').value,
        description: qs('c-description').value,
        type: qs('c-type').value,
        priority: qs('c-priority').value,
        spaceKey: qs('c-space').value.trim().toUpperCase(),
        labels: qs('c-labels').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean)
      };
      if (!body.summary.trim() || !body.description.trim()) { show('error', 'Summary and description are both required.'); return; }
      var btn = qs('c-submit');
      btn.disabled = true;
      mock('POST', '/__mock/tickets', body).then(function (r) {
        if (r.status !== 201) { show('error', (r.data && r.data.detail) || ('Mock refused: HTTP ' + r.status)); return; }
        var t = r.data.ticket;
        if (webhookOk(t.lastWebhook)) {
          show('ok', 'Created ' + t.key + ' and the service accepted it. Track it in the Tickets tab — it reaches Gate 1 in about a minute.');
          qs('c-summary').value = qs('c-description').value = qs('c-labels').value = '';
        } else {
          show('error', 'Created ' + t.key + ' in the mock, but the webhook was not accepted: ' + t.lastWebhook.response);
        }
        loadCreated();
        loadAll(true);
      }, function (e) { show('error', 'Could not reach the local mock at ' + creator + ' (' + e.message + ') — is npm run mock:neutara running?'); })
        .then(function () { btn.disabled = false; });
    });
  } else {
    qs('mode').textContent = 'Tickets arrive from Neutara';
  }

  // ── Tabs ────────────────────────────────────────────────────────────
  function selectTab(name) {
    if (name === 'create' && !creator) name = 'tickets';
    Array.prototype.forEach.call(document.querySelectorAll('nav.tabs button'), function (b) { b.setAttribute('aria-selected', String(b.getAttribute('data-tab') === name)); });
    Array.prototype.forEach.call(document.querySelectorAll('.panel'), function (p) { p.hidden = p.getAttribute('data-panel') !== name; });
    if (name === 'repositories') { var f = qs('repo-frame'); if (!f.src) f.src = f.getAttribute('data-src'); }
    if (name === 'create') loadCreated();
    sset(TAB_KEY, name);
    if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
  }
  Array.prototype.forEach.call(document.querySelectorAll('nav.tabs button'), function (b) {
    b.addEventListener('click', function () { selectTab(b.getAttribute('data-tab')); });
  });

  qs('token').value = sget(TOKEN_KEY);
  qs('name').value = sget(NAME_KEY);
  qs('save').addEventListener('click', function () {
    sset(TOKEN_KEY, qs('token').value.trim());
    sset(NAME_KEY, qs('name').value.trim());
    clear();
    var f = qs('repo-frame');
    if (f.src) f.contentWindow.location.reload();
    loadAll(true);
  });
  qs('refresh').addEventListener('click', function () { loadAll(true); });
  setInterval(function () { if (document.visibilityState === 'visible') loadAll(false); }, REFRESH_MS);
  selectTab((location.hash || '').slice(1) || sget(TAB_KEY) || 'tickets');
  loadAll(true);
})();
</script>
</body>
</html>
`;
}
