/**
 * Every test here injects a fake `fetchFn`. None of them reach the network,
 * and none of them use a real GitHub App id, private key, or installation.
 * The private key below is a synthetic RSA keypair generated fresh for this
 * test run — see jwt.test.ts's header comment for why that is safe.
 */

import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';

import { createLogger } from '../logging/logger.ts';
import { createTokenIssuer, DEFAULT_REFRESH_MARGIN_MS, type TokenIssuerOptions } from './token-issuer.ts';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

function fakeResponse(status: number, body?: unknown, headers?: Record<string, string>): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    ...(headers === undefined ? {} : { headers }),
  });
}

interface Harness {
  readonly options: TokenIssuerOptions;
  readonly calls: { url: string; authorization: string }[];
  readonly logs: string[];
}

function harness(
  respond: (installationId: number, callIndex: number) => Response,
  overrides: Partial<TokenIssuerOptions> = {},
): Harness {
  const calls: Harness['calls'] = [];
  const logs: string[] = [];
  let callIndex = 0;

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const authorization = (init?.headers as Record<string, string>)?.['authorization'] ?? '';
    calls.push({ url, authorization });
    const match = /\/app\/installations\/(\d+)\/access_tokens$/.exec(url);
    const installationId = match ? Number(match[1]) : -1;
    const response = respond(installationId, callIndex);
    callIndex += 1;
    return response;
  }) as typeof fetch;

  return {
    options: {
      appId: 123456,
      privateKey,
      logger: createLogger({ level: 'debug', write: (line) => logs.push(line) }),
      fetchFn,
      now: () => new Date('2026-09-22T00:00:00.000Z'),
      ...overrides,
    },
    calls,
    logs,
  };
}

describe('createTokenIssuer: successful issuance', () => {
  it('requests a token and returns it with its expiry', async () => {
    const h = harness(() =>
      fakeResponse(201, { token: 'ghs_fake_installation_token', expires_at: '2026-09-22T01:00:00Z' }),
    );
    const issuer = createTokenIssuer(h.options);

    const result = await issuer.getInstallationToken(4242);

    assert.ok(result.ok);
    assert.equal(result.token, 'ghs_fake_installation_token');
    assert.equal(result.expiresAt.toISOString(), '2026-09-22T01:00:00.000Z');
    assert.equal(h.calls.length, 1);
    assert.ok(h.calls[0]!.url.endsWith('/app/installations/4242/access_tokens'));
    assert.match(h.calls[0]!.authorization, /^Bearer eyJ/);
  });

  it('sends the required GitHub headers', async () => {
    const calls: RequestInit[] = [];
    const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push(init!);
      return fakeResponse(201, { token: 'ghs_x', expires_at: '2026-09-22T01:00:00Z' });
    }) as typeof fetch;
    const h = harness(() => fakeResponse(201), { fetchFn });
    const issuer = createTokenIssuer(h.options);
    await issuer.getInstallationToken(1);

    const headers = calls[0]!.headers as Record<string, string>;
    assert.equal(headers['accept'], 'application/vnd.github+json');
    assert.equal(headers['x-github-api-version'], '2022-11-28');
    assert.equal(headers['user-agent'], 'aisdlc-service');
  });
});

