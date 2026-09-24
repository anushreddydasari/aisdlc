/**
 * Every test here uses in-memory fakes: no real MongoDB, no real GitHub
 * App. `RepositoryRegistryRepository` and `RepositorySelectionRepository`
 * are faked directly (this service calls `authorizeRepositoryAccess`
 * itself, which needs both) using `createMockGitHubAppClient` — the same
 * stateful, realistic mock `mock-client.test.ts` already exercises — as
 * the underlying `GitHubAppClient`, with specific methods overridden per
 * test to inject the failure/timeout/staleness scenarios a purely
 * declarative mock cannot express on its own.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId } from 'mongodb';

import type { AuditEntryInput, AuditLog } from '../db/audit-log.ts';
import { createLogger } from '../logging/logger.ts';
import { hashFileContent } from '../coding-agent/changes.ts';
import type { ChangeExecutionDocument, ChangeExecutionRepository, RecordExecutionInput } from '../change-execution/execution-repository.ts';
import type { ChangeReviewDocument, ChangeReviewRepository } from '../change-execution/review-repository.ts';
import type { ImplementationPlan, ProposedChange } from '../change-execution/types.ts';
import { createMockGitHubAppClient, type MockRepository } from '../github-app/mock-client.ts';
import type { GitHubAppClient } from '../github-app/client.ts';
import type { RepositoryRegistryDocument, RepositoryRegistryRepository } from '../repository-registry/repository.ts';
import type { RepositorySelectionDocument, RepositorySelectionRepository } from '../repository-selection/repository.ts';
import { createGithubPublishService, type PublishDeps } from './publish-service.ts';
import type { GithubPublicationDocument, GithubPublicationRepository, RecordPublicationInput } from './publish-repository.ts';

const NOW = new Date('2026-09-22T12:00:00.000Z');
const RUN_ID = new ObjectId();
const INTAKE_ITEM_ID = new ObjectId();
const REVIEW_ID = new ObjectId();
const EXECUTION_ID = new ObjectId();
const INSTALLATION_ID = 4242;

const ORIGINAL_CONTENT = 'export const original = true;';
const ORIGINAL_HASH = hashFileContent(ORIGINAL_CONTENT);

const PLAN: ImplementationPlan = {
  summary: 'Add a health field',
  requirementsUnderstanding: 'u',
  relevantFiles: ['src/index.ts'],
  items: [{ id: 'item-1', filePath: 'src/index.ts', operation: 'modify', changeDescription: 'd' }],
  dependenciesAndImpact: [],
  testsRequired: [],
  assumptions: [],
  risks: [],
};

const MODIFY_CHANGE: ProposedChange = {
  filePath: 'src/index.ts',
  operation: 'modify',
  originalContentHash: ORIGINAL_HASH,
  proposedContent: 'export const updated = true;',
  reason: 'r',
  relatedPlanItemId: 'item-1',
};

const PROPOSAL_HASH = 'a'.repeat(64);

const MOCK_REPO: MockRepository = {
  owner: 'cloudfuze',
  repo: 'aisdlc-service',
  installationId: INSTALLATION_ID,
  defaultBranch: 'main',
  branches: ['main'],
  files: { 'src/index.ts': ORIGINAL_CONTENT },
};

function review(overrides: Partial<ChangeReviewDocument> = {}): ChangeReviewDocument {
  return {
    _id: REVIEW_ID,
    runId: RUN_ID,
    intakeItemId: INTAKE_ITEM_ID,
    repositoryId: 'aisdlc-service',
    owner: 'cloudfuze',
    repo: 'aisdlc-service',
    branch: 'main',
    plan: PLAN,
    proposedChanges: [MODIFY_CHANGE],
    proposalHash: PROPOSAL_HASH,
    status: 'approved',
    reviewedBy: 'operator:alice',
    reviewedAt: NOW,
    reviewComment: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function execution(overrides: Partial<ChangeExecutionDocument> = {}): ChangeExecutionDocument {
  return {
    _id: EXECUTION_ID,
    runId: RUN_ID,
    reviewId: REVIEW_ID,
    proposalHash: PROPOSAL_HASH,
    status: 'succeeded',
    appliedChanges: [{ path: 'src/index.ts', operation: 'modify' }],
    validation: {
      tests: { ok: true, summary: 'mock: tests passed' },
      typecheck: { ok: true, summary: 'mock: typecheck passed' },
      build: { ok: true, summary: 'mock: build passed' },
    },
    failureCategory: null,
    failureMessage: null,
    createdAt: NOW,
    completedAt: NOW,
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
    allowedBranches: ['main'],
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
    selectedAllowedBranches: ['main'],
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

function fakeReviewRepository(reviews: ChangeReviewDocument[]): ChangeReviewRepository {
  return {
    async createIfAbsent() {
      throw new Error('must not be called');
    },
    async findById(id) {
      return reviews.find((r) => r._id!.equals(id)) ?? null;
    },
    async findLatestByRunId(runId) {
      const matches = reviews.filter((r) => r.runId.equals(runId));
      if (matches.length === 0) return null;
      return matches.reduce((latest, r) => (r.createdAt.getTime() > latest.createdAt.getTime() ? r : latest));
    },
    async approve() {
      throw new Error('must not be called');
    },
    async reject() {
      throw new Error('must not be called');
    },
    async findApproved() {
      throw new Error('must not be called');
    },
  };
}

function fakeExecutionRepository(executions: ChangeExecutionDocument[]): ChangeExecutionRepository {
  return {
    async createIfAbsent(_input: RecordExecutionInput): Promise<never> {
      throw new Error('must not be called');
    },
    async findByReviewId(reviewId) {
      return executions.find((e) => e.reviewId.equals(reviewId)) ?? null;
    },
    async findById(id) {
      return executions.find((e) => e._id!.equals(id)) ?? null;
    },
    async findSucceeded() {
      throw new Error('must not be called');
    },
  };
}

function fakeRegistryRepository(entries: RepositoryRegistryDocument[]): RepositoryRegistryRepository {
  return {
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
      return entries.filter((e) => e.projectIdentifier === projectIdentifier && e.status === 'active');
    },
    async update() {
      throw new Error('must not be called');
    },
    async setStatus() {
      throw new Error('must not be called');
    },
  };
}

function fakeSelectionRepository(sel: RepositorySelectionDocument | null): RepositorySelectionRepository {
  return {
    async findByRunId() {
      return sel;
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
}

/** Mirrors publish-repository.ts's own idempotent createIfAbsent + audit emission — see execution-service.test.ts's fakeExecutionRepository for why this matters for the audit-sequence assertions. */
function fakePublicationRepository(audit: AuditLog): { repo: GithubPublicationRepository; store: GithubPublicationDocument[] } {
  const store: GithubPublicationDocument[] = [];
  const repo: GithubPublicationRepository = {
    async createIfAbsent(input: RecordPublicationInput) {
      const existing = store.find((p) => p.executionId.equals(input.executionId));
      if (existing !== undefined) return { publication: existing, created: false };
      const document: GithubPublicationDocument = {
        _id: new ObjectId(),
        runId: input.runId,
        reviewId: input.reviewId,
        executionId: input.executionId,
        owner: input.owner,
        repo: input.repo,
        baseBranch: input.baseBranch,
        branch: input.branch,
        baseSha: input.baseSha,
        commitSha: input.commitSha,
        status: input.status,
        pullRequestNumber: input.pullRequestNumber,
        pullRequestUrl: input.pullRequestUrl,
        failureCategory: input.failureCategory,
        failureMessage: input.failureMessage,
        createdAt: new Date(),
        completedAt: new Date(),
      };
      store.push(document);
      await audit.append({
        actor: 'system:github-publish',
        action: input.status === 'published' ? 'github.write.completed' : 'github.write.failed',
        subjectType: 'githubPublication',
        subjectId: document._id!,
        detail: { runId: input.runId.toHexString(), executionId: input.executionId.toHexString(), status: input.status },
      });
      return { publication: document, created: true };
    },
    async findByExecutionId(executionId) {
      return store.find((p) => p.executionId.equals(executionId)) ?? null;
    },
    async findPublished() {
      throw new Error('not used');
    },
  };
  return { repo, store };
}

