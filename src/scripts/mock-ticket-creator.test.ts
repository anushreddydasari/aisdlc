import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { validateIssueEvent } from '../api/ingest-payload.ts';
import { toSnapshot } from '../enrichment/worker.ts';
import { matchesRequestedIdentifier, type NeutaraIssue } from '../neutara/client.ts';
import { handleMockRequest } from './mock-neutara.ts';
import {
  createTicketStore,
  handleTicketAdminRequest,
  isTicketAdminPath,
  toDescriptionHtml,
  validateTicketInput,
  type CreatedTicket,
  type TicketInput,
  type WebhookAttempt,
} from './mock-ticket-creator.ts';
import { buildSyntheticEvent } from './send-test-webhook.ts';

const NOW = new Date('2026-09-23T12:00:00.000Z');

const VALID = {
  summary: 'Add a health-check note to the README',
  description: 'Document GET /health/ready.\n\nMention the 503 case.',
  type: 'task',
  priority: 'medium',
  spaceKey: 'LOCAL',
  labels: ['local', 'ui-test'],
};

function input(overrides: Record<string, unknown> = {}): TicketInput {
  const result = validateTicketInput({ ...VALID, ...overrides });
  assert.ok(result.ok, result.ok ? '' : result.reason);
  return result.value;
}

describe('validateTicketInput', () => {
  it('accepts a complete ticket and trims it', () => {
    const value = input({ summary: '  padded  ', labels: [' a ', '', 'b'] });
    assert.equal(value.summary, 'padded');
    assert.deepEqual(value.labels, ['a', 'b']);
  });

  it('defaults type and priority', () => {
    const result = validateTicketInput({ summary: 's', description: 'd', spaceKey: 'LOCAL' });
    assert.ok(result.ok);
    assert.equal(result.value.type, 'task');
    assert.equal(result.value.priority, 'medium');
  });

  for (const [name, overrides, pattern] of [
    ['a blank summary', { summary: '   ' }, /summary is required/],
    ['an over-long summary', { summary: 'x'.repeat(513) }, /at most 512/],
    ['a blank description', { description: '' }, /description is required/],
    ['an unknown type', { type: 'incident' }, /type must be one of/],
    ['an unknown priority', { priority: 'urgent' }, /priority must be one of/],
    ['a lowercase space key', { spaceKey: 'local' }, /space key/],
    ['a one-character space key', { spaceKey: 'L' }, /space key/],
    ['labels that are not a list', { labels: 'a,b' }, /labels must be a list/],
    ['a label with spaces', { labels: ['two words'] }, /label 'two words'/],
    ['too many labels', { labels: Array.from({ length: 11 }, (_, i) => `l${i}`) }, /at most 10 labels/],
  ] as const) {
    it(`rejects ${name}`, () => {
      const result = validateTicketInput({ ...VALID, ...overrides });
      assert.ok(!result.ok);
      assert.match(result.reason, pattern);
    });
  }

  it('rejects a non-object body', () => {
    for (const body of [null, [], 'text', 42]) assert.ok(!validateTicketInput(body).ok);
  });
});

describe('toDescriptionHtml', () => {
  it('makes one paragraph per blank-line block and keeps single line breaks', () => {
    assert.equal(toDescriptionHtml('one\ntwo\n\nthree'), '<p>one<br>two</p><p>three</p>');
  });

  it('escapes markup so a description cannot inject HTML', () => {
    assert.equal(toDescriptionHtml('<script>alert("x")</script> & co'), '<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; co</p>');
  });
});

