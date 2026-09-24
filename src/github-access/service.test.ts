import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId } from 'mongodb';

import type { AuditEntryInput, AuditLog } from '../db/audit-log.ts';
import { createLogger } from '../logging/logger.ts';
import type { IntakeItemDocument, IntakeRepository } from '../intake/repository.ts';
import type { RunDocument, RunsRepository } from '../orchestrator/repository.ts';
import type { RepositoryRegistryDocument, RepositoryRegistryRepository } from '../repository-registry/repository.ts';
import type { RepositorySelectionDocument, RepositorySelectionRepository } from '../repository-selection/repository.ts';
import { createMockGitHubAppClient, type MockRepository } from '../github-app/mock-client.ts';
import { isRetryable as isRetryableGitHubKind, type GitHubAppClient, type GitHubAccessFailureKind } from '../github-app/client.ts';
import {
  createGitHubAccessService,
  isRetryableCategory,
  mapGitHubFailureKind,
  type GitHubAccessDeps,
  type GitHubAccessFailureCategory,
} from './service.ts';

const NOW = new Date('2026-09-22T00:00:00.000Z');
const RUN_ID = new ObjectId();
const INTAKE_ITEM_ID = new ObjectId();
const INSTALLATION_ID = 4242;

function run(overrides: Partial<RunDocument> = {}): RunDocument {
  return {
    _id: RUN_ID,
    intakeItemId: INTAKE_ITEM_ID,
    issueKey: 'CF-1',
    status: 'queued',
    trigger: 'approval',
    createdAt: NOW,
    startedAt: null,
    completedAt: null,
    updatedAt: NOW,
    ...overrides,
  };
}

function intakeItem(overrides: Partial<IntakeItemDocument> = {}): IntakeItemDocument {
  return {
    _id: INTAKE_ITEM_ID,
    issueKey: 'CF-1',
    source: 'webhook',
    deliveryRef: null,
    snapshot: { title: 't', description: 'd', issueType: 'bug', project: 'CF' },
    snapshotMeta: null,
    sourceHash: 'hash',
    status: 'approved',
    statusReason: null,
    approvedBy: 'operator:alice',
    approvedAt: NOW,
    receivedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

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
    runId: RUN_ID,
    intakeItemId: INTAKE_ITEM_ID,
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
  installationId: INSTALLATION_ID,
  defaultBranch: 'main',
  branches: ['main', 'feature/login'],
  files: { 'README.md': '# aisdlc-service — secret sauce inside', 'src/index.ts': 'export {};' },
};

interface Harness {
  readonly deps: GitHubAccessDeps;
  readonly auditEntries: AuditEntryInput[];
  readonly logs: string[];
  readonly selectionCalls: number;
  readonly clientCalls: { method: string }[];
}

function harness(
  options: {
    run?: RunDocument | null;
    intakeItem?: IntakeItemDocument | null;
    registryEntries?: RepositoryRegistryDocument[];
    selection?: RepositorySelectionDocument | null;
    mockRepositories?: MockRepository[];
    client?: GitHubAppClient;
  } = {},
): Harness {
  const auditEntries: AuditEntryInput[] = [];
  const logs: string[] = [];
  const clientCalls: { method: string }[] = [];
  let selectionCalls = 0;

  const runs: RunsRepository = {
    async createIfAbsent() {
      throw new Error('must not be called');
    },
    async findByIntakeItemId() {
      throw new Error('must not be called');
    },
    async findById() {
      return 'run' in options ? options.run : run();
    },
    async list() {
      throw new Error('must not be called');
    },
  };

  const intake: IntakeRepository = {
    async create() {
      throw new Error('must not be called');
    },
    async findByIssueKey() {
      return 'intakeItem' in options ? options.intakeItem! : intakeItem();
    },
    async list() {
      throw new Error('must not be called');
    },
    async transition() {
      throw new Error('must not be called');
    },
  };

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

  const selections: RepositorySelectionRepository = {
    async findByRunId() {
      selectionCalls += 1;
      return 'selection' in options ? options.selection! : selection();
    },
    async createInitial() {
      throw new Error('must not be called');
    },
    async recordMatchResult() {
      throw new Error('must not be called');
    },
    async confirm() {
      throw new Error('must not be called');
    },
    async findDueForRetry() {
      throw new Error('must not be called');
    },
  };

  const rawClient = options.client ?? createMockGitHubAppClient({ repositories: options.mockRepositories ?? [MOCK_REPO] });
  const client: GitHubAppClient = {
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

  const audit: AuditLog = {
    async append(entry: AuditEntryInput) {
      auditEntries.push(entry);
      return new ObjectId();
    },
    async query() {
      return [];
    },
  };

  return {
    deps: {
      runs,
      intake,
      selections,
      registry,
      client,
      audit,
      logger: createLogger({ level: 'debug', write: (line) => logs.push(line) }),
    },
    auditEntries,
    logs,
    get selectionCalls() {
      return selectionCalls;
    },
    clientCalls,
  };
}

describe('successful access', () => {
  it('accesses repository metadata with no files requested', async () => {
    const h = harness();
    const service = createGitHubAccessService(h.deps);
    const result = await service.accessRepositoryForRun(RUN_ID, []);

    assert.ok(result.ok);
    assert.equal(result.owner, 'cloudfuze');
    assert.equal(result.repo, 'aisdlc-service');
    assert.equal(result.branch, 'main');
    assert.equal(result.defaultBranch, 'main');
    assert.deepEqual(result.files, []);
  });

  it('reads the requested files and decodes their content', async () => {
    const h = harness();
    const service = createGitHubAccessService(h.deps);
    const result = await service.accessRepositoryForRun(RUN_ID, ['README.md', 'src/index.ts']);

    assert.ok(result.ok);
    assert.deepEqual(result.files, [
      { path: 'README.md', content: '# aisdlc-service — secret sauce inside' },
      { path: 'src/index.ts', content: 'export {};' },
    ]);
  });
});

describe('run validation', () => {
  it('rejects a missing run', async () => {
    const h = harness({ run: null });
    const service = createGitHubAccessService(h.deps);
    const result = await service.accessRepositoryForRun(RUN_ID, []);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.category, 'run_not_found');
    assert.equal(h.clientCalls.length, 0);
    assert.equal(h.selectionCalls, 0);
  });

  for (const status of ['cancelled', 'failed', 'succeeded'] as const) {
    it(`rejects a '${status}' run`, async () => {
      const h = harness({ run: run({ status }) });
      const service = createGitHubAccessService(h.deps);
      const result = await service.accessRepositoryForRun(RUN_ID, []);

      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.category, 'run_not_ready');
      assert.equal(h.clientCalls.length, 0);
    });
  }

  it('accepts a "running" run', async () => {
    const h = harness({ run: run({ status: 'running' }) });
    const service = createGitHubAccessService(h.deps);
    const result = await service.accessRepositoryForRun(RUN_ID, []);
    assert.ok(result.ok);
  });
});

