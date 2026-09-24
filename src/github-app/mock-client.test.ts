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

describe('getRef / getCommit (mocked branch and commit reads)', () => {
  it('returns the genesis commit sha for a declared branch', async () => {
    const client = createMockGitHubAppClient({ repositories: [REPO] });
    const ref = await client.getRef(4242, 'cloudfuze', 'aisdlc-service', 'main');
    assert.ok(ref.ok);
    assert.match(ref.sha, /^mock-commit-genesis-/);
  });

  it('reports branch_not_found for an undeclared branch', async () => {
    const client = createMockGitHubAppClient({ repositories: [REPO] });
    const ref = await client.getRef(4242, 'cloudfuze', 'aisdlc-service', 'no-such-branch');
    assert.equal(ref.ok, false);
    assert.equal(ref.ok === false && ref.kind, 'branch_not_found');
  });

  it('returns the tree sha for a known commit', async () => {
    const client = createMockGitHubAppClient({ repositories: [REPO] });
    const ref = await client.getRef(4242, 'cloudfuze', 'aisdlc-service', 'main');
    assert.ok(ref.ok);
    const commit = await client.getCommit(4242, 'cloudfuze', 'aisdlc-service', ref.sha);
    assert.ok(commit.ok);
    assert.match(commit.treeSha, /^mock-tree-genesis-/);
  });

  it('reports malformed for an unknown commit sha', async () => {
    const client = createMockGitHubAppClient({ repositories: [REPO] });
    const commit = await client.getCommit(4242, 'cloudfuze', 'aisdlc-service', 'sha-does-not-exist');
    assert.equal(commit.ok, false);
    assert.equal(commit.ok === false && commit.kind, 'malformed');
  });
});

describe('createTree / createCommit / createBranch (the publish write path)', () => {
  it('builds a tree on top of the base, keeping unrelated files and overwriting/adding the given ones', async () => {
    const client = createMockGitHubAppClient({ repositories: [REPO] });
    const ref = await client.getRef(4242, 'cloudfuze', 'aisdlc-service', 'main');
    assert.ok(ref.ok);
    const base = await client.getCommit(4242, 'cloudfuze', 'aisdlc-service', ref.sha);
    assert.ok(base.ok);

    const tree = await client.createTree(4242, 'cloudfuze', 'aisdlc-service', base.treeSha, [
      { path: 'README.md', content: '# updated' },
      { path: 'src/new-file.ts', content: 'export {};' },
    ]);
    assert.ok(tree.ok);
    assert.notEqual(tree.sha, base.treeSha);
  });

  it('creates a commit referencing a known tree and parent', async () => {
    const client = createMockGitHubAppClient({ repositories: [REPO] });
    const ref = await client.getRef(4242, 'cloudfuze', 'aisdlc-service', 'main');
    assert.ok(ref.ok);
    const base = await client.getCommit(4242, 'cloudfuze', 'aisdlc-service', ref.sha);
    assert.ok(base.ok);
    const tree = await client.createTree(4242, 'cloudfuze', 'aisdlc-service', base.treeSha, [
      { path: 'README.md', content: '# updated' },
    ]);
    assert.ok(tree.ok);

    const commit = await client.createCommit(4242, 'cloudfuze', 'aisdlc-service', 'AISDLC: update README', tree.sha, [ref.sha]);
    assert.ok(commit.ok);
    assert.notEqual(commit.sha, ref.sha);
  });

  it('creates a new branch pointing at the given commit', async () => {
    const client = createMockGitHubAppClient({ repositories: [REPO] });
    const ref = await client.getRef(4242, 'cloudfuze', 'aisdlc-service', 'main');
    assert.ok(ref.ok);

    const created = await client.createBranch(4242, 'cloudfuze', 'aisdlc-service', 'aisdlc/run-1/exec-1', ref.sha);
    assert.deepEqual(created, { ok: true });

    const newRef = await client.getRef(4242, 'cloudfuze', 'aisdlc-service', 'aisdlc/run-1/exec-1');
    assert.ok(newRef.ok);
    assert.equal(newRef.sha, ref.sha);
  });

  it('refuses to create a branch that already exists', async () => {
    const client = createMockGitHubAppClient({ repositories: [REPO] });
    const created = await client.createBranch(4242, 'cloudfuze', 'aisdlc-service', 'main', 'irrelevant-sha');
    assert.equal(created.ok, false);
    assert.equal(created.ok === false && created.kind, 'ref_already_exists');
  });

  it('a full publish flow leaves the new branch content readable and the base branch untouched', async () => {
    const client = createMockGitHubAppClient({ repositories: [REPO] });
    const ref = await client.getRef(4242, 'cloudfuze', 'aisdlc-service', 'main');
    assert.ok(ref.ok);
    const base = await client.getCommit(4242, 'cloudfuze', 'aisdlc-service', ref.sha);
    assert.ok(base.ok);
    const tree = await client.createTree(4242, 'cloudfuze', 'aisdlc-service', base.treeSha, [
      { path: 'README.md', content: '# published' },
    ]);
    assert.ok(tree.ok);
    const commit = await client.createCommit(4242, 'cloudfuze', 'aisdlc-service', 'AISDLC: publish', tree.sha, [ref.sha]);
    assert.ok(commit.ok);
    const branch = await client.createBranch(4242, 'cloudfuze', 'aisdlc-service', 'aisdlc/run-2/exec-2', commit.sha);
    assert.ok(branch.ok);

    const published = await client.getFileContents(4242, 'cloudfuze', 'aisdlc-service', 'README.md', 'aisdlc/run-2/exec-2');
    assert.deepEqual(published, { ok: true, content: '# published' });

    // The base branch's own content is unaffected by the new branch's commit.
    const baseContent = await client.getFileContents(4242, 'cloudfuze', 'aisdlc-service', 'README.md', 'main');
    assert.deepEqual(baseContent, { ok: true, content: '# aisdlc-service' });
  });
});