describe('createTicketStore', () => {
  it('gives each ticket a canonical key and a different CF key, both addressable', () => {
    const store = createTicketStore();
    const ticket = store.add(input(), NOW);
    const key = ticket.issue['key'] as string;
    const cfKey = ticket.issue['cfKey'] as string;
    assert.match(key, /^LOCAL-9\d{5}$/);
    assert.match(cfKey, /^CF-9\d{5}$/);
    assert.equal(store.get(key), ticket);
    assert.equal(store.get(cfKey), ticket);
  });

  it('never reissues a key within a session, even at the same instant', () => {
    const store = createTicketStore();
    const a = store.add(input(), NOW);
    const b = store.add(input(), NOW);
    assert.notEqual(a.issue['cfKey'], b.issue['cfKey']);
    assert.deepEqual(store.list(), [b, a]);
  });

  it('produces an issue the service enriches exactly like a fixture', () => {
    const ticket = createTicketStore().add(input(), NOW);
    const issue = ticket.issue as unknown as NeutaraIssue;
    assert.ok(matchesRequestedIdentifier(issue, ticket.issue['cfKey'] as string));
    assert.ok(matchesRequestedIdentifier(issue, ticket.issue['key'] as string));

    const snapshot = toSnapshot(issue);
    assert.equal(snapshot.title, VALID.summary);
    assert.equal(snapshot.project, 'LOCAL');
    assert.equal(snapshot.issueType, 'task');
    assert.deepEqual(snapshot.labels, ['local', 'ui-test']);
    assert.ok(snapshot.description.includes('Mention the 503 case.'));
  });

  it('builds a webhook payload that passes the service\'s own validation', () => {
    const ticket = createTicketStore().add(input({ type: 'bug', priority: 'high', spaceKey: 'TESTIN' }), NOW);
    const event = buildSyntheticEvent({
      issueKey: ticket.issue['cfKey'] as string,
      summary: ticket.issue['summary'] as string,
      type: 'bug',
      priority: 'high',
      spaceKey: 'TESTIN',
    });
    const result = validateIssueEvent(event);
    assert.ok(result.ok, result.ok ? '' : result.reason);
    assert.equal(result.event.issue.spaceKey, 'TESTIN');
  });

  it('is served by the mock\'s ordinary /api/issues route', async () => {
    const store = createTicketStore();
    const ticket = store.add(input(), NOW);
    const server = createServer((req, res) => handleMockRequest(req, res, store));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/api/issues/${ticket.issue['cfKey'] as string}`, {
        headers: { authorization: 'Bearer anything' },
      });
      assert.equal(response.status, 200);
      assert.equal(((await response.json()) as Record<string, unknown>)['key'], ticket.issue['key']);
    } finally {
      server.close();
    }
  });
});

describe('isTicketAdminPath', () => {
  it('owns only the page and /__mock/tickets routes', () => {
    for (const p of ['/', '/__mock/tickets', '/__mock/tickets/LOCAL-900001/webhook']) assert.ok(isTicketAdminPath(p), p);
    for (const p of ['/api/issues/CF-33261', '/__mock', '/__mock/tickets/x', '/favicon.ico']) assert.ok(!isTicketAdminPath(p), p);
  });
});

describe('handleTicketAdminRequest over HTTP', () => {
  let server: Server;
  let base: string;
  let port: number;
  const sent: CreatedTicket[] = [];
  let nextAttempt: WebhookAttempt = { at: NOW.toISOString(), httpStatus: 202, response: '{"status":"accepted"}' };
  const store = createTicketStore();

  before(async () => {
    server = createServer((req, res) => {
      void handleTicketAdminRequest(req, res, {
        store,
        port,
        servicePort: 4600,
        now: () => NOW,
        sendWebhook: async (ticket) => {
          sent.push(ticket);
          return nextAttempt;
        },
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
  });

  after(() => server.close());

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it('serves the page with a restrictive CSP and the service port filled in', async () => {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    const html = await response.text();
    assert.match(html, /<title>Test Ticket Creator<\/title>/);
    assert.match(html, /var SERVICE_PORT = 4600;/);
  });

  it('creates a ticket, sends its webhook, and lists it', async () => {
    const response = await post('/__mock/tickets', VALID);
    assert.equal(response.status, 201);
    const { ticket } = (await response.json()) as { ticket: Record<string, unknown> };
    assert.match(ticket['key'] as string, /^LOCAL-9\d{5}$/);
    assert.equal((ticket['lastWebhook'] as WebhookAttempt).httpStatus, 202);
    assert.equal(sent.at(-1)!.issue['key'], ticket['key']);

    const listed = (await (await fetch(`${base}/__mock/tickets`)).json()) as { tickets: Record<string, unknown>[] };
    assert.equal(listed.tickets[0]!['key'], ticket['key']);
  });

  it('keeps the ticket when the service is down, and resends on request', async () => {
    nextAttempt = { at: NOW.toISOString(), httpStatus: null, response: 'the service is not running' };
    const created = (await (await post('/__mock/tickets', VALID)).json()) as { ticket: Record<string, unknown> };
    assert.equal((created.ticket['lastWebhook'] as WebhookAttempt).httpStatus, null);

    nextAttempt = { at: NOW.toISOString(), httpStatus: 202, response: 'ok' };
    const resent = await post(`/__mock/tickets/${created.ticket['key'] as string}/webhook`, {});
    assert.equal(resent.status, 200);
    assert.equal((((await resent.json()) as { ticket: Record<string, unknown> }).ticket['lastWebhook'] as WebhookAttempt).httpStatus, 202);
  });

  it('answers 400 with the validation reason', async () => {
    const response = await post('/__mock/tickets', { ...VALID, spaceKey: 'bad key' });
    assert.equal(response.status, 400);
    assert.match(((await response.json()) as { detail: string }).detail, /space key/);
  });

  it('404s a resend for a ticket it does not know', async () => {
    assert.equal((await post('/__mock/tickets/LOCAL-1/webhook', {})).status, 404);
  });

  it('refuses a write from another website (cross-origin Origin header)', async () => {
    const before = sent.length;
    const response = await post('/__mock/tickets', VALID, { origin: 'https://evil.example' });
    assert.equal(response.status, 403);
    assert.equal(sent.length, before);
  });

  it('answers the AISDLC Console\'s CORS preflight, and only the console\'s', async () => {
    const preflight = (origin: string) =>
      fetch(`${base}/__mock/tickets`, {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
      });
    const ok = await preflight('http://127.0.0.1:4600');
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('access-control-allow-origin'), 'http://127.0.0.1:4600');
    assert.match(ok.headers.get('access-control-allow-headers') ?? '', /content-type/);
    const other = await preflight('https://evil.example');
    assert.equal(other.status, 403);
    assert.equal(other.headers.get('access-control-allow-origin'), null);
  });

  it('lets the AISDLC Console create a ticket cross-origin', async () => {
    const response = await post('/__mock/tickets', VALID, { origin: 'http://localhost:4600' });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:4600');
  });

  it('never grants CORS on the page itself', async () => {
    const response = await fetch(`${base}/`, { headers: { origin: 'http://127.0.0.1:4600' } });
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });

  it('refuses a non-JSON write, which a cross-site form could send without preflight', async () => {
    const response = await fetch(`${base}/__mock/tickets`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'summary=x',
    });
    assert.equal(response.status, 415);
  });

  it('refuses a foreign Host header (DNS rebinding)', async () => {
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/__mock/tickets', headers: { host: `rebind.example:${port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
  });

  it('rejects malformed JSON', async () => {
    const response = await fetch(`${base}/__mock/tickets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    assert.equal(response.status, 400);
  });
});
