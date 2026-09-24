import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId } from 'mongodb';

import { createLogger } from '../logging/logger.ts';
import type { RepositoryRegistryDocument, RepositoryRegistryRepository } from '../repository-registry/repository.ts';
import type { RepositorySelectionDocument } from '../repository-selection/repository.ts';
import { authorizeRepositoryAccess, readRepositoryFile, type RepositoryAccessDeps } from './access.ts';
import { createMockGitHubAppClient, type MockRepository } from './mock-client.ts';

const NOW = new Date('2026-09-22T00:00:00.000Z');

function registryEntry(overrides: Partial<RepositoryRegistryDocument> = {}): RepositoryRegistryDocument {
  return {
    _id: new ObjectId(),
    projectIdentifier: 'CF',
    repositoryId: 'aisdlc-service',
    repositoryUrl: 'https://github.com/cloudfuze/aisdlc-service',
    defaultBranch: 'main',
    allowedBranches: ['main', 'feature/*'],
    status: 'active',
    accessPolicy: { installationId: 4242 },
    createdAt: NOW,
    updatedAt: NOW,
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
    nextAttemptAt: NOW,
    confirmedBy: 'operator:alice',
    confirmedAt: NOW,
    lastNotifiedStatus: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const MOCK_REPO: MockRepository = {
  owner: 'cloudfuze',
  repo: 'aisdlc-service',
  installationId: 4242,
  defaultBranch: 'main',
  branches: ['main', 'feature/login'],
  files: { 'README.md': '# aisdlc-service' },
};

interface Harness {
  readonly deps: RepositoryAccessDeps;
  readonly logs: string[];
  readonly registryCalls: number;
  readonly clientCalls: { method: string }[];
}

function harness(
  options: {
    registryEntries?: RepositoryRegistryDocument[];
    mockRepositories?: MockRepository[];
    tokenFailures?: Record<number, 'rate_limited' | 'transient' | 'insufficient_permission'>;
  } = {},
): Harness {
  const logs: string[] = [];
  const clientCalls: { method: string }[] = [];
  let registryCalls = 0;

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
      registryCalls += 1;
      return (options.registryEntries ?? [registryEntry()]).filter(
        (e) => e.projectIdentifier === projectIdentifier && e.status === 'active',
      );
    },
    async update() {
      throw new Error('must not be called');
    },
    async setStatus() {
      throw new Error('must not be called');
    },
  };

  const rawClient = createMockGitHubAppClient({
    repositories: options.mockRepositories ?? [MOCK_REPO],
    ...(options.tokenFailures === undefined ? {} : { tokenFailures: options.tokenFailures }),
  });
  const client: typeof rawClient = {
    resolveInstallation: (...args) => {
      clientCalls.push({ method: 'resolveInstallation' });
      return rawClient.resolveInstallation(...args);
    },
    getInstallationToken: (...args) => {
      clientCalls.push({ method: 'getInstallationToken' });
      return rawClient.getInstallationToken(...args);
    },
    getRepositoryMetadata: (...args) => {
      clientCalls.push({ method: 'getRepositoryMetadata' });
      return rawClient.getRepositoryMetadata(...args);
    },
    getFileContents: (...args) => {
      clientCalls.push({ method: 'getFileContents' });
      return rawClient.getFileContents(...args);
    },
    getRef: (...args) => {
      clientCalls.push({ method: 'getRef' });
      return rawClient.getRef(...args);
    },
    getCommit: (...args) => {
      clientCalls.push({ method: 'getCommit' });
      return rawClient.getCommit(...args);
    },
    createTree: (...args) => {
      clientCalls.push({ method: 'createTree' });
      return rawClient.createTree(...args);
    },
    createCommit: (...args) => {
      clientCalls.push({ method: 'createCommit' });
      return rawClient.createCommit(...args);
    },
    createBranch: (...args) => {
      clientCalls.push({ method: 'createBranch' });
      return rawClient.createBranch(...args);
    },
    createPullRequest: (...args) => {
      clientCalls.push({ method: 'createPullRequest' });
      return rawClient.createPullRequest(...args);
    },
    findPullRequestForBranch: (...args) => {
      clientCalls.push({ method: 'findPullRequestForBranch' });
      return rawClient.findPullRequestForBranch(...args);
    },
    getPullRequest: (...args) => {
      clientCalls.push({ method: 'getPullRequest' });
      return rawClient.getPullRequest(...args);
    },
  };

  return {
    deps: {
      registry,
      client,
      logger: createLogger({ level: 'debug', write: (line) => logs.push(line) }),
    },
    logs,
    get registryCalls() {
      return registryCalls;
    },
    clientCalls,
  };
}