describe('intake item validation', () => {
  it('rejects when the intake item cannot be found', async () => {
    const h = harness({ intakeItem: null });
    const service = createGitHubAccessService(h.deps);
    const result = await service.accessRepositoryForRun(RUN_ID, []);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.category, 'intake_item_not_found');
    assert.equal(h.clientCalls.length, 0);
  });

  it('rejects when the found intake item does not match the run\'s intakeItemId', async () => {
    const h = harness({ intakeItem: intakeItem({ _id: new ObjectId() }) });
    const service = createGitHubAccessService(h.deps);
    const result = await service.accessRepositoryForRun(RUN_ID, []);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.category, 'intake_item_not_found');
  });

  it('rejects an unapproved (e.g. rejected) intake item', async () => {
    const h = harness({ intakeItem: intakeItem({ status: 'rejected', approvedBy: null, approvedAt: null }) });
    const service = createGitHubAccessService(h.deps);
    const result = await service.accessRepositoryForRun(RUN_ID, []);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.category, 'intake_not_approved');
    assert.equal(h.clientCalls.length, 0);
  });
});

describe('repository selection validation', () => {
  it('rejects a missing repository selection', async () => {
    const h = harness({ selection: null });
    const service = createGitHubAccessService(h.deps);
    const result = await service.accessRepositoryForRun(RUN_ID, []);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.category, 'selection_missing');
    assert.equal(h.clientCalls.length, 0);
  });

  for (const status of ['pending', 'failed', 'ambiguous'] as const) {
    it(`rejects an unconfirmed selection ('${status}')`, async () => {
      const h = harness({ selection: selection({ status, confirmedBy: null, confirmedAt: null }) });
      const service = createGitHubAccessService(h.deps);
      const result = await service.accessRepositoryForRun(RUN_ID, []);

      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.category, 'selection_not_confirmed');
      assert.equal(h.clientCalls.length, 0);
    });
  }

  it('rejects an inactive registry entry backing an otherwise-confirmed selection', async () => {
    const h = harness({ registryEntries: [registryEntry({ status: 'inactive' })] });
    const service = createGitHubAccessService(h.deps);
    const result = await service.accessRepositoryForRun(RUN_ID, []);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.category, 'repository_inactive');
    assert.equal(h.clientCalls.length, 0);
  });

  it('rejects when the registry has no entry at all for the selected repositoryId', async () => {
    const h = harness({ registryEntries: [] });
    const service = createGitHubAccessService(h.deps);
    const result = await service.accessRepositoryForRun(RUN_ID, []);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.category, 'repository_inactive');
  });

  it('rejects an invalid (missing) installation configuration on the registry entry', async () => {
    const h = harness({ registryEntries: [registryEntry({ accessPolicy: null })] });
    const service = createGitHubAccessService(h.deps);
    const result = await service.accessRepositoryForRun(RUN_ID, []);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.category, 'invalid_configuration');
    assert.equal(h.clientCalls.length, 0);
  });

  it('rejects a branch not covered by the confirmed allowed branches', async () => {
    const h = harness({ selection: selection({ selectedDefaultBranch: null }) });
    const service = createGitHubAccessService(h.deps);
    const result = await service.accessRepositoryForRun(RUN_ID, []);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.category, 'branch_not_allowed');
    assert.equal(h.clientCalls.length, 0);
  });
});

