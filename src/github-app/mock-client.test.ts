import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createMockGitHubAppClient, type MockRepository } from './mock-client.ts';

const REPO: MockRepository = {
  owner: 'cloudfuze',
  repo: 'aisdlc-service',
  installationId: 4242,
  defaultBranch: 'main',
  branches: ['main', 'feature/login'],
  visibility: 'private',
  files: {
    'README.md': '# aisdlc-service',
    'src/index.ts': 'export {};',
  },
};

describe('resolveInstallation (repository lookup)', () => {
  it('resolves the installation id for a known repository', async () => {
    const client = createMockGitHubAppClient({ repositories: [REPO] });
    const result = await client.resolveInstallation('cloudfuze', 'aisdlc-service');
    assert.deepEqual(result, { ok: true, installationId: 4242 });
  });

  it('reports installation_not_found for an unknown repository', async () => {
    const client = createMockGitHubAppClient({ repositories: [REPO] });
    const result = await client.resolveInstallation('cloudfuze', 'some-other-repo');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'installation_not_found');
  });
});

describe('getRepositoryMetadata (repository lookup)', () => {
  it('returns the default branch and visibility for a known repository', async () => {
    const client = createMockGitHubAppClient({ repositories: [REPO] });
    const result = await client.getRepositoryMetadata(4242, 'cloudfuze', 'aisdlc-service');
    assert.ok(result.ok);
    assert.equal(result.metadata.defaultBranch, 'main');
    assert.equal(result.metadata.visibility, 'private');
  });

  it('reports installation_not_found when the installation id does not match the repository', async () => {
    const client = createMockGitHubAppClient({ repositories: [REPO] });
    const result = await client.getRepositoryMetadata(9999, 'cloudfuze', 'aisdlc-service');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'installation_not_found');
  });
});

describe('getInstallationToken (mocked installation-token generation)', () => {
  it('issues a deterministic-shaped, obviously-fake token with a 1-hour expiry', async () => {
    const now = new Date('2026-09-22T00:00:00.000Z');
    const client = createMockGitHubAppClient({ repositories: [REPO], now: () => now });

    const result = await client.getInstallationToken(4242);

    assert.ok(result.ok);
    assert.match(result.token, /^mock-token-4242-\d+$/);
    assert.equal(result.expiresAt.toISOString(), '2026-09-22T01:00:00.000Z');
  });

  it('issues a different token on each call', async () => {
    const client = createMockGitHubAppClient({ repositories: [REPO] });
    const first = await client.getInstallationToken(4242);
    const second = await client.getInstallationToken(4242);
    assert.ok(first.ok && second.ok);
    assert.notEqual(first.token, second.token);
  });

  it('reports installation_not_found for an installation id that matches no configured repository', async () => {
    const client = createMockGitHubAppClient({ repositories: [REPO] });
    const result = await client.getInstallationToken(1234);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'installation_not_found');
  });

  describe('retryable versus non-retryable errors', () => {
    it('can be configured to fail with a retryable rate_limited error, including retryAfterMs', async () => {
      const client = createMockGitHubAppClient({
        repositories: [REPO],
        tokenFailures: { 4242: 'rate_limited' },
        retryAfterMs: { 4242: 30_000 },
      });
      const result = await client.getInstallationToken(4242);
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.kind, 'rate_limited');
      assert.equal(result.ok === false && result.retryAfterMs, 30_000);
    });

    it('can be configured to fail with a retryable transient error', async () => {
      const client = createMockGitHubAppClient({
        repositories: [REPO],
        tokenFailures: { 4242: 'transient' },
      });
      const result = await client.getInstallationToken(4242);
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.kind, 'transient');
    });

    it('can be configured to fail with a non-retryable insufficient_permission error', async () => {
      const client = createMockGitHubAppClient({
        repositories: [REPO],
        tokenFailures: { 4242: 'insufficient_permission' },
      });
      const result = await client.getInstallationToken(4242);
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.kind, 'insufficient_permission');
    });
  });
});

describe('getFileContents (mocked repository-file reading)', () => {
  it('reads a file that exists at an existing branch', async () => {
    const client = createMockGitHubAppClient({ repositories: [REPO] });
    const result = await client.getFileContents(4242, 'cloudfuze', 'aisdlc-service', 'README.md', 'main');
    assert.deepEqual(result, { ok: true, content: '# aisdlc-service' });
  });

  it('reports file_not_found for a path that does not exist at that branch', async () => {
    const client = createMockGitHubAppClient({ repositories: [REPO] });
    const result = await client.getFileContents(4242, 'cloudfuze', 'aisdlc-service', 'missing.md', 'main');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'file_not_found');
  });

  it('reports branch_not_found for a ref that does not exist on the mocked remote (branch validation)', async () => {
    const client = createMockGitHubAppClient({ repositories: [REPO] });
    const result = await client.getFileContents(4242, 'cloudfuze', 'aisdlc-service', 'README.md', 'no-such-branch');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'branch_not_found');
  });

  it('reports insufficient_permission for a repository configured as unreadable (unauthorized access)', async () => {
    const unreadable: MockRepository = { ...REPO, readable: false };
    const client = createMockGitHubAppClient({ repositories: [unreadable] });
    const result = await client.getFileContents(4242, 'cloudfuze', 'aisdlc-service', 'README.md', 'main');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'insufficient_permission');
  });

  it('reports installation_not_found when the installation id does not cover the repository', async () => {
    const client = createMockGitHubAppClient({ repositories: [REPO] });
    const result = await client.getFileContents(1, 'cloudfuze', 'aisdlc-service', 'README.md', 'main');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'installation_not_found');
  });
});

describe('secret-safe logging', () => {
  it('never issues a token that looks like a real GitHub installation token', async () => {
    // Real GitHub installation tokens are opaque `ghs_...` strings. The mock
    // must never coincidentally look like one, so a test or log line
    // containing it is unambiguously identifiable as a mock artifact.
    const client = createMockGitHubAppClient({ repositories: [REPO] });
    const result = await client.getInstallationToken(4242);
    assert.ok(result.ok);
    assert.ok(!result.token.startsWith('ghs_'), 'mock token must not resemble a real GitHub token');
    assert.match(result.token, /^mock-token-/);
  });
});
