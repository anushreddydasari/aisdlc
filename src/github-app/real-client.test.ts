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

  it('maps 401 to authentication_failed', async () => {
    const h = harness(() => fakeResponse(401));
    const result = await h.client.resolveInstallation('cloudfuze', 'aisdlc-service');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'authentication_failed');
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

      it('classifies a timeout as the dedicated timeout kind, distinct from transient', async () => {
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
        assert.equal(result.kind, 'timeout');
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

describe('getRef', () => {
  it('returns the sha a branch currently points at', async () => {
    const h = harness(() => fakeResponse(200, { ref: 'refs/heads/main', object: { type: 'commit', sha: 'abc123' } }));
    const result = await h.client.getRef(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', 'main');
    assert.deepEqual(result, { ok: true, sha: 'abc123' });
    assert.ok(h.calls.some((c) => c.url.endsWith('/git/ref/heads/main')));
  });

  it('url-encodes a branch name containing slashes without escaping the separators', async () => {
    const h = harness(() => fakeResponse(200, { object: { sha: 'abc123' } }));
    await h.client.getRef(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', 'aisdlc/run-1/exec-1');
    assert.ok(h.calls.some((c) => c.url.endsWith('/git/ref/heads/aisdlc/run-1/exec-1')));
  });

  it('maps a missing branch to branch_not_found', async () => {
    const h = harness(() => fakeResponse(404, { message: 'Not Found' }));
    const result = await h.client.getRef(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', 'no-such-branch');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'branch_not_found');
  });

  it('maps a response missing object.sha to malformed', async () => {
    const h = harness(() => fakeResponse(200, { unexpected: 'shape' }));
    const result = await h.client.getRef(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', 'main');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'malformed');
  });
});

describe('getCommit', () => {
  it("returns a commit's tree sha", async () => {
    const h = harness(() => fakeResponse(200, { sha: 'abc123', tree: { sha: 'tree456' } }));
    const result = await h.client.getCommit(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', 'abc123');
    assert.deepEqual(result, { ok: true, treeSha: 'tree456' });
  });

  it('maps a missing commit to malformed', async () => {
    const h = harness(() => fakeResponse(404, { message: 'Not Found' }));
    const result = await h.client.getCommit(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', 'does-not-exist');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'malformed');
  });
});

describe('getTree', () => {
  it('lists blobs recursively with sizes, skipping directories and submodules', async () => {
    const h = harness(() =>
      fakeResponse(200, {
        sha: 'tree456',
        truncated: false,
        tree: [
          { path: 'index.html', type: 'blob', size: 3712 },
          { path: 'css', type: 'tree' },
          { path: 'css/styles.css', type: 'blob', size: 5100 },
          { path: 'vendor/lib', type: 'commit' },
        ],
      }),
    );
    const result = await h.client.getTree(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', 'tree456');
    assert.deepEqual(result, {
      ok: true,
      files: [
        { path: 'index.html', size: 3712 },
        { path: 'css/styles.css', size: 5100 },
      ],
      truncated: false,
    });
    assert.match(h.calls.at(-1)!.url, /\/git\/trees\/tree456\?recursive=1$/);
  });

  it("passes GitHub's truncated flag through", async () => {
    const h = harness(() => fakeResponse(200, { truncated: true, tree: [] }));
    const result = await h.client.getTree(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', 'big');
    assert.equal(result.ok && result.truncated, true);
  });

  it('maps a missing tree to malformed', async () => {
    const h = harness(() => fakeResponse(404, { message: 'Not Found' }));
    const result = await h.client.getTree(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', 'nope');
    assert.equal(result.ok === false && result.kind, 'malformed');
  });
});

describe('createTree', () => {
  it('posts the base tree and file entries, returning the new tree sha', async () => {
    let sentBody: unknown;
    // Capture the body via a dedicated fetchFn, since `harness` only exposes the URL to `respond`.
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/access_tokens')) return fakeResponse(201, { token: 'ghs_fake', expires_at: '2026-09-22T01:00:00Z' });
      if (typeof init?.body === 'string') sentBody = JSON.parse(init.body);
      return fakeResponse(201, { sha: 'tree789' });
    }) as typeof fetch;
    const logger = createLogger({ write: () => {} });
    const tokenIssuer = createTokenIssuer({ appId: APP_ID, privateKey, logger, fetchFn, now: () => NOW });
    const client = createRealGitHubAppClient({ appId: APP_ID, privateKey, tokenIssuer, logger, fetchFn, now: () => NOW });

    const result = await client.createTree(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', 'base-tree-sha', [
      { path: 'README.md', content: '# updated' },
    ]);

    assert.deepEqual(result, { ok: true, sha: 'tree789' });
    assert.deepEqual(sentBody, {
      base_tree: 'base-tree-sha',
      tree: [{ path: 'README.md', mode: '100644', type: 'blob', content: '# updated' }],
    });
  });

  it('maps a response missing sha to malformed', async () => {
    const h = harness(() => fakeResponse(201, {}));
    const result = await h.client.createTree(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', 'base', []);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'malformed');
  });
});

describe('createCommit', () => {
  it('posts message, tree, and parents, returning the new commit sha', async () => {
    let sentBody: unknown;
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/access_tokens')) return fakeResponse(201, { token: 'ghs_fake', expires_at: '2026-09-22T01:00:00Z' });
      if (typeof init?.body === 'string') sentBody = JSON.parse(init.body);
      return fakeResponse(201, { sha: 'commit789' });
    }) as typeof fetch;
    const logger = createLogger({ write: () => {} });
    const tokenIssuer = createTokenIssuer({ appId: APP_ID, privateKey, logger, fetchFn, now: () => NOW });
    const client = createRealGitHubAppClient({ appId: APP_ID, privateKey, tokenIssuer, logger, fetchFn, now: () => NOW });

    const result = await client.createCommit(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', 'AISDLC: update README', 'tree789', [
      'base-commit-sha',
    ]);

    assert.deepEqual(result, { ok: true, sha: 'commit789' });
    assert.deepEqual(sentBody, { message: 'AISDLC: update README', tree: 'tree789', parents: ['base-commit-sha'] });
  });
});

describe('createBranch', () => {
  it('creates a new ref and reports success with no body to interpret', async () => {
    const h = harness(() => fakeResponse(201, { ref: 'refs/heads/aisdlc/run-1/exec-1' }));
    const result = await h.client.createBranch(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', 'aisdlc/run-1/exec-1', 'commit789');
    assert.deepEqual(result, { ok: true });
  });

  it('maps a 422 to ref_already_exists, never overwriting the existing ref', async () => {
    const h = harness(() => fakeResponse(422, { message: 'Reference already exists' }));
    const result = await h.client.createBranch(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', 'aisdlc/run-1/exec-1', 'commit789');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'ref_already_exists');
    assert.match((result.ok === false && result.message) || '', /already exists/);
  });

  it('posts exactly the requested branch name and sha — the base branch is never named in the request', async () => {
    let sentBody: unknown;
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/access_tokens')) return tokenExchangeResponse();
      if (typeof init?.body === 'string') sentBody = JSON.parse(init.body);
      return fakeResponse(201, {});
    }) as typeof fetch;
    const logger = createLogger({ write: () => {} });
    const tokenIssuer = createTokenIssuer({ appId: APP_ID, privateKey, logger, fetchFn, now: () => NOW });
    const client = createRealGitHubAppClient({ appId: APP_ID, privateKey, tokenIssuer, logger, fetchFn, now: () => NOW });

    await client.createBranch(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', 'aisdlc/run-1/exec-1', 'commit789');

    assert.deepEqual(sentBody, { ref: 'refs/heads/aisdlc/run-1/exec-1', sha: 'commit789' });
  });
});

describe('createPullRequest', () => {
  it('creates a pull request and returns its number, url, and state', async () => {
    const h = harness(() => fakeResponse(201, { number: 42, html_url: 'https://github.com/cloudfuze/aisdlc-service/pull/42', state: 'open' }));
    const result = await h.client.createPullRequest(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', {
      title: 'AISDLC: update README',
      body: 'Approved via AISDLC.',
      head: 'aisdlc/run-1/exec-1',
      base: 'main',
    });
    assert.deepEqual(result, { ok: true, number: 42, htmlUrl: 'https://github.com/cloudfuze/aisdlc-service/pull/42', state: 'open' });
  });

  it('maps a 422 to pull_request_already_exists rather than a generic failure', async () => {
    const h = harness(() => fakeResponse(422, { message: 'A pull request already exists for cloudfuze:aisdlc/run-1/exec-1.' }));
    const result = await h.client.createPullRequest(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', {
      title: 't',
      body: 'b',
      head: 'aisdlc/run-1/exec-1',
      base: 'main',
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'pull_request_already_exists');
  });

  it('maps a response missing number/html_url/state to malformed', async () => {
    const h = harness(() => fakeResponse(201, { unexpected: 'shape' }));
    const result = await h.client.createPullRequest(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', {
      title: 't',
      body: 'b',
      head: 'aisdlc/run-1/exec-1',
      base: 'main',
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'malformed');
  });
});

describe('findPullRequestForBranch', () => {
  it('returns the open pull request for a head/base pair', async () => {
    const h = harness(() =>
      fakeResponse(200, [{ number: 42, html_url: 'https://github.com/cloudfuze/aisdlc-service/pull/42', state: 'open' }]),
    );
    const result = await h.client.findPullRequestForBranch(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', 'aisdlc/run-1/exec-1', 'main');
    assert.deepEqual(result, {
      ok: true,
      pullRequest: { number: 42, htmlUrl: 'https://github.com/cloudfuze/aisdlc-service/pull/42', state: 'open' },
    });
  });

  it('returns null when no pull request is open for that pair', async () => {
    const h = harness(() => fakeResponse(200, []));
    const result = await h.client.findPullRequestForBranch(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', 'aisdlc/run-1/exec-1', 'main');
    assert.deepEqual(result, { ok: true, pullRequest: null });
  });
});

describe('getPullRequest (PR merge detection)', () => {
  it('reports an open, unmerged PR', async () => {
    const h = harness(() =>
      fakeResponse(200, {
        number: 7,
        html_url: 'https://github.com/cloudfuze/aisdlc-service/pull/7',
        state: 'open',
        merged: false,
        merge_commit_sha: null,
        head: { ref: 'aisdlc/run-1/exec-1' },
        base: { ref: 'main' },
      }),
    );
    const result = await h.client.getPullRequest(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', 7);
    assert.deepEqual(result, {
      ok: true,
      number: 7,
      htmlUrl: 'https://github.com/cloudfuze/aisdlc-service/pull/7',
      state: 'open',
      merged: false,
      mergeCommitSha: null,
      headRef: 'aisdlc/run-1/exec-1',
      baseRef: 'main',
    });
  });

  it('reports a merged PR with its merge commit sha', async () => {
    const h = harness(() =>
      fakeResponse(200, {
        number: 8,
        html_url: 'https://github.com/cloudfuze/aisdlc-service/pull/8',
        state: 'closed',
        merged: true,
        merge_commit_sha: 'deadbeefcafe',
        head: { ref: 'aisdlc/run-2/exec-2' },
        base: { ref: 'main' },
      }),
    );
    const result = await h.client.getPullRequest(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', 8);
    assert.ok(result.ok);
    assert.equal(result.merged, true);
    assert.equal(result.mergeCommitSha, 'deadbeefcafe');
  });

  it('reports a closed, unmerged PR — never conflating closed with merged', async () => {
    const h = harness(() =>
      fakeResponse(200, {
        number: 9,
        html_url: 'https://github.com/cloudfuze/aisdlc-service/pull/9',
        state: 'closed',
        merged: false,
        merge_commit_sha: null,
        head: { ref: 'aisdlc/run-3/exec-3' },
        base: { ref: 'main' },
      }),
    );
    const result = await h.client.getPullRequest(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', 9);
    assert.ok(result.ok);
    assert.equal(result.state, 'closed');
    assert.equal(result.merged, false);
  });

  it('maps a 404 to file_not_found', async () => {
    const h = harness(() => fakeResponse(404, { message: 'Not Found' }));
    const result = await h.client.getPullRequest(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', 999);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'file_not_found');
  });

  it('maps a response missing merged/head.ref/base.ref to malformed', async () => {
    const h = harness(() => fakeResponse(200, { number: 7, html_url: 'x', state: 'open' }));
    const result = await h.client.getPullRequest(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', 7);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'malformed');
  });

  it('classifies a 429 as rate_limited', async () => {
    const h = harness(() => fakeResponse(429));
    const result = await h.client.getPullRequest(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', 7);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'rate_limited');
  });

  it('classifies a 5xx as retryable transient', async () => {
    const h = harness(() => fakeResponse(503));
    const result = await h.client.getPullRequest(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', 7);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'transient');
  });
});

describe('write-method status classification (shared with the read methods)', () => {
  const writeCalls: { name: string; run: (h: Harness) => Promise<{ ok: boolean; kind?: string }> }[] = [
    { name: 'getRef', run: (h) => h.client.getRef(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', 'main') as Promise<{ ok: boolean; kind?: string }> },
    {
      name: 'createTree',
      run: (h) =>
        h.client.createTree(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', 'base', []) as Promise<{ ok: boolean; kind?: string }>,
    },
    {
      name: 'createBranch',
      run: (h) =>
        h.client.createBranch(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', 'aisdlc/run-1/exec-1', 'sha') as Promise<{
          ok: boolean;
          kind?: string;
        }>,
    },
    {
      name: 'createPullRequest',
      run: (h) =>
        h.client.createPullRequest(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', {
          title: 't',
          body: 'b',
          head: 'aisdlc/run-1/exec-1',
          base: 'main',
        }) as Promise<{ ok: boolean; kind?: string }>,
    },
  ];

  for (const { name, run } of writeCalls) {
    describe(name, () => {
      it('maps 401 to authentication_failed', async () => {
        const h = harness(() => fakeResponse(401));
        const result = await run(h);
        assert.equal(result.ok, false);
        assert.equal(result.kind, 'authentication_failed');
      });

      it('classifies a 429 as rate_limited', async () => {
        const h = harness(() => fakeResponse(429));
        const result = await run(h);
        assert.equal(result.ok, false);
        assert.equal(result.kind, 'rate_limited');
      });

      it('classifies a 5xx as retryable transient', async () => {
        const h = harness(() => fakeResponse(503));
        const result = await run(h);
        assert.equal(result.ok, false);
        assert.equal(result.kind, 'transient');
      });

      it('classifies a timeout distinctly from transient', async () => {
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
        assert.equal(result.kind, 'timeout');
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

  it('every write request also sets redirect: "error"', async () => {
    // Excludes the token-exchange call: that request belongs to
    // `token-issuer.ts`, a separately-tested module with its own security
    // properties — this test only asserts on requests this client's own
    // write methods make.
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), init: init! });
      if (String(input).endsWith('/access_tokens')) return tokenExchangeResponse();
      return fakeResponse(201, { sha: 'abc' });
    }) as typeof fetch;
    const logger = createLogger({ write: () => {} });
    const tokenIssuer = createTokenIssuer({ appId: APP_ID, privateKey, logger, fetchFn, now: () => NOW });
    const client = createRealGitHubAppClient({ appId: APP_ID, privateKey, tokenIssuer, logger, fetchFn, now: () => NOW });

    await client.createTree(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', 'base', []);
    const writeCalls = seen.filter((c) => !c.url.endsWith('/access_tokens'));
    assert.ok(writeCalls.length > 0);
    for (const call of writeCalls) assert.equal(call.init.redirect, 'error');
  });

  it('sends the JSON body with a content-type header on every write request', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), init: init! });
      if (String(input).endsWith('/access_tokens')) return tokenExchangeResponse();
      return fakeResponse(201, { sha: 'abc' });
    }) as typeof fetch;
    const logger = createLogger({ write: () => {} });
    const tokenIssuer = createTokenIssuer({ appId: APP_ID, privateKey, logger, fetchFn, now: () => NOW });
    const client = createRealGitHubAppClient({ appId: APP_ID, privateKey, tokenIssuer, logger, fetchFn, now: () => NOW });

    await client.createTree(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', 'base', [{ path: 'a.ts', content: 'x' }]);
    const writeCall = seen.find((c) => !c.url.endsWith('/access_tokens'));
    assert.ok(writeCall !== undefined);
    assert.equal(writeCall.init.method, 'POST');
    assert.equal((writeCall.init.headers as Record<string, string>)['content-type'], 'application/json');
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