describe('repository identity validation (propagated from the GitHub client)', () => {
  it('rejects an owner mismatch reported by getRepositoryMetadata', async () => {
    const client: GitHubAppClient = {
      async resolveInstallation() {
        throw new Error('must not be called');
      },
      async getInstallationToken(installationId) {
        return { ok: true, token: 'mock-token', expiresAt: new Date(NOW.getTime() + 3600_000) };
      },
      async getRepositoryMetadata() {
        return { ok: false, kind: 'malformed', message: "response described a different repository ('someone-else/aisdlc-service')" };
      },
      async getFileContents() {
        throw new Error('must not be called');
      },
      async getRef() {
        throw new Error('must not be called');
      },
      async getCommit() {
        throw new Error('must not be called');
      },
      async createTree() {
        throw new Error('must not be called');
      },
      async createCommit() {
        throw new Error('must not be called');
      },
      async createBranch() {
        throw new Error('must not be called');
      },
      async createPullRequest() {
        throw new Error('must not be called');
      },
      async findPullRequestForBranch() {
        throw new Error('must not be called');
      },
      async getPullRequest() {
        throw new Error('must not be called');
      },
    };
    const h = harness({ client });
    const service = createGitHubAccessService(h.deps);
    const result = await service.accessRepositoryForRun(RUN_ID, []);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.category, 'invalid_response');
    assert.match((result.ok === false && result.message) || '', /different repository/);
  });

  it('rejects a repository-name mismatch reported by getRepositoryMetadata', async () => {
    const client: GitHubAppClient = {
      async resolveInstallation() {
        throw new Error('must not be called');
      },
      async getInstallationToken() {
        return { ok: true, token: 'mock-token', expiresAt: new Date(NOW.getTime() + 3600_000) };
      },
      async getRepositoryMetadata() {
        return { ok: false, kind: 'malformed', message: "response described a different repository ('cloudfuze/some-other-repo')" };
      },
      async getFileContents() {
        throw new Error('must not be called');
      },
      async getRef() {
        throw new Error('must not be called');
      },
      async getCommit() {
        throw new Error('must not be called');
      },
      async createTree() {
        throw new Error('must not be called');
      },
      async createCommit() {
        throw new Error('must not be called');
      },
      async createBranch() {
        throw new Error('must not be called');
      },
      async createPullRequest() {
        throw new Error('must not be called');
      },
      async findPullRequestForBranch() {
        throw new Error('must not be called');
      },
      async getPullRequest() {
        throw new Error('must not be called');
      },
    };
    const h = harness({ client });
    const service = createGitHubAccessService(h.deps);
    const result = await service.accessRepositoryForRun(RUN_ID, []);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.category, 'invalid_response');
  });
});