interface Harness {
  readonly deps: PublishDeps;
  readonly auditEntries: AuditEntryInput[];
  readonly publicationStore: GithubPublicationDocument[];
  readonly client: GitHubAppClient;
}

function harness(
  options: {
    reviews?: ChangeReviewDocument[];
    executions?: ChangeExecutionDocument[];
    registryEntries?: RepositoryRegistryDocument[];
    selection?: RepositorySelectionDocument | null;
    mockRepositories?: MockRepository[];
    clientOverrides?: Partial<GitHubAppClient>;
  } = {},
): Harness {
  const auditEntries: AuditEntryInput[] = [];
  const audit: AuditLog = {
    async append(entry: AuditEntryInput) {
      auditEntries.push(entry);
      return new ObjectId();
    },
    async query() {
      return [];
    },
  };

  const baseClient = createMockGitHubAppClient({ repositories: options.mockRepositories ?? [MOCK_REPO] });
  const client: GitHubAppClient = { ...baseClient, ...(options.clientOverrides ?? {}) };

  const { repo: publications, store: publicationStore } = fakePublicationRepository(audit);

  return {
    deps: {
      reviews: fakeReviewRepository(options.reviews ?? [review()]),
      executions: fakeExecutionRepository(options.executions ?? [execution()]),
      selections: fakeSelectionRepository('selection' in options ? options.selection! : selection()),
      registry: fakeRegistryRepository(options.registryEntries ?? [registryEntry()]),
      client,
      publications,
      audit,
      logger: createLogger({ write: () => {} }),
    },
    auditEntries,
    publicationStore,
    client,
  };
}