describe('authorizeRepositoryAccess: successful mocked authentication', () => {
  it('authorizes a confirmed selection and returns a token, owner, repo and branch', async () => {
    const h = harness();
    const result = await authorizeRepositoryAccess(h.deps, selection());

    assert.ok(result.ok);
    assert.equal(result.installationId, 4242);
    assert.equal(result.owner, 'cloudfuze');
    assert.equal(result.repo, 'aisdlc-service');
    assert.equal(result.branch, 'main');
    assert.match(result.token, /^mock-token-/);
  });

  it('uses an explicitly requested branch when it is allowed', async () => {
    const h = harness();
    const result = await authorizeRepositoryAccess(h.deps, selection(), { branch: 'feature/login' });
    assert.ok(result.ok);
    assert.equal(result.branch, 'feature/login');
  });
});

describe('authorizeRepositoryAccess: selection not confirmed', () => {
  it('refuses a pending selection without calling the registry or the client', async () => {
    const h = harness();
    const result = await authorizeRepositoryAccess(h.deps, selection({ status: 'pending' }));

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'selection_not_confirmed');
    assert.equal(h.registryCalls, 0);
    assert.equal(h.clientCalls.length, 0);
  });
});

describe('authorizeRepositoryAccess: unsupported repository URL rejection', () => {
  it('refuses a non-GitHub-HTTPS snapshotted URL without calling the client', async () => {
    const h = harness();
    const result = await authorizeRepositoryAccess(
      h.deps,
      selection({ selectedRepositoryUrl: 'git@github.com:cloudfuze/aisdlc-service.git' }),
    );

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'unsupported_repository_url');
    assert.equal(h.clientCalls.length, 0);
  });

  it('refuses a null snapshotted URL', async () => {
    const h = harness();
    const result = await authorizeRepositoryAccess(h.deps, selection({ selectedRepositoryUrl: null }));
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'unsupported_repository_url');
  });
});

describe('authorizeRepositoryAccess: branch validation', () => {
  it('refuses a branch not covered by the confirmed allowed branches, without calling the client', async () => {
    const h = harness();
    const result = await authorizeRepositoryAccess(h.deps, selection(), { branch: 'staging' });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'branch_not_allowed');
    assert.equal(h.clientCalls.length, 0);
  });

  it('allows a branch covered only by a wildcard pattern', async () => {
    const h = harness();
    const result = await authorizeRepositoryAccess(
      h.deps,
      selection({ selectedAllowedBranches: ['feature/*'], selectedDefaultBranch: 'feature/login' }),
    );
    assert.ok(result.ok);
    assert.equal(result.branch, 'feature/login');
  });

  it('refuses when selectedDefaultBranch is null and no branch was explicitly requested', async () => {
    const h = harness();
    const result = await authorizeRepositoryAccess(h.deps, selection({ selectedDefaultBranch: null }));
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'branch_not_allowed');
  });
});

describe('authorizeRepositoryAccess: inactive repository rejection', () => {
  it('refuses when the live registry no longer has an active entry for this repositoryId', async () => {
    const h = harness({ registryEntries: [registryEntry({ status: 'inactive' })] });
    const result = await authorizeRepositoryAccess(h.deps, selection());

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'repository_inactive');
    assert.equal(h.clientCalls.length, 0, 'must not call the client for a repository no longer active');
  });

  it('refuses when the registry entry for this repositoryId no longer exists at all', async () => {
    const h = harness({ registryEntries: [] });
    const result = await authorizeRepositoryAccess(h.deps, selection());
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'repository_inactive');
  });
});

