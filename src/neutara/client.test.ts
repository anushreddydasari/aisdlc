import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createLogger } from '../logging/logger.ts';
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  buildIssueUrl,
  createNeutaraClient,
  isRetryable,
  matchesRequestedIdentifier,
} from './client.ts';

const TOKEN = 'nta_test_token_value_not_real'; // pragma: fixture
const BASE = 'https://neutara.example.com';

function issueBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    key: 'AIS-1',
    cfKey: 'CF-9',
    summary: 'Login fails for SSO users',
    description: '<p>Steps to reproduce</p>',
    type: 'bug',
    priority: 'high',
    status: { name: 'Open' },
    spaceKey: 'AIS',
    spaceName: 'AISDLC',
    reporter: { email: 'reporter@example.com', displayName: 'A Reporter' },
    assignee: null,
    parentKey: null,
    labels: ['sso', 'auth'],
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  });
}

/** A mocked fetch. No server, no network, no real Neutara. */
function mockFetch(
  responder: (url: string, init: RequestInit) => Response | Promise<Response>,
): { fn: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    return responder(url, init);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function client(fetchFn: typeof fetch, logs: string[] = []) {
  return createNeutaraClient({
    baseUrl: BASE,
    token: TOKEN,
    logger: createLogger({ write: (line) => logs.push(line) }),
    fetchFn,
  });
}

describe('buildIssueUrl', () => {
  it('appends the documented path', () => {
    assert.equal(buildIssueUrl(BASE, 'AIS-1'), 'https://neutara.example.com/api/issues/AIS-1');
  });

  it('never produces a double slash', () => {
    assert.equal(buildIssueUrl(`${BASE}/`, 'AIS-1'), 'https://neutara.example.com/api/issues/AIS-1');
    assert.ok(!buildIssueUrl(`${BASE}//`, 'AIS-1').includes('//api'));
  });

  it('escapes the issue key', () => {
    assert.ok(buildIssueUrl(BASE, 'AIS 1/../admin').includes('AIS%201%2F..%2Fadmin'));
  });
});

describe('a successful fetch', () => {
  it('returns the issue', async () => {
    const { fn } = mockFetch(() => new Response(issueBody(), { status: 200 }));
    const result = await client(fn).getIssue('AIS-1');

    assert.ok(result.ok);
    assert.equal(result.issue.key, 'AIS-1');
    assert.equal(result.issue.summary, 'Login fails for SSO users');
    assert.deepEqual(result.issue.labels, ['sso', 'auth']);
  });

  it('sends the documented headers', async () => {
    const { fn, calls } = mockFetch(() => new Response(issueBody(), { status: 200 }));
    await client(fn).getIssue('AIS-1');

    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers['authorization'], `Bearer ${TOKEN}`);
    assert.equal(headers['accept'], 'application/json');
    assert.equal(calls[0]!.init.method, 'GET');
  });

  it('requests the configured origin, never a URL from the payload', async () => {
    // Following issue.url from a webhook body would be an SSRF primitive.
    const { fn, calls } = mockFetch(() => new Response(issueBody(), { status: 200 }));
    await client(fn).getIssue('AIS-1');
    assert.ok(calls[0]!.url.startsWith(BASE));
  });
});

describe('failures', () => {
  const cases: [string, number, string][] = [
    ['404', 404, 'not_found'],
    ['401', 401, 'unauthorized'],
    ['403', 403, 'unauthorized'],
    ['429', 429, 'transient'],
    ['500', 500, 'transient'],
    ['503', 503, 'transient'],
    ['400', 400, 'malformed'],
  ];

  for (const [name, status, kind] of cases) {
    it(`maps ${name} to ${kind}`, async () => {
      const { fn } = mockFetch(() => new Response('', { status }));
      const result = await client(fn).getIssue('AIS-1');

      assert.ok(!result.ok);
      assert.equal(result.kind, kind);
      assert.equal(result.status, status);
    });
  }

  it('treats a timeout as transient', async () => {
    const { fn } = mockFetch(
      () =>
        new Promise<Response>((_resolve, reject) => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          setTimeout(() => reject(error), 5).unref();
        }),
    );
    const result = await createNeutaraClient({
      baseUrl: BASE,
      token: TOKEN,
      logger: createLogger({ write: () => {} }),
      fetchFn: fn,
      timeoutMs: 10,
    }).getIssue('AIS-1');

    assert.ok(!result.ok);
    assert.equal(result.kind, 'transient');
    assert.match(result.message, /timed out/);
  });

  it('treats a network error as transient', async () => {
    const { fn } = mockFetch(() => Promise.reject(new Error('ECONNREFUSED')));
    const result = await client(fn).getIssue('AIS-1');
    assert.ok(!result.ok);
    assert.equal(result.kind, 'transient');
  });

  it('rejects a body that is not JSON', async () => {
    const { fn } = mockFetch(() => new Response('<html>oops</html>', { status: 200 }));
    const result = await client(fn).getIssue('AIS-1');
    assert.ok(!result.ok);
    assert.equal(result.kind, 'malformed');
  });

  it('rejects a response missing key or summary', async () => {
    for (const body of ['{}', '{"key":"AIS-1"}', '{"summary":"x"}', '[]', 'null']) {
      const { fn } = mockFetch(() => new Response(body, { status: 200 }));
      const result = await client(fn).getIssue('AIS-1');
      assert.ok(!result.ok, `accepted ${body}`);
      assert.equal(result.kind, 'malformed');
    }
  });

  it('rejects a response for a different issue', async () => {
    // Attributing one issue's content to another is worse than fetching none.
    // Neither identifier matches here: key AIS-999, cfKey CF-9, asked AIS-1.
    const { fn } = mockFetch(() => new Response(issueBody({ key: 'AIS-999' }), { status: 200 }));
    const result = await client(fn).getIssue('AIS-1');
    assert.ok(!result.ok);
    assert.equal(result.kind, 'malformed');
    assert.match(result.message, /different issue/);
  });

  it('accepts a response addressed by cfKey and keeps the canonical key', async () => {
    // Neutara resolves a CF-* identifier to the ticket's internal key, so the
    // response legitimately comes back under a different `key`. Rejecting this
    // failed every CF-addressed delivery permanently, since `malformed` is not
    // retryable.
    const { fn } = mockFetch(() => new Response(issueBody(), { status: 200 }));
    const result = await client(fn).getIssue('CF-9');

    assert.ok(result.ok, 'a cfKey-addressed response was rejected');
    assert.equal(result.issue.key, 'AIS-1', 'the canonical key must survive intact');
    assert.equal(result.issue.cfKey, 'CF-9');
  });

  it('rejects a cfKey that does not match either identifier', async () => {
    const { fn } = mockFetch(() => new Response(issueBody(), { status: 200 }));
    const result = await client(fn).getIssue('CF-404');
    assert.ok(!result.ok);
    assert.equal(result.kind, 'malformed');
  });

  it('falls back to the canonical key when cfKey is absent or null', async () => {
    for (const overrides of [{ cfKey: null }, { cfKey: undefined }]) {
      const { fn } = mockFetch(() => new Response(issueBody(overrides), { status: 200 }));
      assert.ok((await client(fn).getIssue('AIS-1')).ok, 'canonical match must still work');

      const { fn: fn2 } = mockFetch(() => new Response(issueBody(overrides), { status: 200 }));
      assert.ok(!(await client(fn2).getIssue('CF-9')).ok, 'a missing cfKey must not match');
    }
  });
});