describe('successful publish', () => {
  it('creates a branch, a commit, and a pull request', async () => {
    const h = harness();
    const service = createGithubPublishService(h.deps);
    const result = await service.publishApprovedChanges(RUN_ID, EXECUTION_ID);

    assert.ok(result.ok);
    assert.equal(result.owner, 'cloudfuze');
    assert.equal(result.repo, 'aisdlc-service');
    assert.equal(result.baseBranch, 'main');
    assert.match(result.branch, /^aisdlc\//);
    assert.ok(result.commitSha.length > 0);
    assert.ok(result.pullRequestNumber > 0);
    assert.match(result.pullRequestUrl, /\/pull\/\d+$/);
  });

  it('publishes the exact proposed content on the new branch, leaving the base branch untouched', async () => {
    const h = harness();
    const service = createGithubPublishService(h.deps);
    const result = await service.publishApprovedChanges(RUN_ID, EXECUTION_ID);
    assert.ok(result.ok);

    const published = await h.client.getFileContents(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', 'src/index.ts', result.branch);
    assert.deepEqual(published, { ok: true, content: MODIFY_CHANGE.proposedContent });

    const baseContent = await h.client.getFileContents(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', 'src/index.ts', 'main');
    assert.deepEqual(baseContent, { ok: true, content: ORIGINAL_CONTENT });
  });

  it('emits the expected audit sequence', async () => {
    const h = harness();
    const service = createGithubPublishService(h.deps);
    await service.publishApprovedChanges(RUN_ID, EXECUTION_ID);

    assert.deepEqual(h.auditEntries.map((e) => e.action), [
      'github.write.started',
      'github.branch.created',
      'github.pr.created',
      'github.write.completed',
    ]);
  });

  it('never merges the pull request — no merge method exists on the client at all', async () => {
    const h = harness();
    const service = createGithubPublishService(h.deps);
    const result = await service.publishApprovedChanges(RUN_ID, EXECUTION_ID);
    assert.ok(result.ok);
    assert.ok(!('mergePullRequest' in h.client));
  });
});

describe('security boundary (Section 2)', () => {
  it('refuses when the execution does not exist', async () => {
    const h = harness({ executions: [] });
    const service = createGithubPublishService(h.deps);
    const result = await service.publishApprovedChanges(RUN_ID, EXECUTION_ID);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'execution_not_found');
  });

  it('refuses when the execution did not succeed', async () => {
    const h = harness({ executions: [execution({ status: 'failed', failureCategory: 'validation_failed', failureMessage: 'x' })] });
    const service = createGithubPublishService(h.deps);
    const result = await service.publishApprovedChanges(RUN_ID, EXECUTION_ID);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'execution_not_succeeded');
  });

  it('refuses when the review does not exist', async () => {
    const h = harness({ reviews: [] });
    const service = createGithubPublishService(h.deps);
    const result = await service.publishApprovedChanges(RUN_ID, EXECUTION_ID);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'review_not_found');
  });

  it('refuses when the review is not approved', async () => {
    const h = harness({ reviews: [review({ status: 'pending', reviewedBy: null, reviewedAt: null })] });
    const service = createGithubPublishService(h.deps);
    const result = await service.publishApprovedChanges(RUN_ID, EXECUTION_ID);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'review_not_approved');
  });

  it('refuses a rejected review', async () => {
    const h = harness({ reviews: [review({ status: 'rejected' })] });
    const service = createGithubPublishService(h.deps);
    const result = await service.publishApprovedChanges(RUN_ID, EXECUTION_ID);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'review_not_approved');
  });

  it('refuses when the review has been superseded by a newer proposal', async () => {
    const older = review({ createdAt: new Date(NOW.getTime() - 10_000) });
    const newer = review({ _id: new ObjectId(), proposalHash: 'b'.repeat(64), createdAt: NOW, status: 'pending', reviewedBy: null, reviewedAt: null });
    const h = harness({ reviews: [older, newer] });
    const service = createGithubPublishService(h.deps);
    const result = await service.publishApprovedChanges(RUN_ID, EXECUTION_ID);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'review_superseded');
  });

  it('refuses when the executed proposal hash does not match the approved review', async () => {
    const h = harness({ executions: [execution({ proposalHash: 'c'.repeat(64) })] });
    const service = createGithubPublishService(h.deps);
    const result = await service.publishApprovedChanges(RUN_ID, EXECUTION_ID);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'proposal_hash_mismatch');
  });

  it('refuses when the repository selection is missing', async () => {
    const h = harness({ selection: null });
    const service = createGithubPublishService(h.deps);
    const result = await service.publishApprovedChanges(RUN_ID, EXECUTION_ID);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'repository_access_failure');
  });

  it('refuses when the repository selection is not confirmed', async () => {
    const h = harness({ selection: selection({ status: 'pending', confirmedBy: null }) });
    const service = createGithubPublishService(h.deps);
    const result = await service.publishApprovedChanges(RUN_ID, EXECUTION_ID);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'repository_access_failure');
  });

  it('refuses when the registry entry is inactive', async () => {
    const h = harness({ registryEntries: [registryEntry({ status: 'inactive' })] });
    const service = createGithubPublishService(h.deps);
    const result = await service.publishApprovedChanges(RUN_ID, EXECUTION_ID);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'repository_access_failure');
  });

  it('refuses when the run now resolves to a different repository', async () => {
    const otherRepo: MockRepository = { ...MOCK_REPO, owner: 'someone-else', repo: 'other-repo' };
    const h = harness({
      mockRepositories: [otherRepo],
      registryEntries: [registryEntry({ repositoryUrl: 'https://github.com/someone-else/other-repo' })],
      selection: selection({ selectedRepositoryUrl: 'https://github.com/someone-else/other-repo' }),
    });
    const service = createGithubPublishService(h.deps);
    const result = await service.publishApprovedChanges(RUN_ID, EXECUTION_ID);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'repository_mismatch');
  });

  it('refuses when the run now resolves to a different branch', async () => {
    const repoWithFeature: MockRepository = { ...MOCK_REPO, branches: ['main', 'feature/x'] };
    const h = harness({
      mockRepositories: [repoWithFeature],
      registryEntries: [registryEntry({ allowedBranches: ['main', 'feature/x'] })],
      selection: selection({ selectedDefaultBranch: 'feature/x', selectedAllowedBranches: ['main', 'feature/x'] }),
    });
    const service = createGithubPublishService(h.deps);
    const result = await service.publishApprovedChanges(RUN_ID, EXECUTION_ID);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'branch_mismatch');
  });

  it('never persists an eligibility-phase refusal', async () => {
    const h = harness({ reviews: [] });
    const service = createGithubPublishService(h.deps);
    await service.publishApprovedChanges(RUN_ID, EXECUTION_ID);
    assert.equal(h.publicationStore.length, 0);
  });
});

