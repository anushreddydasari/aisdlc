/**
 * GET / on the mock Neutara — the ticket creator page served by
 * mock-ticket-creator.ts. A single self-contained HTML/CSS/JS document, the
 * same no-build-step shape as api/repository-ui.ts.
 *
 * It only calls this mock's own /__mock/tickets routes; the mock sends the
 * signed webhook server-side, so the webhook secret never reaches the
 * browser. Every value typed here is rendered back via textContent only.
 */

/** `servicePort` is only used to link to the service's Repository Registry page. */
export function renderMockTicketUi(servicePort: number): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Test Ticket Creator</title>
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
    --warn-bg: #fff6e0;
    --warn: #7a5200;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { background: var(--panel); border-bottom: 1px solid var(--border); padding: 14px 24px; }
  header h1 { margin: 0; font-size: 18px; }
  header p { margin: 2px 0 0; color: var(--muted); }
  main { display: grid; grid-template-columns: minmax(320px, 440px) 1fr; gap: 20px; padding: 20px 24px; max-width: 1200px; }
  @media (max-width: 860px) { main { grid-template-columns: 1fr; padding: 16px; } }
  section { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 18px; }
  h2 { margin: 0 0 12px; font-size: 15px; }
  label { display: block; font-weight: 600; margin: 12px 0 4px; }
  label .hint { font-weight: 400; color: var(--muted); }
  input, select, textarea { width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; font: inherit; background: #fff; color: var(--text); }
  textarea { min-height: 140px; resize: vertical; }
  .row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; }
  button { font: inherit; border-radius: 6px; padding: 8px 14px; cursor: pointer; border: 1px solid var(--border); background: #fff; color: var(--text); }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-contrast); font-weight: 600; margin-top: 16px; width: 100%; }
  button:disabled { opacity: .6; cursor: default; }
  .msg { margin-top: 12px; padding: 10px 12px; border-radius: 6px; display: none; white-space: pre-wrap; }
  .msg.error { display: block; background: var(--danger-bg); color: var(--danger); }
  .msg.ok { display: block; background: var(--success-bg); color: var(--success); }
  .note { background: var(--warn-bg); color: var(--warn); padding: 10px 12px; border-radius: 6px; margin-bottom: 12px; }
  .note a { color: inherit; }
  .empty { color: var(--muted); }
  .ticket { border: 1px solid var(--border); border-radius: 6px; padding: 12px; margin-bottom: 10px; }
  .ticket-head { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; flex-wrap: wrap; }
  .keys { font-family: ui-monospace, Consolas, monospace; font-weight: 600; }
  .keys span { color: var(--muted); font-weight: 400; }
  .summary { margin: 4px 0; }
  .meta { color: var(--muted); font-size: 12px; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 12px; font-weight: 600; }
  .badge.ok { background: var(--success-bg); color: var(--success); }
  .badge.fail { background: var(--danger-bg); color: var(--danger); }
  .detail { font-size: 12px; color: var(--muted); margin-top: 6px; word-break: break-word; }
  .toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
  .toolbar h2 { margin: 0; }
</style>
</head>
<body>
<header>
  <h1>Test Ticket Creator</h1>
  <p>Local mock Neutara · creates a ticket here, then sends a signed <code>issue.created</code> webhook to the local AISDLC service.</p>
</header>
<main>
  <section>
    <h2>New ticket</h2>
    <div class="note">
      Repository selection matches on the <strong>space key</strong>. Register a repository for it at
      <a id="repo-link" href="#" target="_blank" rel="noopener">the Repository Registry</a> first, or the run will stop at repository selection.
    </div>
    <form id="form" novalidate>
      <label for="summary">Summary</label>
      <input id="summary" maxlength="512" required placeholder="Add a health-check note to the README">

      <label for="description">Description <span class="hint">— what the Requirements Agent analyzes</span></label>
      <textarea id="description" maxlength="20000" required placeholder="Describe the change, acceptance criteria, affected files…"></textarea>

      <div class="row">
        <div>
          <label for="type">Type</label>
          <select id="type">
            <option value="task" selected>task</option>
            <option value="bug">bug</option>
            <option value="story">story</option>
            <option value="epic">epic</option>
          </select>
        </div>
        <div>
          <label for="priority">Priority</label>
          <select id="priority">
            <option value="low">low</option>
            <option value="medium" selected>medium</option>
            <option value="high">high</option>
            <option value="critical">critical</option>
          </select>
        </div>
        <div>
          <label for="spaceKey">Space key</label>
          <input id="spaceKey" value="LOCAL" maxlength="20" required autocapitalize="characters">
        </div>
      </div>

      <label for="labels">Labels <span class="hint">— comma separated, optional</span></label>
      <input id="labels" placeholder="local, ui-test">

      <button class="primary" id="submit" type="submit">Create ticket &amp; send webhook</button>
      <div class="msg" id="msg" role="status"></div>
    </form>
  </section>

  <section>
    <div class="toolbar">
      <h2>Created this session</h2>
      <button id="refresh" type="button">Refresh</button>
    </div>
    <div id="list"><p class="empty">No tickets yet.</p></div>
  </section>
</main>
<script>
(function () {
  'use strict';
  var SERVICE_PORT = ${Number(servicePort)};
  document.getElementById('repo-link').href = 'http://127.0.0.1:' + SERVICE_PORT + '/repositories';

  var form = document.getElementById('form');
  var msg = document.getElementById('msg');
  var submit = document.getElementById('submit');
  var list = document.getElementById('list');

  function show(kind, text) { msg.className = 'msg ' + kind; msg.textContent = text; }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function webhookOk(w) { return w && w.httpStatus !== null && w.httpStatus >= 200 && w.httpStatus < 300; }

  function api(method, path, body) {
    return fetch(path, {
      method: method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) { return { status: r.status, data: data }; });
    });
  }

  function render(tickets) {
    list.textContent = '';
    if (!tickets.length) { list.appendChild(el('p', 'empty', 'No tickets yet.')); return; }
    tickets.forEach(function (t) {
      var card = el('div', 'ticket');
      var head = el('div', 'ticket-head');
      var keys = el('div', 'keys', t.key + ' ');
      keys.appendChild(el('span', '', '(' + t.cfKey + ')'));
      head.appendChild(keys);
      var w = t.lastWebhook;
      head.appendChild(el('span', 'badge ' + (webhookOk(w) ? 'ok' : 'fail'),
        w ? (w.httpStatus === null ? 'webhook not delivered' : 'webhook HTTP ' + w.httpStatus) : 'no webhook'));
      card.appendChild(head);
      card.appendChild(el('div', 'summary', t.summary));
      card.appendChild(el('div', 'meta', t.type + ' · ' + t.priority + ' · space ' + t.spaceKey +
        (t.labels.length ? ' · ' + t.labels.join(', ') : '') + ' · ' + new Date(t.createdAt).toLocaleTimeString()));
      if (w) card.appendChild(el('div', 'detail', w.response));
      if (!webhookOk(w)) {
        var resend = el('button', '', 'Resend webhook');
        resend.type = 'button';
        resend.style.marginTop = '8px';
        resend.addEventListener('click', function () {
          resend.disabled = true;
          api('POST', '/__mock/tickets/' + encodeURIComponent(t.key) + '/webhook', {}).then(load, load);
        });
        card.appendChild(resend);
      }
      list.appendChild(card);
    });
  }

  function load() {
    return api('GET', '/__mock/tickets').then(function (r) { render((r.data && r.data.tickets) || []); });
  }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var body = {
      summary: document.getElementById('summary').value,
      description: document.getElementById('description').value,
      type: document.getElementById('type').value,
      priority: document.getElementById('priority').value,
      spaceKey: document.getElementById('spaceKey').value.trim().toUpperCase(),
      labels: document.getElementById('labels').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean)
    };
    if (!body.summary.trim()) { show('error', 'Summary is required.'); return; }
    if (!body.description.trim()) { show('error', 'Description is required — it is what the Requirements Agent analyzes.'); return; }
    submit.disabled = true;
    show('ok', 'Creating…');
    api('POST', '/__mock/tickets', body).then(function (r) {
      if (r.status !== 201) { show('error', (r.data && r.data.detail) || ('Failed: HTTP ' + r.status)); return; }
      var t = r.data.ticket;
      if (webhookOk(t.lastWebhook)) {
        show('ok', 'Created ' + t.key + ' (' + t.cfKey + ') and the service accepted the webhook.\\n' +
          'Watch the service log: enrichment and the Requirements Agent pick it up within ~60s, then it waits at Gate 1 (approve ' + t.key + ').');
        document.getElementById('summary').value = '';
        document.getElementById('description').value = '';
        document.getElementById('labels').value = '';
      } else {
        show('error', 'Created ' + t.key + ' in the mock, but the webhook was not accepted:\\n' + t.lastWebhook.response);
      }
      return load();
    }).catch(function (e) {
      show('error', 'Could not reach the mock: ' + e.message);
    }).then(function () { submit.disabled = false; });
  });

  document.getElementById('refresh').addEventListener('click', load);
  load();
})();
</script>
</body>
</html>
`;
}