describe('matchesRequestedIdentifier', () => {
  const issue = { key: 'AIS-1', cfKey: 'CF-9', summary: 's' };

  it('accepts the canonical key', () => {
    assert.equal(matchesRequestedIdentifier(issue, 'AIS-1'), true);
  });

  it('accepts the cfKey', () => {
    assert.equal(matchesRequestedIdentifier(issue, 'CF-9'), true);
  });

  it('rejects a genuine mismatch', () => {
    assert.equal(matchesRequestedIdentifier(issue, 'AIS-2'), false);
    assert.equal(matchesRequestedIdentifier(issue, 'CF-10'), false);
  });

  it('rejects an empty requested identifier even against an empty cfKey', () => {
    // Guards the degenerate case where '' === '' would otherwise match.
    assert.equal(matchesRequestedIdentifier({ ...issue, cfKey: '' }, ''), false);
  });

  it('is exact, not case-insensitive', () => {
    // Neutara upper-cases on lookup, so a case difference means the response
    // did not come from the path we requested.
    assert.equal(matchesRequestedIdentifier(issue, 'ais-1'), false);
    assert.equal(matchesRequestedIdentifier(issue, 'cf-9'), false);
  });

  it('rejects an oversized body by declared length', async () => {
    const { fn } = mockFetch(
      () =>
        new Response(issueBody(), {
          status: 200,
          headers: { 'content-length': String(DEFAULT_MAX_RESPONSE_BYTES + 1) },
        }),
    );
    const result = await client(fn).getIssue('AIS-1');
    assert.ok(!result.ok);
    assert.equal(result.kind, 'too_large');
  });

  it('rejects an oversized body that lied about its length', async () => {
    const huge = JSON.stringify({ key: 'AIS-1', summary: 'x'.repeat(5000) });
    const { fn } = mockFetch(() => new Response(huge, { status: 200 }));
    const result = await createNeutaraClient({
      baseUrl: BASE,
      token: TOKEN,
      logger: createLogger({ write: () => {} }),
      fetchFn: fn,
      maxResponseBytes: 1000,
    }).getIssue('AIS-1');

    assert.ok(!result.ok);
    assert.equal(result.kind, 'too_large');
  });
});

describe('retry classification', () => {
  it('retries only transient failures', () => {
    assert.ok(isRetryable('transient'));
    for (const kind of ['not_found', 'unauthorized', 'malformed', 'too_large'] as const) {
      assert.ok(!isRetryable(kind), `${kind} should not be retried`);
    }
  });
});

describe('the token never leaks', () => {
  it('is absent from logs on failure', async () => {
    const logs: string[] = [];
    const { fn } = mockFetch(() => Promise.reject(new Error(`connect failed for ${TOKEN}`)));
    await client(fn, logs).getIssue('AIS-1');

    assert.ok(logs.length > 0, 'nothing was logged');
    assert.ok(!logs.join('\n').includes(TOKEN), 'the token reached the log');
  });

  it('is absent from every failure message', async () => {
    for (const status of [401, 404, 500]) {
      const { fn } = mockFetch(() => new Response('', { status }));
      const result = await client(fn).getIssue('AIS-1');
      assert.ok(!result.ok);
      assert.ok(!result.message.includes(TOKEN));
    }
  });

  it('bounds requests by default', () => {
    assert.equal(DEFAULT_REQUEST_TIMEOUT_MS, 10_000);
    assert.equal(DEFAULT_MAX_RESPONSE_BYTES, 8 * 1024 * 1024);
  });
});
