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

  const byIdentifier = new Map<string, Record<string, unknown>>();
  byIdentifier.set(cf33261.key, cf33261);
  byIdentifier.set(cf33261.cfKey, cf33261);
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

export function handleMockRequest(req: IncomingMessage, res: ServerResponse): void {
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

  const issue = mockIssues().get(decodeURIComponent(match[1]!));
  if (issue === undefined) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }

  sendJson(res, 200, issue);
}

// ── CLI ──────────────────────────────────────────────────────────────────
if (process.argv[1]?.endsWith('mock-neutara.ts')) {
  const port = Number(process.env['MOCK_NEUTARA_PORT'] ?? DEFAULT_MOCK_PORT);
  const server = createServer((req, res) => {
    const started = Date.now();
    res.on('finish', () => {
      console.log(`${req.method} ${req.url} -> ${res.statusCode} (${Date.now() - started}ms)`);
    });
    handleMockRequest(req, res);
  });

  // Loopback only.
  server.listen(port, '127.0.0.1', () => {
    console.log(`mock neutara listening on http://127.0.0.1:${port}`);
    console.log('  known identifiers: ' + [...mockIssues().keys()].join(', '));
    console.log(`  set NEUTARA_API_BASE_URL=http://127.0.0.1:${port}`);
  });

  process.on('SIGINT', () => server.close(() => process.exit(0)));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