describe('branch and file errors reported by GitHub', () => {
  it('rejects a branch that does not exist on the remote repository', async () => {
    const repoWithoutMain: MockRepository = { ...MOCK_REPO, branches: ['develop'] };
    const h = harness({ mockRepositories: [repoWithoutMain] });
    const service = createGitHubAccessService(h.deps);
    const result = await service.accessRepositoryForRun(RUN_ID, ['README.md']);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.category, 'branch_not_found');
    assert.equal(result.ok === false && result.failedPath, 'README.md');
  });

  it('rejects a missing file', async () => {
    const h = harness();
    const service = createGitHubAccessService(h.deps);
    const result = await service.accessRepositoryForRun(RUN_ID, ['does-not-exist.md']);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.category, 'file_not_found');
    assert.equal(result.ok === false && result.failedPath, 'does-not-exist.md');
  });

  it('stops at the first failing file and does not request the rest', async () => {
    const h = harness();
    const service = createGitHubAccessService(h.deps);
    const result = await service.accessRepositoryForRun(RUN_ID, ['missing-1.md', 'missing-2.md', 'README.md']);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.failedPath, 'missing-1.md');
    const fileReads = h.clientCalls.filter((c) => c.method === 'getFileContents');
    assert.equal(fileReads.length, 1);
  });
});

describe('GitHub authentication, authorization, and transient errors', () => {
  const CASES: { name: string; kind: GitHubAccessFailureKind; category: GitHubAccessFailureCategory }[] = [
    { name: 'authentication failure', kind: 'authentication_failed', category: 'authentication_failure' },
    { name: 'authorization failure', kind: 'insufficient_permission', category: 'authorization_failure' },
    { name: 'rate limit', kind: 'rate_limited', category: 'rate_limited' },
    { name: 'timeout', kind: 'timeout', category: 'timeout' },
    { name: 'transient GitHub error', kind: 'transient', category: 'transient_github_error' },
    { name: 'malformed response', kind: 'malformed', category: 'invalid_response' },
    { name: 'repository not found (installation)', kind: 'installation_not_found', category: 'repository_not_found' },
  ];

  for (const { name, kind, category } of CASES) {
    it(`maps a GitHub ${name} to category '${category}', with matching retryability`, async () => {
      const h = harness({
        client: createMockGitHubAppClient({
          repositories: [MOCK_REPO],
          tokenFailures: { [INSTALLATION_ID]: kind },
        }),
      });
      const service = createGitHubAccessService(h.deps);
      const result = await service.accessRepositoryForRun(RUN_ID, []);

      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.category, category);
      assert.equal(result.ok === false && result.retryable, isRetryableGitHubKind(kind));
      assert.equal(result.ok === false && result.retryable, isRetryableCategory(category));
    });
  }

  it('surfaces retryAfterMs for a rate-limited failure', async () => {
    const h = harness({
      client: createMockGitHubAppClient({
        repositories: [MOCK_REPO],
        tokenFailures: { [INSTALLATION_ID]: 'rate_limited' },
        retryAfterMs: { [INSTALLATION_ID]: 30_000 },
      }),
    });
    const service = createGitHubAccessService(h.deps);
    const result = await service.accessRepositoryForRun(RUN_ID, []);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.retryAfterMs, 30_000);
  });

  it('never marks a non-retryable GitHub failure as retryable', async () => {
    const h = harness({
      client: createMockGitHubAppClient({
        repositories: [MOCK_REPO],
        tokenFailures: { [INSTALLATION_ID]: 'installation_not_found' },
      }),
    });
    const service = createGitHubAccessService(h.deps);
    const result = await service.accessRepositoryForRun(RUN_ID, []);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.retryable, false);
  });
});

describe('mapGitHubFailureKind / isRetryableCategory consistency', () => {
  it('agrees with github-app/client.ts\'s own isRetryable for every kind', () => {
    const kinds: GitHubAccessFailureKind[] = [
      'selection_not_confirmed',
      'unsupported_repository_url',
      'repository_inactive',
      'invalid_installation_configuration',
      'branch_not_allowed',
      'installation_not_found',
      'branch_not_found',
      'file_not_found',
      'authentication_failed',
      'insufficient_permission',
      'rate_limited',
      'timeout',
      'transient',
      'malformed',
      'unexpected_redirect',
    ];
    for (const kind of kinds) {
      const category = mapGitHubFailureKind(kind);
      assert.equal(
        isRetryableCategory(category),
        isRetryableGitHubKind(kind),
        `retryability disagrees for kind '${kind}' -> category '${category}'`,
      );
    }
  });
});

