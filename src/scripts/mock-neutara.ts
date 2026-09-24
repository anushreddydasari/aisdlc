/**
 * A local stand-in for the Neutara REST API, for manual testing only.
 *
 *   npm run mock:neutara
 *
 * Point `NEUTARA_API_BASE_URL` at this server and the enrichment loop fetches
 * from here instead of the live instance. That is the whole purpose: the
 * pending → enriched transition can be exercised end to end without a single
 * request reaching production Neutara.
 *
 * It is NOT used by the automated suite, which mocks `fetch` directly and
 * needs no server. This is for driving a running service by hand.
 *
 * Binds to 127.0.0.1 only. A mock that answers on a public interface is a
 * mock that eventually gets mistaken for the real thing.
 *
 * Responses mirror `formatIssue()` in Neutara's jira-pg-api.ts, including the
 * fields enrichment reads: summary, description, type, priority, spaceKey,
 * reporter, parentKey, labels, cfKey, createdAt.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import {
  createTicketStore,
  createWebhookSender,
  handleTicketAdminRequest,
  isTicketAdminPath,
  type TicketStore,
} from './mock-ticket-creator.ts';

export const DEFAULT_MOCK_PORT = 4601;

/** Issues this mock knows about, keyed by BOTH identifiers. */
export function mockIssues(): Map<string, Record<string, unknown>> {
  const cf33261 = {
    // Canonical key differs from the CF identifier on purpose: this is what
    // exercises identifier normalisation, the thing the live smoke test
    // uncovered. A delivery naming CF-33261 must produce an intake item keyed
    // LOCAL-1001.
    key: 'LOCAL-1001',
    cfKey: 'CF-33261',
    summary: 'Local mock ticket for enrichment testing',
    description: '<p>Description supplied by the mock, not present in the webhook payload.</p>',
    type: 'task',
    priority: 'medium',
    status: { name: 'Open' },
    spaceKey: 'LOCAL',
    spaceName: 'Local Testing',
    reporter: { email: 'reporter@localhost.invalid', displayName: 'Local Reporter' },
    assignee: null,
    parentKey: null,
    labels: ['local', 'enrichment-test'],
    createdAt: '2026-09-21T00:00:00.000Z',
  };

  // A second, independent ticket, so a local end-to-end run can be repeated
  // without first deleting LOCAL-1001's intake item (issueKey is unique).
  const cf33262 = {
    ...cf33261,
    key: 'LOCAL-1002',
    cfKey: 'CF-33262',
    summary: 'Second local mock ticket for repeat end-to-end testing',
    description: '<p>Add a health-check note to the README describing the /health/ready endpoint.</p>',
    createdAt: '2026-09-23T00:00:00.000Z',
  };

  const byIdentifier = new Map<string, Record<string, unknown>>();
  for (const issue of [cf33261, cf33262]) {
    byIdentifier.set(issue.key, issue);
    byIdentifier.set(issue.cfKey, issue);
  }
  return byIdentifier;
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * `created` is the ticket creator's store (mock-ticket-creator.ts): tickets
 * made through the page are served from here exactly like the fixtures.
 */
export function handleMockRequest(req: IncomingMessage, res: ServerResponse, created?: TicketStore): void {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');

  if (req.method !== 'GET') {
    // The real token is read-only through Phase 7, and so is this mock.
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  // Mirrors Neutara's auth: a Bearer token is required, but any value is
  // accepted — this checks that the client SENDS one, not that it is valid.
  const auth = req.headers['authorization'];
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  const match = /^\/api\/issues\/([^/]+)$/.exec(url.pathname);
  if (match === null) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }

  const identifier = decodeURIComponent(match[1]!);
  const issue = mockIssues().get(identifier) ?? created?.get(identifier)?.issue;
  if (issue === undefined) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }

  sendJson(res, 200, issue);
}

// ── CLI ──────────────────────────────────────────────────────────────────
if (process.argv[1]?.endsWith('mock-neutara.ts')) {
  const port = Number(process.env['MOCK_NEUTARA_PORT'] ?? DEFAULT_MOCK_PORT);
  const created = createTicketStore();
  const ticketAdmin = {
    store: created,
    sendWebhook: createWebhookSender(process.env),
    port,
    servicePort: Number((process.env['AISDLC_PORT'] ?? '4600').trim()),
  };
  const server = createServer((req, res) => {
    const started = Date.now();
    res.on('finish', () => {
      console.log(`${req.method} ${req.url} -> ${res.statusCode} (${Date.now() - started}ms)`);
    });
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (isTicketAdminPath(pathname)) {
      handleTicketAdminRequest(req, res, ticketAdmin).catch((error: unknown) => {
        console.error('ticket creator request failed:', (error as Error).message);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal_error' }));
      });
      return;
    }
    handleMockRequest(req, res, created);
  });

  // Loopback only.
  server.listen(port, '127.0.0.1', () => {
    console.log(`mock neutara listening on http://127.0.0.1:${port}`);
    console.log('  known identifiers: ' + [...mockIssues().keys()].join(', '));
    console.log(`  set NEUTARA_API_BASE_URL=http://127.0.0.1:${port}`);
    console.log(`  ticket creator UI: http://127.0.0.1:${port}/`);
  });

  process.on('SIGINT', () => server.close(() => process.exit(0)));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