describe('stale content re-verification right before publishing (Section 6)', () => {
  it('refuses when the live content no longer matches the approved original hash', async () => {
    const staleRepo: MockRepository = { ...MOCK_REPO, files: { 'src/index.ts': 'export const someoneElseChangedThis = true;' } };
    const h = harness({ mockRepositories: [staleRepo] });
    const service = createGithubPublishService(h.deps);
    const result = await service.publishApprovedChanges(RUN_ID, EXECUTION_ID);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'stale_file');
    assert.equal(h.publicationStore.length, 1, 'a real attempt was made and is recorded');
  });

  it('refuses a proposed path that is unsafe', async () => {
    const unsafeChange: ProposedChange = { ...MODIFY_CHANGE, filePath: '.env', operation: 'create', originalContentHash: null };
    const h = harness({ reviews: [review({ proposedChanges: [unsafeChange] })] });
    const service = createGithubPublishService(h.deps);
    const result = await service.publishApprovedChanges(RUN_ID, EXECUTION_ID);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'unauthorized_file');
  });
});

describe('base branch protection (Section 4, Section 5)', () => {
  it('refuses when the base branch does not exist', async () => {
    const h = harness({ reviews: [review({ branch: 'no-such-branch' })] });
    const service = createGithubPublishService(h.deps);
    const result = await service.publishApprovedChanges(RUN_ID, EXECUTION_ID);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'branch_mismatch');
  });

  it('refuses and does not create a branch when the base branch moved during publishing', async () => {
    // The SAME underlying client instance backs both the override and the
    // fallback — a fresh `createMockGitHubAppClient()` per call would have
    // no knowledge of state (e.g. the eventually-created branch) the real
    // calls established on a different instance.
    const baseClient = createMockGitHubAppClient({ repositories: [MOCK_REPO] });
    let mainGetRefCalls = 0;
    const client: GitHubAppClient = {
      ...baseClient,
      async getRef(installationId, owner, repo, branch) {
        if (branch === 'main') {
          mainGetRefCalls += 1;
          // The FIRST call reads the base sha to build the tree on top of;
          // the SECOND is the re-check right before publishing (Section 5)
          // — simulate the base branch having moved in between.
          if (mainGetRefCalls === 2) {
            return { ok: true, sha: 'someone-elses-new-commit-sha' };
          }
        }
        return baseClient.getRef(installationId, owner, repo, branch);
      },
    };
    const h = harness({ clientOverrides: client });
    const service = createGithubPublishService(h.deps);
    const result = await service.publishApprovedChanges(RUN_ID, EXECUTION_ID);

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'base_branch_changed');
    // No branch was ever created — the failure is recorded, but with no branch.
    assert.equal(h.publicationStore[0]?.branch, '');
  });
});

