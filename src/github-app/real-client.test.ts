/**
 * Every test here injects a fake `fetchFn`. None of them reach the network,
 * and none of them use a real GitHub App, installation, or repository —
 * "no real network calls" is proven by construction: every harness below
 * requires a `respond` function and never falls back to the real global
 * `fetch`. The private key is a synthetic RSA keypair generated fresh for
 * this test run — see jwt.test.ts's header comment for why that is safe.
 */

import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import { ObjectId } from 'mongodb';

import { createLogger } from '../logging/logger.ts';
import type { RepositoryRegistryDocument, RepositoryRegistryRepository } from '../repository-registry/repository.ts';
import type { RepositorySelectionDocument } from '../repository-selection/repository.ts';
import { authorizeRepositoryAccess, readRepositoryFile } from './access.ts';
import { createRealGitHubAppClient } from './real-client.ts';
import { createTokenIssuer } from './token-issuer.ts';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

const APP_ID = 123456;
const INSTALLATION_ID = 4242;
const NOW = new Date('2026-09-22T00:00:00.000Z');

function fakeResponse(status: number, body?: unknown, headers?: Record<string, string>): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    ...(headers === undefined ? {} : { headers }),
  });
}

function tokenExchangeResponse(): Response {
  return fakeResponse(201, { token: 'ghs_fake_installation_token', expires_at: '2026-09-22T01:00:00Z' });
}

interface Call {
  readonly url: string;
  readonly authorization: string;
}

interface Harness {
  readonly client: ReturnType<typeof createRealGitHubAppClient>;
  readonly calls: Call[];
  readonly logs: string[];
}

/** `respond` only needs to handle repos/installation calls — the token exchange is handled automatically unless `respond` intercepts that URL itself. */
function harness(respond: (url: string) => Response, options: { now?: () => Date } = {}): Harness {
  const calls: Call[] = [];
  const logs: string[] = [];
  const now = options.now ?? (() => NOW);

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const authorization = (init?.headers as Record<string, string>)?.['authorization'] ?? '';
    calls.push({ url, authorization });
    if (url.endsWith('/access_tokens')) return tokenExchangeResponse();
    return respond(url);
  }) as typeof fetch;

  const logger = createLogger({ level: 'debug', write: (line) => logs.push(line) });
  const tokenIssuer = createTokenIssuer({ appId: APP_ID, privateKey, logger, fetchFn, now });
  const client = createRealGitHubAppClient({ appId: APP_ID, privateKey, tokenIssuer, logger, fetchFn, now });

  return { client, calls, logs };
}

describe('resolveInstallation', () => {
  it('resolves the installation id for a known repository', async () => {
    const h = harness(() => fakeResponse(200, { id: INSTALLATION_ID }));
    const result = await h.client.resolveInstallation('cloudfuze', 'aisdlc-service');

    assert.deepEqual(result, { ok: true, installationId: INSTALLATION_ID });
    assert.ok(h.calls[0]!.url.endsWith('/repos/cloudfuze/aisdlc-service/installation'));
    assert.match(h.calls[0]!.authorization, /^Bearer eyJ/, 'resolveInstallation must authenticate with the App JWT');
  });

  it('maps 404 to installation_not_found', async () => {
    const h = harness(() => fakeResponse(404, { message: 'Not Found' }));
    const result = await h.client.resolveInstallation('cloudfuze', 'aisdlc-service');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'installation_not_found');
  });

  it('maps 401 to insufficient_permission', async () => {
    const h = harness(() => fakeResponse(401));
    const result = await h.client.resolveInstallation('cloudfuze', 'aisdlc-service');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'insufficient_permission');
  });

  it('maps a response missing an installation id to malformed', async () => {
    const h = harness(() => fakeResponse(200, { unexpected: 'shape' }));
    const result = await h.client.resolveInstallation('cloudfuze', 'aisdlc-service');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'malformed');
  });
});