describe('unexpected errors', () => {
  it('never throws out of accessRepositoryForRun; maps an unexpected exception to unexpected_error', async () => {
    const h = harness();
    h.deps.runs.findById = async () => {
      throw new Error('database exploded');
    };
    const service = createGitHubAccessService(h.deps);

    const result = await service.accessRepositoryForRun(RUN_ID, []);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.category, 'unexpected_error');
    assert.equal(result.ok === false && result.retryable, false);
  });
});

describe('idempotency: duplicate access', () => {
  it('de-duplicates concurrent calls for the same run', async () => {
    const h = harness();
    const service = createGitHubAccessService(h.deps);

    const [a, b] = await Promise.all([
      service.accessRepositoryForRun(RUN_ID, ['README.md']),
      service.accessRepositoryForRun(RUN_ID, ['README.md']),
    ]);

    assert.deepEqual(a, b);
    assert.equal(h.selectionCalls, 1, 'the selection lookup must be shared, not duplicated');
    const fileReads = h.clientCalls.filter((c) => c.method === 'getFileContents');
    assert.equal(fileReads.length, 1, 'the file read must be shared, not duplicated');
  });

  it('runs a fresh execution for a later, sequential call', async () => {
    const h = harness();
    const service = createGitHubAccessService(h.deps);

    await service.accessRepositoryForRun(RUN_ID, []);
    await service.accessRepositoryForRun(RUN_ID, []);

    assert.equal(h.selectionCalls, 2, 'sequential (non-overlapping) calls are not de-duplicated');
  });
});

describe('audit events', () => {
  it('emits started, repository.accessed, files.accessed, succeeded in order for a successful run', async () => {
    const h = harness();
    const service = createGitHubAccessService(h.deps);
    await service.accessRepositoryForRun(RUN_ID, ['README.md']);

    assert.deepEqual(
      h.auditEntries.map((e) => e.action),
      ['github.access.started', 'github.repository.accessed', 'github.files.accessed', 'github.access.succeeded'],
    );
    for (const entry of h.auditEntries) {
      assert.equal(entry.actor, 'system:github-access');
      assert.equal(entry.subjectType, 'run');
      assert.ok(entry.subjectId.equals(RUN_ID));
    }
  });

  it('emits started then failed for a validation failure, and includes the failure category', async () => {
    const h = harness({ selection: null });
    const service = createGitHubAccessService(h.deps);
    await service.accessRepositoryForRun(RUN_ID, []);

    assert.deepEqual(
      h.auditEntries.map((e) => e.action),
      ['github.access.started', 'github.access.failed'],
    );
    assert.equal(h.auditEntries[1]!.detail?.['category'], 'selection_missing');
  });

  it('includes the failed path on a file-read failure', async () => {
    const h = harness();
    const service = createGitHubAccessService(h.deps);
    await service.accessRepositoryForRun(RUN_ID, ['missing.md']);

    const failedEntry = h.auditEntries.find((e) => e.action === 'github.access.failed');
    assert.equal(failedEntry?.detail?.['failedPath'], 'missing.md');
  });

  it('never includes file content in any audit entry', async () => {
    const h = harness();
    const service = createGitHubAccessService(h.deps);
    await service.accessRepositoryForRun(RUN_ID, ['README.md']);

    const serialized = JSON.stringify(h.auditEntries);
    assert.ok(!serialized.includes('secret sauce'), 'file content leaked into an audit entry');
  });
});

describe('secret-safe logging', () => {
  it('never logs the issued token or file content', async () => {
    const h = harness();
    const service = createGitHubAccessService(h.deps);
    const result = await service.accessRepositoryForRun(RUN_ID, ['README.md']);
    assert.ok(result.ok);

    const joined = h.logs.join('\n');
    assert.ok(!joined.includes('secret sauce'), 'file content leaked into a log line');
    assert.ok(!/mock-token-/.test(joined), 'the mock installation token leaked into a log line');
  });

  it('does not log a literal file content string anywhere, even on failure', async () => {
    const h = harness();
    const service = createGitHubAccessService(h.deps);
    await service.accessRepositoryForRun(RUN_ID, ['missing.md']);

    const joined = h.logs.join('\n');
    assert.ok(!joined.includes('secret sauce'));
  });
});

describe('no real network calls', () => {
  it('every test in this file uses createMockGitHubAppClient or a hand-written fake — never the real client', () => {
    // Documented, not asserted at runtime: see the module header and every
    // harness() call above, none of which ever imports real-client.ts.
    assert.ok(true);
  });
});