describe('authorizeRepositoryAccess: invalid installation configuration', () => {
  it('refuses when accessPolicy is null', async () => {
    const h = harness({ registryEntries: [registryEntry({ accessPolicy: null })] });
    const result = await authorizeRepositoryAccess(h.deps, selection());

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'invalid_installation_configuration');
    assert.equal(h.clientCalls.length, 0);
  });

  it('refuses when accessPolicy.installationId is not a positive integer', async () => {
    const h = harness({ registryEntries: [registryEntry({ accessPolicy: { installationId: -1 } })] });
    const result = await authorizeRepositoryAccess(h.deps, selection());
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'invalid_installation_configuration');
  });

  it('refuses when accessPolicy.installationId is the wrong type', async () => {
    const h = harness({ registryEntries: [registryEntry({ accessPolicy: { installationId: '4242' } })] });
    const result = await authorizeRepositoryAccess(h.deps, selection());
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'invalid_installation_configuration');
  });
});

describe('readRepositoryFile: unauthorized repository access', () => {
  it('propagates insufficient_permission from the client', async () => {
    const unreadable: MockRepository = { ...MOCK_REPO, readable: false };
    const h = harness({ mockRepositories: [unreadable] });

    const result = await readRepositoryFile(h.deps, selection(), 'README.md');

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'insufficient_permission');
  });
});

describe('readRepositoryFile: missing repository files', () => {
  it('propagates file_not_found from the client', async () => {
    const h = harness();
    const result = await readRepositoryFile(h.deps, selection(), 'does-not-exist.md');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'file_not_found');
  });

  it('reads an existing file successfully', async () => {
    const h = harness();
    const result = await readRepositoryFile(h.deps, selection(), 'README.md');
    assert.deepEqual(result, { ok: true, content: '# aisdlc-service' });
  });
});

describe('retryable versus non-retryable errors, propagated from the client', () => {
  it('propagates a retryable rate_limited failure from getInstallationToken', async () => {
    const h = harness({ tokenFailures: { 4242: 'rate_limited' } });
    const result = await authorizeRepositoryAccess(h.deps, selection());
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'rate_limited');
  });

  it('propagates a retryable transient failure from getInstallationToken', async () => {
    const h = harness({ tokenFailures: { 4242: 'transient' } });
    const result = await authorizeRepositoryAccess(h.deps, selection());
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'transient');
  });

  it('propagates a non-retryable insufficient_permission failure from getInstallationToken', async () => {
    const h = harness({ tokenFailures: { 4242: 'insufficient_permission' } });
    const result = await authorizeRepositoryAccess(h.deps, selection());
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'insufficient_permission');
  });
});

describe('secret-safe logging', () => {
  it('never logs the issued token, even on a full successful authorize-and-read flow', async () => {
    const h = harness();
    const result = await readRepositoryFile(h.deps, selection(), 'README.md');
    assert.ok(result.ok);

    const authorized = await authorizeRepositoryAccess(h.deps, selection());
    assert.ok(authorized.ok);

    const joined = h.logs.join('\n');
    assert.ok(!joined.includes(authorized.token), 'the installation token leaked into a log line');
    // Non-secret fields are expected to appear — proves this isn't a
    // blanket redaction that would also hide useful operational detail.
    assert.ok(joined.includes('4242'), 'the non-secret installationId should still be logged');
  });

  it('never logs a token for a failed authorization, because no token was ever issued', async () => {
    const h = harness({ registryEntries: [registryEntry({ status: 'inactive' })] });
    await authorizeRepositoryAccess(h.deps, selection());

    const joined = h.logs.join('\n');
    assert.ok(!/mock-token-/.test(joined), 'no token should exist to log for a refused authorization');
  });
});