describe('getRepositoryMetadata', () => {
  it('retrieves owner, repo, default branch and visibility', async () => {
    const h = harness(() =>
      fakeResponse(200, {
        owner: { login: 'cloudfuze' },
        name: 'aisdlc-service',
        default_branch: 'main',
        visibility: 'private',
      }),
    );
    const result = await h.client.getRepositoryMetadata(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service');

    assert.ok(result.ok);
    assert.deepEqual(result.metadata, {
      owner: 'cloudfuze',
      repo: 'aisdlc-service',
      defaultBranch: 'main',
      visibility: 'private',
    });
  });

  it('derives visibility from the legacy `private` boolean when `visibility` is absent', async () => {
    const h = harness(() =>
      fakeResponse(200, { owner: { login: 'cloudfuze' }, name: 'aisdlc-service', default_branch: 'main', private: true }),
    );
    const result = await h.client.getRepositoryMetadata(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service');
    assert.ok(result.ok);
    assert.equal(result.metadata.visibility, 'private');
  });

  it('authenticates with the installation token, not the App JWT', async () => {
    const h = harness(() =>
      fakeResponse(200, { owner: { login: 'cloudfuze' }, name: 'aisdlc-service', default_branch: 'main' }),
    );
    await h.client.getRepositoryMetadata(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service');
    const metadataCall = h.calls.find((c) => !c.url.endsWith('/access_tokens'))!;
    assert.equal(metadataCall.authorization, 'Bearer ghs_fake_installation_token');
  });

  describe('repository identity mismatch', () => {
    it('rejects a response describing a different owner', async () => {
      const h = harness(() =>
        fakeResponse(200, { owner: { login: 'someone-else' }, name: 'aisdlc-service', default_branch: 'main' }),
      );
      const result = await h.client.getRepositoryMetadata(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service');
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.kind, 'malformed');
    });

    it('rejects a response describing a different repository name', async () => {
      const h = harness(() =>
        fakeResponse(200, { owner: { login: 'cloudfuze' }, name: 'some-other-repo', default_branch: 'main' }),
      );
      const result = await h.client.getRepositoryMetadata(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service');
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.kind, 'malformed');
    });

    it('accepts a response that differs only in case', async () => {
      const h = harness(() =>
        fakeResponse(200, { owner: { login: 'CloudFuze' }, name: 'AISDLC-Service', default_branch: 'main' }),
      );
      const result = await h.client.getRepositoryMetadata(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service');
      assert.ok(result.ok);
    });
  });

  it('maps 404 to installation_not_found (missing installation token propagates the same way)', async () => {
    const h = harness(() => fakeResponse(404));
    const result = await h.client.getRepositoryMetadata(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'installation_not_found');
  });

  it('propagates a token-issuance failure without making the metadata request', async () => {
    const calls: Call[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, authorization: (init?.headers as Record<string, string>)?.['authorization'] ?? '' });
      if (url.endsWith('/access_tokens')) return fakeResponse(404); // "missing installation token"
      return fakeResponse(200, {});
    }) as typeof fetch;
    const logger = createLogger({ write: () => {} });
    const tokenIssuer = createTokenIssuer({ appId: APP_ID, privateKey, logger, fetchFn, now: () => NOW });
    const client = createRealGitHubAppClient({ appId: APP_ID, privateKey, tokenIssuer, logger, fetchFn, now: () => NOW });

    const result = await client.getRepositoryMetadata(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service');

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'installation_not_found');
    assert.equal(calls.length, 1, 'the metadata endpoint must never be called without a token');
  });
});

describe('getFileContents', () => {
  it('reads and base64-decodes a file', async () => {
    const content = Buffer.from('# aisdlc-service\n').toString('base64');
    const h = harness(() => fakeResponse(200, { type: 'file', encoding: 'base64', content }));
    const result = await h.client.getFileContents(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', 'README.md', 'main');

    assert.deepEqual(result, { ok: true, content: '# aisdlc-service\n' });
  });

  it('decodes base64 content that GitHub wraps with newlines', async () => {
    const raw = Buffer.from('a'.repeat(120)).toString('base64');
    const wrapped = raw.match(/.{1,60}/g)!.join('\n');
    const h = harness(() => fakeResponse(200, { type: 'file', encoding: 'base64', content: wrapped }));
    const result = await h.client.getFileContents(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', 'big.txt', 'main');

    assert.deepEqual(result, { ok: true, content: 'a'.repeat(120) });
  });

  it('handles an empty file', async () => {
    const h = harness(() => fakeResponse(200, { type: 'file', encoding: 'base64', content: '' }));
    const result = await h.client.getFileContents(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', '.gitkeep', 'main');
    assert.deepEqual(result, { ok: true, content: '' });
  });

  it('rejects invalid base64 content', async () => {
    const h = harness(() => fakeResponse(200, { type: 'file', encoding: 'base64', content: 'not-valid-base64!!!' }));
    const result = await h.client.getFileContents(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', 'x', 'main');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'malformed');
  });

  it('rejects a directory response instead of a file', async () => {
    const h = harness(() => fakeResponse(200, [{ type: 'file', name: 'a.ts' }, { type: 'dir', name: 'sub' }]));
    const result = await h.client.getFileContents(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', 'src', 'main');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'malformed');
  });

  it('rejects a response missing content (e.g. a file over the Contents API size limit)', async () => {
    const h = harness(() => fakeResponse(200, { type: 'file', encoding: 'base64' }));
    const result = await h.client.getFileContents(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', 'huge.bin', 'main');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'malformed');
  });

  it('maps a generic 404 to file_not_found', async () => {
    const h = harness(() => fakeResponse(404, { message: 'Not Found' }));
    const result = await h.client.getFileContents(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', 'missing.md', 'main');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'file_not_found');
  });

  it('maps a ref-specific 404 message to branch_not_found', async () => {
    const h = harness(() => fakeResponse(404, { message: "No commit found for the ref no-such-branch" }));
    const result = await h.client.getFileContents(
      INSTALLATION_ID,
      'cloudfuze',
      'aisdlc-service',
      'README.md',
      'no-such-branch',
    );
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'branch_not_found');
  });
});

describe('error classification shared across all three methods', () => {
  const calls: { name: string; run: (h: Harness) => Promise<{ ok: boolean; kind?: string; retryAfterMs?: number }> }[] = [
    {
      name: 'resolveInstallation',
      run: (h) => h.client.resolveInstallation('cloudfuze', 'aisdlc-service') as Promise<{ ok: boolean; kind?: string }>,
    },
    {
      name: 'getRepositoryMetadata',
      run: (h) =>
        h.client.getRepositoryMetadata(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service') as Promise<{
          ok: boolean;
          kind?: string;
        }>,
    },
    {
      name: 'getFileContents',
      run: (h) =>
        h.client.getFileContents(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', 'x', 'main') as Promise<{
          ok: boolean;
          kind?: string;
        }>,
    },
  ];

  for (const { name, run } of calls) {
    describe(name, () => {
      it('does not classify a bare 403 as rate limiting', async () => {
        const h = harness(() => fakeResponse(403));
        const result = await run(h);
        assert.equal(result.ok, false);
        assert.equal(result.kind, 'insufficient_permission');
      });

      it('classifies a 403 with rate-limit evidence as rate_limited', async () => {
        const h = harness(() => fakeResponse(403, undefined, { 'retry-after': '20' }));
        const result = await run(h);
        assert.equal(result.ok, false);
        assert.equal(result.kind, 'rate_limited');
        assert.equal(result.retryAfterMs, 20_000);
      });

      it('classifies a 429 as rate_limited', async () => {
        const h = harness(() => fakeResponse(429));
        const result = await run(h);
        assert.equal(result.ok, false);
        assert.equal(result.kind, 'rate_limited');
      });

      it('classifies a 422 as malformed', async () => {
        const h = harness(() => fakeResponse(422, { message: 'Validation Failed' }));
        const result = await run(h);
        assert.equal(result.ok, false);
        assert.equal(result.kind, 'malformed');
      });

      for (const status of [500, 502, 503, 504]) {
        it(`classifies a ${status} as retryable transient`, async () => {
          const h = harness(() => fakeResponse(status));
          const result = await run(h);
          assert.equal(result.ok, false);
          assert.equal(result.kind, 'transient');
        });
      }

      it('classifies malformed JSON as malformed', async () => {
        const fetchFn = (async (input: string | URL | Request) => {
          if (String(input).endsWith('/access_tokens')) return tokenExchangeResponse();
          return new Response('not json', { status: 200 });
        }) as typeof fetch;
        const logger = createLogger({ write: () => {} });
        const tokenIssuer = createTokenIssuer({ appId: APP_ID, privateKey, logger, fetchFn, now: () => NOW });
        const client = createRealGitHubAppClient({ appId: APP_ID, privateKey, tokenIssuer, logger, fetchFn, now: () => NOW });
        const result = await run({ client, calls: [], logs: [] });
        assert.equal(result.ok, false);
        assert.equal(result.kind, 'malformed');
      });

      it('classifies a network failure as transient', async () => {
        const fetchFn = (async (input: string | URL | Request) => {
          if (String(input).endsWith('/access_tokens')) return tokenExchangeResponse();
          throw new Error('getaddrinfo ENOTFOUND api.github.com');
        }) as typeof fetch;
        const logger = createLogger({ write: () => {} });
        const tokenIssuer = createTokenIssuer({ appId: APP_ID, privateKey, logger, fetchFn, now: () => NOW });
        const client = createRealGitHubAppClient({ appId: APP_ID, privateKey, tokenIssuer, logger, fetchFn, now: () => NOW });
        const result = await run({ client, calls: [], logs: [] });
        assert.equal(result.ok, false);
        assert.equal(result.kind, 'transient');
      });

      it('classifies a timeout as transient', async () => {
        const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
          if (String(input).endsWith('/access_tokens')) return tokenExchangeResponse();
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          });
        }) as typeof fetch;
        const logger = createLogger({ write: () => {} });
        const tokenIssuer = createTokenIssuer({ appId: APP_ID, privateKey, logger, fetchFn, now: () => NOW });
        const client = createRealGitHubAppClient({
          appId: APP_ID,
          privateKey,
          tokenIssuer,
          logger,
          fetchFn,
          now: () => NOW,
          timeoutMs: 5,
        });
        const result = await run({ client, calls: [], logs: [] });
        assert.equal(result.ok, false);
        assert.equal(result.kind, 'transient');
      });

      it('rejects a redirect rather than following it', async () => {
        const fetchFn = (async (input: string | URL | Request) => {
          if (String(input).endsWith('/access_tokens')) return tokenExchangeResponse();
          throw new TypeError('fetch failed: unexpected redirect, redirect mode is set to error');
        }) as typeof fetch;
        const logger = createLogger({ write: () => {} });
        const tokenIssuer = createTokenIssuer({ appId: APP_ID, privateKey, logger, fetchFn, now: () => NOW });
        const client = createRealGitHubAppClient({ appId: APP_ID, privateKey, tokenIssuer, logger, fetchFn, now: () => NOW });
        const result = await run({ client, calls: [], logs: [] });
        assert.equal(result.ok, false);
        assert.equal(result.kind, 'unexpected_redirect');
      });
    });
  }

  it('every real request sets redirect: "error"', async () => {
    const seenInit: RequestInit[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      seenInit.push(init!);
      if (String(input).endsWith('/access_tokens')) return tokenExchangeResponse();
      return fakeResponse(200, { id: INSTALLATION_ID });
    }) as typeof fetch;
    const logger = createLogger({ write: () => {} });
    const tokenIssuer = createTokenIssuer({ appId: APP_ID, privateKey, logger, fetchFn, now: () => NOW });
    const client = createRealGitHubAppClient({ appId: APP_ID, privateKey, tokenIssuer, logger, fetchFn, now: () => NOW });

    await client.resolveInstallation('cloudfuze', 'aisdlc-service');
    for (const init of seenInit) assert.equal(init.redirect, 'error');
  });
});

describe('secret-safe logging', () => {
  it('never logs the App JWT, the installation token, or a raw Authorization header value', async () => {
    const h = harness(() =>
      fakeResponse(200, { owner: { login: 'cloudfuze' }, name: 'aisdlc-service', default_branch: 'main' }),
    );
    await h.client.resolveInstallation('cloudfuze', 'aisdlc-service');
    const metadata = await h.client.getRepositoryMetadata(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service');
    assert.ok(metadata.ok);

    const joined = h.logs.join('\n');
    for (const call of h.calls) {
      const token = call.authorization.replace(/^Bearer\s+/, '');
      if (token !== '') assert.ok(!joined.includes(token), 'a credential value leaked into the log output');
    }
  });

  it('logs only non-secret fields when a request fails', async () => {
    const fetchFn = (async (input: string | URL | Request) => {
      if (String(input).endsWith('/access_tokens')) return tokenExchangeResponse();
      throw new Error('network exploded');
    }) as typeof fetch;
    const logs: string[] = [];
    const logger = createLogger({ level: 'debug', write: (line) => logs.push(line) });
    const tokenIssuer = createTokenIssuer({ appId: APP_ID, privateKey, logger, fetchFn, now: () => NOW });
    const client = createRealGitHubAppClient({ appId: APP_ID, privateKey, tokenIssuer, logger, fetchFn, now: () => NOW });

    await client.getRepositoryMetadata(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service');

    const record = JSON.parse(logs[0]!) as Record<string, unknown>;
    assert.equal(record['timedOut'], false);
    assert.ok(!JSON.stringify(record).includes('ghs_'));
  });
});

describe('integration with access.ts: authorization happens before any HTTP request', () => {
  const NOW2 = NOW;

  function registryEntry(overrides: Partial<RepositoryRegistryDocument> = {}): RepositoryRegistryDocument {
    return {
      _id: new ObjectId(),
      projectIdentifier: 'CF',
      repositoryId: 'aisdlc-service',
      repositoryUrl: 'https://github.com/cloudfuze/aisdlc-service',
      defaultBranch: 'main',
      allowedBranches: ['main', 'feature/*'],
      status: 'active',
      accessPolicy: { installationId: INSTALLATION_ID },
      createdAt: NOW2,
      updatedAt: NOW2,
      createdBy: 'operator:alice',
      updatedBy: 'operator:alice',
      ...overrides,
    };
  }

  function selection(overrides: Partial<RepositorySelectionDocument> = {}): RepositorySelectionDocument {
    return {
      _id: new ObjectId(),
      runId: new ObjectId(),
      intakeItemId: new ObjectId(),
      issueKey: 'CF-1',
      projectIdentifier: 'CF',
      candidateRepositoryIds: ['aisdlc-service'],
      selectedRepositoryId: 'aisdlc-service',
      selectedRepositoryUrl: 'https://github.com/cloudfuze/aisdlc-service',
      selectedDefaultBranch: 'main',
      selectedAllowedBranches: ['main', 'feature/*'],
      selectedAccessPolicy: null,
      status: 'selected',
      failureReason: null,
      attempts: 0,
      nextAttemptAt: NOW2,
      confirmedBy: 'operator:alice',
      confirmedAt: NOW2,
      lastNotifiedStatus: null,
      createdAt: NOW2,
      updatedAt: NOW2,
      ...overrides,
    };
  }

  function buildDeps(registryEntries: RepositoryRegistryDocument[], respond: (url: string) => Response) {
    let fetchCalls = 0;
    const fetchFn = (async (input: string | URL | Request) => {
      fetchCalls += 1;
      if (String(input).endsWith('/access_tokens')) return tokenExchangeResponse();
      return respond(String(input));
    }) as typeof fetch;

    const logger = createLogger({ write: () => {} });
    const tokenIssuer = createTokenIssuer({ appId: APP_ID, privateKey, logger, fetchFn, now: () => NOW2 });
    const client = createRealGitHubAppClient({ appId: APP_ID, privateKey, tokenIssuer, logger, fetchFn, now: () => NOW2 });

    const registry: RepositoryRegistryRepository = {
      async create() {
        throw new Error('must not be called');
      },
      async findById() {
        throw new Error('must not be called');
      },
      async list() {
        throw new Error('must not be called');
      },
      async findActiveByProjectIdentifier(projectIdentifier) {
        return registryEntries.filter((e) => e.projectIdentifier === projectIdentifier && e.status === 'active');
      },
      async update() {
        throw new Error('must not be called');
      },
      async setStatus() {
        throw new Error('must not be called');
      },
    };

    return { deps: { registry, client, logger }, getFetchCalls: () => fetchCalls };
  }

  it('never calls the real client for an unconfirmed selection', async () => {
    const { deps, getFetchCalls } = buildDeps([registryEntry()], () => fakeResponse(200, {}));
    const result = await authorizeRepositoryAccess(deps, selection({ status: 'pending' }));
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'selection_not_confirmed');
    assert.equal(getFetchCalls(), 0);
  });

  it('never calls the real client for an inactive registry entry', async () => {
    const { deps, getFetchCalls } = buildDeps([registryEntry({ status: 'inactive' })], () => fakeResponse(200, {}));
    const result = await authorizeRepositoryAccess(deps, selection());
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'repository_inactive');
    assert.equal(getFetchCalls(), 0);
  });

  it('never calls the real client for an unsupported (non-GitHub) host', async () => {
    const { deps, getFetchCalls } = buildDeps([registryEntry()], () => fakeResponse(200, {}));
    const result = await authorizeRepositoryAccess(
      deps,
      selection({ selectedRepositoryUrl: 'https://gitlab.com/cloudfuze/aisdlc-service' }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'unsupported_repository_url');
    assert.equal(getFetchCalls(), 0);
  });

  it('never calls the real client for a disallowed branch', async () => {
    const { deps, getFetchCalls } = buildDeps([registryEntry()], () => fakeResponse(200, {}));
    const result = await authorizeRepositoryAccess(deps, selection(), { branch: 'staging' });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'branch_not_allowed');
    assert.equal(getFetchCalls(), 0);
  });

  it('authorizes a fixed (exact) allowed branch end to end, using the real client', async () => {
    const { deps } = buildDeps([registryEntry()], () =>
      fakeResponse(200, { type: 'file', encoding: 'base64', content: Buffer.from('hi').toString('base64') }),
    );
    const result = await readRepositoryFile(deps, selection(), 'README.md');
    assert.deepEqual(result, { ok: true, content: 'hi' });
  });

  it('authorizes a branch covered only by a wildcard pattern end to end, using the real client', async () => {
    const { deps } = buildDeps([registryEntry()], () =>
      fakeResponse(200, { type: 'file', encoding: 'base64', content: Buffer.from('hi').toString('base64') }),
    );
    const result = await readRepositoryFile(
      deps,
      selection({ selectedDefaultBranch: 'feature/login' }),
      'README.md',
    );
    assert.deepEqual(result, { ok: true, content: 'hi' });
  });
});