describe('createPullRequest / findPullRequestForBranch (idempotent PR creation)', () => {
  it('creates a pull request and reports it as open', async () => {
    const client = createMockGitHubAppClient({ repositories: [REPO] });
    const pr = await client.createPullRequest(4242, 'cloudfuze', 'aisdlc-service', {
      title: 'AISDLC: update README',
      body: 'Approved via AISDLC.',
      head: 'aisdlc/run-1/exec-1',
      base: 'main',
    });
    assert.ok(pr.ok);
    assert.equal(pr.state, 'open');
    assert.match(pr.htmlUrl, /\/pull\/\d+$/);
  });

  it('refuses to open a second pull request for the same head/base pair', async () => {
    const client = createMockGitHubAppClient({ repositories: [REPO] });
    const input = { title: 't', body: 'b', head: 'aisdlc/run-1/exec-1', base: 'main' };
    await client.createPullRequest(4242, 'cloudfuze', 'aisdlc-service', input);
    const second = await client.createPullRequest(4242, 'cloudfuze', 'aisdlc-service', input);

    assert.equal(second.ok, false);
    assert.equal(second.ok === false && second.kind, 'pull_request_already_exists');
  });

  it('finds an already-open pull request for a head/base pair', async () => {
    const client = createMockGitHubAppClient({ repositories: [REPO] });
    const created = await client.createPullRequest(4242, 'cloudfuze', 'aisdlc-service', {
      title: 't',
      body: 'b',
      head: 'aisdlc/run-1/exec-1',
      base: 'main',
    });
    assert.ok(created.ok);

    const found = await client.findPullRequestForBranch(4242, 'cloudfuze', 'aisdlc-service', 'aisdlc/run-1/exec-1', 'main');
    assert.ok(found.ok);
    assert.deepEqual(found.pullRequest, { number: created.number, htmlUrl: created.htmlUrl, state: created.state });
  });

  it('returns null when no pull request exists for a head/base pair', async () => {
    const client = createMockGitHubAppClient({ repositories: [REPO] });
    const found = await client.findPullRequestForBranch(4242, 'cloudfuze', 'aisdlc-service', 'no-such-branch', 'main');
    assert.ok(found.ok);
    assert.equal(found.pullRequest, null);
  });
});