describe('branch conflict / idempotency at the GitHub layer', () => {
  it('refuses when a branch at the deterministic name already exists and is not ours', async () => {
    const preSeeded = createMockGitHubAppClient({ repositories: [MOCK_REPO] });
    // Pre-create a branch at the exact deterministic name this run/execution would generate.
    const { generateBranchName } = await import('./branch-name.ts');
    const branchName = generateBranchName(RUN_ID, EXECUTION_ID);
    const ref = await preSeeded.getRef(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', 'main');
    assert.ok(ref.ok);
    await preSeeded.createBranch(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', branchName, ref.sha);

    const h = harness({ clientOverrides: preSeeded });
    const service = createGithubPublishService(h.deps);
    const result = await service.publishApprovedChanges(RUN_ID, EXECUTION_ID);

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'branch_conflict');
  });
});

describe('idempotency (Section 10)', () => {
  it('does not re-publish on a duplicate sequential request', async () => {
    const h = harness();
    const service = createGithubPublishService(h.deps);
    const first = await service.publishApprovedChanges(RUN_ID, EXECUTION_ID);
    const second = await service.publishApprovedChanges(RUN_ID, EXECUTION_ID);

    assert.ok(first.ok && second.ok);
    assert.deepEqual(first, second);
    assert.equal(h.publicationStore.length, 1);
  });

  it('de-duplicates two concurrent publish requests for the same execution', async () => {
    const h = harness();
    const service = createGithubPublishService(h.deps);
    const [first, second] = await Promise.all([
      service.publishApprovedChanges(RUN_ID, EXECUTION_ID),
      service.publishApprovedChanges(RUN_ID, EXECUTION_ID),
    ]);

    assert.ok(first.ok && second.ok);
    assert.deepEqual(first, second);
    assert.equal(h.publicationStore.length, 1);
  });
});

describe('failure recovery / reconciliation (Section 11, Section 12)', () => {
  it('recovers a pull request that already exists rather than failing', async () => {
    const base = createMockGitHubAppClient({ repositories: [MOCK_REPO] });
    const client: GitHubAppClient = {
      ...base,
      async createPullRequest() {
        return { ok: false, kind: 'pull_request_already_exists', message: 'already exists' };
      },
      async findPullRequestForBranch(installationId, owner, repo, head, prBase) {
        return { ok: true, pullRequest: { number: 99, htmlUrl: 'https://github.com/cloudfuze/aisdlc-service/pull/99', state: 'open' } };
      },
    };
    const h = harness({ clientOverrides: client });
    const service = createGithubPublishService(h.deps);
    const result = await service.publishApprovedChanges(RUN_ID, EXECUTION_ID);

    assert.ok(result.ok);
    assert.equal(result.pullRequestNumber, 99);
  });

  it('recovers a branch that was actually created despite an ambiguous createBranch failure', async () => {
    const base = createMockGitHubAppClient({ repositories: [MOCK_REPO] });
    let createBranchCalls = 0;
    const client: GitHubAppClient = {
      ...base,
      async createBranch(installationId, owner, repo, branch, sha) {
        createBranchCalls += 1;
        // First call: simulate the push actually landing despite a timeout-shaped failure response.
        await base.createBranch(installationId, owner, repo, branch, sha);
        return { ok: false, kind: 'transient', message: 'request timed out (simulated)' };
      },
    };
    const h = harness({ clientOverrides: client });
    const service = createGithubPublishService(h.deps);
    const result = await service.publishApprovedChanges(RUN_ID, EXECUTION_ID);

    assert.ok(result.ok, 'reconciliation should find the branch that was actually created');
    assert.equal(createBranchCalls, 1);
  });

  it('fails cleanly when createBranch truly failed and reconciliation finds nothing', async () => {
    const base = createMockGitHubAppClient({ repositories: [MOCK_REPO] });
    const client: GitHubAppClient = {
      ...base,
      async createBranch() {
        return { ok: false, kind: 'transient', message: 'network exploded' };
      },
    };
    const h = harness({ clientOverrides: client });
    const service = createGithubPublishService(h.deps);
    const result = await service.publishApprovedChanges(RUN_ID, EXECUTION_ID);

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'branch_creation_failed');
  });
});

describe('security: no secrets in the audit trail, no local artifact left behind', () => {
  it('never records file content in an audit entry', async () => {
    const h = harness();
    const service = createGithubPublishService(h.deps);
    await service.publishApprovedChanges(RUN_ID, EXECUTION_ID);

    for (const entry of h.auditEntries) {
      const serialized = JSON.stringify(entry.detail ?? {});
      assert.ok(!serialized.includes(MODIFY_CHANGE.proposedContent));
      assert.ok(!serialized.includes(ORIGINAL_CONTENT));
      assert.ok(!serialized.toLowerCase().includes('token'));
    }
  });
});