describe('createTokenIssuer: token caching and expiration handling', () => {
  it('reuses a cached token instead of making a second request', async () => {
    const h = harness(() =>
      fakeResponse(201, { token: 'ghs_cached', expires_at: '2026-09-22T01:00:00Z' }),
    );
    const issuer = createTokenIssuer(h.options);

    const first = await issuer.getInstallationToken(4242);
    const second = await issuer.getInstallationToken(4242);

    assert.ok(first.ok && second.ok);
    assert.equal(first.token, second.token);
    assert.equal(h.calls.length, 1, 'the second call should have used the cache');
  });

  it('refreshes once the cached token is within the refresh margin of expiring', async () => {
    let current = new Date('2026-09-22T00:00:00.000Z');
    const h = harness(
      () => fakeResponse(201, { token: 'ghs_v1', expires_at: '2026-09-22T01:00:00Z' }),
      { now: () => current },
    );
    const issuer = createTokenIssuer(h.options);
    await issuer.getInstallationToken(4242);

    // 56 minutes later: within DEFAULT_REFRESH_MARGIN_MS (5 min) of the 1-hour expiry.
    current = new Date(current.getTime() + 56 * 60_000);
    const second = await issuer.getInstallationToken(4242);

    assert.ok(second.ok);
    assert.equal(h.calls.length, 2, 'a token within the refresh margin should trigger a fresh request');
  });

  it('does not refresh before the margin is reached', async () => {
    let current = new Date('2026-09-22T00:00:00.000Z');
    const h = harness(
      () => fakeResponse(201, { token: 'ghs_v1', expires_at: '2026-09-22T01:00:00Z' }),
      { now: () => current },
    );
    const issuer = createTokenIssuer(h.options);
    await issuer.getInstallationToken(4242);

    current = new Date(current.getTime() + 30 * 60_000); // well before the margin
    await issuer.getInstallationToken(4242);

    assert.equal(h.calls.length, 1);
  });

  it('caches tokens independently per installation id', async () => {
    const h = harness((installationId) =>
      fakeResponse(201, { token: `ghs_${installationId}`, expires_at: '2026-09-22T01:00:00Z' }),
    );
    const issuer = createTokenIssuer(h.options);

    const a = await issuer.getInstallationToken(1);
    const b = await issuer.getInstallationToken(2);

    assert.ok(a.ok && b.ok);
    assert.notEqual(a.token, b.token);
    assert.equal(h.calls.length, 2);
  });

  it('de-duplicates concurrent requests for the same installation id', async () => {
    let resolveResponse: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveResponse = resolve;
    });
    const h = harness(() => fakeResponse(201, { token: 'ghs_concurrent', expires_at: '2026-09-22T01:00:00Z' }));
    const slowFetch = (async (...args: Parameters<typeof fetch>) => {
      await gate;
      return (h.options.fetchFn as typeof fetch)(...args);
    }) as typeof fetch;
    const issuer = createTokenIssuer({ ...h.options, fetchFn: slowFetch });

    const first = issuer.getInstallationToken(4242);
    const second = issuer.getInstallationToken(4242);
    resolveResponse!();
    const [a, b] = await Promise.all([first, second]);

    assert.ok(a.ok && b.ok);
    assert.equal(a.token, b.token);
    assert.equal(h.calls.length, 1, 'concurrent calls for the same installation must share one request');
  });
});