describe('getPullRequest (PR merge detection)', () => {
  it('reports an open, unmerged PR seeded declaratively', async () => {
    const repoWithPr: MockRepository = {
      ...REPO,
      pullRequests: [{ number: 7, head: 'aisdlc/run-1/exec-1', base: 'main', state: 'open' }],
    };
    const client = createMockGitHubAppClient({ repositories: [repoWithPr] });
    const result = await client.getPullRequest(4242, 'cloudfuze', 'aisdlc-service', 7);

    assert.ok(result.ok);
    assert.equal(result.state, 'open');
    assert.equal(result.merged, false);
    assert.equal(result.mergeCommitSha, null);
    assert.equal(result.headRef, 'aisdlc/run-1/exec-1');
    assert.equal(result.baseRef, 'main');
  });

  it('reports a merged PR, including the merge commit sha, without any merge capability existing', async () => {
    const repoWithPr: MockRepository = {
      ...REPO,
      pullRequests: [
        { number: 8, head: 'aisdlc/run-2/exec-2', base: 'main', state: 'closed', merged: true, mergeCommitSha: 'deadbeef' },
      ],
    };
    const client = createMockGitHubAppClient({ repositories: [repoWithPr] });
    const result = await client.getPullRequest(4242, 'cloudfuze', 'aisdlc-service', 8);

    assert.ok(result.ok);
    assert.equal(result.state, 'closed');
    assert.equal(result.merged, true);
    assert.equal(result.mergeCommitSha, 'deadbeef');
    // No method on this client can have caused the merge — see client.ts's module comment.
    assert.ok(!('mergePullRequest' in client));
  });

  it('reports a closed PR that was never merged, distinct from an open one', async () => {
    const repoWithPr: MockRepository = {
      ...REPO,
      pullRequests: [{ number: 9, head: 'aisdlc/run-3/exec-3', base: 'main', state: 'closed', merged: false }],
    };
    const client = createMockGitHubAppClient({ repositories: [repoWithPr] });
    const result = await client.getPullRequest(4242, 'cloudfuze', 'aisdlc-service', 9);

    assert.ok(result.ok);
    assert.equal(result.state, 'closed');
    assert.equal(result.merged, false);
    assert.equal(result.mergeCommitSha, null);
  });

  it('reflects a PR created via createPullRequest as open and unmerged', async () => {
    const client = createMockGitHubAppClient({ repositories: [REPO] });
    const created = await client.createPullRequest(4242, 'cloudfuze', 'aisdlc-service', {
      title: 't',
      body: 'b',
      head: 'aisdlc/run-4/exec-4',
      base: 'main',
    });
    assert.ok(created.ok);

    const result = await client.getPullRequest(4242, 'cloudfuze', 'aisdlc-service', created.number);
    assert.ok(result.ok);
    assert.equal(result.merged, false);
  });

  it('reports file_not_found for an unknown PR number', async () => {
    const client = createMockGitHubAppClient({ repositories: [REPO] });
    const result = await client.getPullRequest(4242, 'cloudfuze', 'aisdlc-service', 999);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'file_not_found');
  });

  it('reports installation_not_found when the installation id does not cover the repository', async () => {
    const repoWithPr: MockRepository = { ...REPO, pullRequests: [{ number: 7, head: 'x', base: 'main', state: 'open' }] };
    const client = createMockGitHubAppClient({ repositories: [repoWithPr] });
    const result = await client.getPullRequest(1, 'cloudfuze', 'aisdlc-service', 7);
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