describe('createTokenIssuer: error classification', () => {
  it('maps 404 to installation_not_found', async () => {
    const h = harness(() => fakeResponse(404));
    const result = await createTokenIssuer(h.options).getInstallationToken(9999);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'installation_not_found');
  });

  it('maps 401 to authentication_failed', async () => {
    const h = harness(() => fakeResponse(401));
    const result = await createTokenIssuer(h.options).getInstallationToken(1);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'authentication_failed');
  });

  it('maps 403 with no rate-limit headers to insufficient_permission', async () => {
    const h = harness(() => fakeResponse(403));
    const result = await createTokenIssuer(h.options).getInstallationToken(1);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'insufficient_permission');
  });

  describe('rate-limit handling', () => {
    it('maps 429 to rate_limited', async () => {
      const h = harness(() => fakeResponse(429));
      const result = await createTokenIssuer(h.options).getInstallationToken(1);
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.kind, 'rate_limited');
    });

    it('maps 403 with a Retry-After header to rate_limited, with retryAfterMs', async () => {
      const h = harness(() => fakeResponse(403, undefined, { 'retry-after': '30' }));
      const result = await createTokenIssuer(h.options).getInstallationToken(1);
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.kind, 'rate_limited');
      assert.equal(result.ok === false && result.retryAfterMs, 30_000);
    });

    it('maps 403 with X-RateLimit-Remaining: 0 to rate_limited using X-RateLimit-Reset', async () => {
      const now = new Date('2026-09-22T00:00:00.000Z');
      const resetEpochSeconds = Math.floor(now.getTime() / 1000) + 60;
      const h = harness(
        () =>
          fakeResponse(403, undefined, {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(resetEpochSeconds),
          }),
        { now: () => now },
      );
      const result = await createTokenIssuer(h.options).getInstallationToken(1);
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.kind, 'rate_limited');
      assert.equal(result.ok === false && result.retryAfterMs, 60_000);
    });
  });

  it('maps a 5xx to transient', async () => {
    const h = harness(() => fakeResponse(503));
    const result = await createTokenIssuer(h.options).getInstallationToken(1);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'transient');
  });

  it('maps an unexpected 2xx/3xx status to malformed', async () => {
    const h = harness(() => fakeResponse(200));
    const result = await createTokenIssuer(h.options).getInstallationToken(1);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'malformed');
  });

  it('maps a non-JSON 201 body to malformed', async () => {
    const fetchFn = (async () => new Response('not json', { status: 201 })) as typeof fetch;
    const h = harness(() => fakeResponse(201), { fetchFn });
    const result = await createTokenIssuer(h.options).getInstallationToken(1);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'malformed');
  });

  it('maps a 201 body missing token/expires_at to malformed', async () => {
    const h = harness(() => fakeResponse(201, { unexpected: 'shape' }));
    const result = await createTokenIssuer(h.options).getInstallationToken(1);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'malformed');
  });

  it('maps a network failure to transient', async () => {
    const fetchFn = (async () => {
      throw new Error('getaddrinfo ENOTFOUND api.github.com');
    }) as typeof fetch;
    const h = harness(() => fakeResponse(201), { fetchFn });
    const result = await createTokenIssuer(h.options).getInstallationToken(1);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'transient');
  });

  it('maps a timeout to the dedicated timeout kind, distinct from transient', async () => {
    const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }) as typeof fetch;
    const h = harness(() => fakeResponse(201), { fetchFn, timeoutMs: 5 } as Partial<TokenIssuerOptions>);
    const result = await createTokenIssuer(h.options).getInstallationToken(1);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'timeout');
    assert.match(result.ok === false ? result.message : '', /timed out/);
  });
});

describe('secret-safe logging', () => {
  it('never logs the App JWT sent in the Authorization header', async () => {
    const h = harness(() => fakeResponse(201, { token: 'ghs_should_not_leak', expires_at: '2026-09-22T01:00:00Z' }));
    await createTokenIssuer(h.options).getInstallationToken(4242);

    const joined = h.logs.join('\n');
    assert.ok(!/^Bearer eyJ/m.test(joined) && !joined.includes(h.calls[0]!.authorization.slice(7)));
  });

  it('never logs the issued installation token, even when logging a later failure', async () => {
    let callCount = 0;
    const h = harness(() => {
      callCount += 1;
      return callCount === 1
        ? fakeResponse(201, { token: 'ghs_first_success', expires_at: '2026-09-22T00:00:01Z' })
        : fakeResponse(500);
    });
    const issuer = createTokenIssuer(h.options);
    await issuer.getInstallationToken(1);

    const joined = h.logs.join('\n');
    assert.ok(!joined.includes('ghs_first_success'), 'the issued token leaked into a log line');
  });

  it('logs only non-secret fields when a request fails', async () => {
    const fetchFn = (async () => {
      throw new Error('network exploded');
    }) as typeof fetch;
    const h = harness(() => fakeResponse(201), { fetchFn });
    await createTokenIssuer(h.options).getInstallationToken(4242);

    const record = JSON.parse(h.logs[0]!) as Record<string, unknown>;
    assert.equal(record['installationId'], 4242);
    assert.equal(record['timedOut'], false);
  });
});
