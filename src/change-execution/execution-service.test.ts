/**
 * Every test here uses in-memory fakes: no real MongoDB, no real GitHub
 * App. `GitHubAccessService` and `ChangeValidationRunner` are faked
 * directly rather than built from their own dependencies — each has its
 * own exhaustive test suite elsewhere; this file only needs to prove THIS
 * service reacts correctly to what they return, and that it never writes
 * to GitHub, never overwrites stale content, and never re-applies an
 * already-executed review.
 */

import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { ObjectId } from 'mongodb';

import type { AuditEntryInput, AuditLog } from '../db/audit-log.ts';
import { createLogger } from '../logging/logger.ts';
import { hashFileContent } from '../coding-agent/changes.ts';
import type { GitHubAccessResult, GitHubAccessService } from '../github-access/service.ts';
import { createChangeExecutionService, type ChangeExecutionDeps } from './execution-service.ts';
import type { ChangeExecutionDocument, ChangeExecutionRepository, RecordExecutionInput } from './execution-repository.ts';
import type { ChangeReviewDocument, ChangeReviewRepository } from './review-repository.ts';
import { createMockChangeValidationRunner, type ChangeValidationContext, type ChangeValidationRunner } from './validation.ts';
import type { ImplementationPlan, ProposedChange } from './types.ts';

const NOW = new Date('2026-09-22T12:00:00.000Z');
const RUN_ID = new ObjectId();
const INTAKE_ITEM_ID = new ObjectId();
const REVIEW_ID = new ObjectId();

const LIVE_CONTENT = 'export const original = true;';
const ORIGINAL_HASH = hashFileContent(LIVE_CONTENT);

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
    proposalHash: 'a'.repeat(64),
    status: 'approved',
    reviewedBy: 'operator:alice',
    reviewedAt: NOW,
    reviewComment: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function githubAccessSuccess(overrides: Partial<Extract<GitHubAccessResult, { ok: true }>> = {}): GitHubAccessResult {
  return {
    ok: true,
    runId: RUN_ID,
    intakeItemId: INTAKE_ITEM_ID,
    repositoryId: 'aisdlc-service',
    owner: 'cloudfuze',
    repo: 'aisdlc-service',
    branch: 'main',
    defaultBranch: 'main',
    visibility: 'private',
    files: [],
    ...overrides,
  };
}

function githubAccessFailure(overrides: Partial<Extract<GitHubAccessResult, { ok: false }>> = {}): GitHubAccessResult {
  return {
    ok: false,
    runId: RUN_ID,
    intakeItemId: INTAKE_ITEM_ID,
    repositoryId: 'aisdlc-service',
    category: 'file_not_found',
    message: 'not found',
    retryable: false,
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

/**
 * Mirrors execution-repository.ts's own idempotent-on-reviewId `createIfAbsent`
 * and its `change-execution.completed`/`change-execution.failed` audit
 * emission — a plain in-memory store would silently skip that audit event,
 * making this file's audit-sequence assertions test the fake instead of the
 * service. See execution-repository.test.ts for that module's own tests.
 */
function fakeExecutionRepository(audit: AuditLog): { repo: ChangeExecutionRepository; store: ChangeExecutionDocument[] } {
  const store: ChangeExecutionDocument[] = [];
  const repo: ChangeExecutionRepository = {
    async createIfAbsent(input: RecordExecutionInput) {
      const existing = store.find((e) => e.reviewId.equals(input.reviewId));
      if (existing !== undefined) return { execution: existing, created: false };
      const document: ChangeExecutionDocument = {
        _id: new ObjectId(),
        runId: input.runId,
        reviewId: input.reviewId,
        proposalHash: input.proposalHash,
        status: input.status,
        appliedChanges: [...input.appliedChanges],
        validation: input.validation,
        failureCategory: input.failureCategory,
        failureMessage: input.failureMessage,
        createdAt: new Date(),
        completedAt: new Date(),
      };
      store.push(document);
      await audit.append({
        actor: 'system:change-execution',
        action: input.status === 'succeeded' ? 'change-execution.completed' : 'change-execution.failed',
        subjectType: 'changeExecution',
        subjectId: document._id!,
        detail: { runId: input.runId.toHexString(), reviewId: input.reviewId.toHexString(), status: input.status },
      });
      return { execution: document, created: true };
    },
    async findByReviewId(reviewId) {
      return store.find((e) => e.reviewId.equals(reviewId)) ?? null;
    },
    async findById(id) {
      return store.find((e) => e._id!.equals(id)) ?? null;
    },
    async findSucceeded() {
      throw new Error('must not be called');
    },
  };
  return { repo, store };
}

interface Counted<T> {
  readonly value: T;
  calls: number;
}

function trackedGitHubAccess(
  options: {
    identityResult?: GitHubAccessResult;
    contentResult?: GitHubAccessResult;
    liveContent?: string;
  } = {},
): Counted<GitHubAccessService> & { readonly calledWith: (readonly string[])[] } {
  const calledWith: (readonly string[])[] = [];
  const counted = {
    calls: 0,
    calledWith,
    value: {
      async accessRepositoryForRun(_runId: ObjectId, filePaths: readonly string[]): Promise<GitHubAccessResult> {
        counted.calls += 1;
        calledWith.push([...filePaths]);
        if (filePaths.length === 0) {
          return options.identityResult ?? githubAccessSuccess();
        }
        return (
          options.contentResult ??
          githubAccessSuccess({ files: filePaths.map((p) => ({ path: p, content: options.liveContent ?? LIVE_CONTENT })) })
        );
      },
      async listFilesForRun(): Promise<never> {
        throw new Error('must not be called');
      },
    },
  };
  return counted;
}

function trackedValidationRunner(outcomes: { tests?: boolean; typecheck?: boolean; build?: boolean } = {}): Counted<ChangeValidationRunner> {
  const mock = createMockChangeValidationRunner(outcomes);
  const counted = {
    calls: 0,
    value: {
      async run(context: ChangeValidationContext) {
        counted.calls += 1;
        return mock.run(context);
      },
    },
  };
  return counted;
}

interface Harness {
  readonly deps: ChangeExecutionDeps;
  readonly auditEntries: AuditEntryInput[];
  readonly executionStore: ChangeExecutionDocument[];
  readonly access: Counted<GitHubAccessService> & { readonly calledWith: (readonly string[])[] };
  readonly validation: Counted<ChangeValidationRunner>;
}

function harness(
  options: {
    reviews?: ChangeReviewDocument[];
    identityResult?: GitHubAccessResult;
    contentResult?: GitHubAccessResult;
    liveContent?: string;
    validationOutcomes?: { tests?: boolean; typecheck?: boolean; build?: boolean };
    approvalValidityMs?: number;
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

  const reviews = fakeReviewRepository(options.reviews ?? [review()]);
  const { repo: executions, store: executionStore } = fakeExecutionRepository(audit);
  const access = trackedGitHubAccess({
    ...(options.identityResult === undefined ? {} : { identityResult: options.identityResult }),
    ...(options.contentResult === undefined ? {} : { contentResult: options.contentResult }),
    ...(options.liveContent === undefined ? {} : { liveContent: options.liveContent }),
  });
  const validation = trackedValidationRunner(options.validationOutcomes);

  return {
    deps: {
      reviews,
      executions,
      access: access.value,
      validation: validation.value,
      audit,
      logger: createLogger({ write: () => {} }),
      now: () => NOW,
      ...(options.approvalValidityMs === undefined ? {} : { approvalValidityMs: options.approvalValidityMs }),
    },
    auditEntries,
    executionStore,
    access,
    validation,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('successful execution', () => {
  it('applies an approved single-file change and validates it', async () => {
    const h = harness();
    const service = createChangeExecutionService(h.deps);
    const result = await service.executeApprovedChanges(RUN_ID, REVIEW_ID);

    assert.ok(result.ok);
    assert.deepEqual(result.appliedChanges, [{ path: 'src/index.ts', operation: 'modify' }]);
    assert.ok(result.validation.tests.ok && result.validation.typecheck.ok && result.validation.build.ok);
    assert.equal(h.executionStore.length, 1);
    assert.equal(h.executionStore[0]!.status, 'succeeded');
  });

  it('applies multiple approved changes in one execution', async () => {
    const createChange: ProposedChange = {
      filePath: 'src/new-file.ts',
      operation: 'create',
      originalContentHash: null,
      proposedContent: 'export const brandNew = true;',
      reason: 'r',
      relatedPlanItemId: 'item-1',
    };
    const h = harness({ reviews: [review({ proposedChanges: [MODIFY_CHANGE, createChange] })] });
    const service = createChangeExecutionService(h.deps);
    const result = await service.executeApprovedChanges(RUN_ID, REVIEW_ID);

    assert.ok(result.ok);
    assert.equal(result.appliedChanges.length, 2);
  });

  it('emits the expected audit sequence', async () => {
    const h = harness();
    const service = createChangeExecutionService(h.deps);
    await service.executeApprovedChanges(RUN_ID, REVIEW_ID);

    assert.deepEqual(h.auditEntries.map((e) => e.action), [
      'change-execution.started',
      'change-validation.started',
      'change-validation.completed',
      'change-execution.completed',
    ]);
  });

  it('never leaves a local working directory behind after success', async () => {
    let capturedDirectory = '';
    const h = harness();
    const trackingValidation: ChangeValidationRunner = {
      async run(context) {
        capturedDirectory = context.workingDirectory;
        assert.ok(await pathExists(capturedDirectory), 'working directory should exist while validation runs');
        return createMockChangeValidationRunner().run(context);
      },
    };
    const service = createChangeExecutionService({ ...h.deps, validation: trackingValidation });
    await service.executeApprovedChanges(RUN_ID, REVIEW_ID);

    assert.ok(capturedDirectory !== '');
    assert.equal(await pathExists(capturedDirectory), false, 'working directory must be removed after validation');
  });
});

describe('unapproved / rejected reviews (Section 3, Section 12)', () => {
  it('refuses a still-pending review without contacting GitHub', async () => {
    const h = harness({ reviews: [review({ status: 'pending', reviewedBy: null, reviewedAt: null })] });
    const service = createChangeExecutionService(h.deps);
    const result = await service.executeApprovedChanges(RUN_ID, REVIEW_ID);

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'review_not_approved');
    assert.equal(h.access.calls, 0);
    assert.equal(h.executionStore.length, 0, 'no execution attempt is recorded for an eligibility refusal');
  });

  it('refuses a rejected review and preserves it for audit/history', async () => {
    const h = harness({ reviews: [review({ status: 'rejected', reviewedBy: 'operator:alice', reviewedAt: NOW })] });
    const service = createChangeExecutionService(h.deps);
    const result = await service.executeApprovedChanges(RUN_ID, REVIEW_ID);

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'review_not_approved');
    assert.equal(h.access.calls, 0);
  });
});

describe('missing / mismatched review', () => {
  it('refuses a reviewId that does not exist', async () => {
    const h = harness({ reviews: [] });
    const service = createChangeExecutionService(h.deps);
    const result = await service.executeApprovedChanges(RUN_ID, REVIEW_ID);

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'review_not_found');
    assert.equal(h.access.calls, 0);
  });

  it('refuses a review that belongs to a different run', async () => {
    const otherRun = new ObjectId();
    const h = harness({ reviews: [review({ runId: otherRun })] });
    const service = createChangeExecutionService(h.deps);
    const result = await service.executeApprovedChanges(RUN_ID, REVIEW_ID);

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'review_not_found');
  });
});

describe('approval expiry', () => {
  it('refuses an approval older than the validity window', async () => {
    const oldApproval = new Date(NOW.getTime() - 10_000);
    const h = harness({ reviews: [review({ reviewedAt: oldApproval })], approvalValidityMs: 5_000 });
    const service = createChangeExecutionService(h.deps);
    const result = await service.executeApprovedChanges(RUN_ID, REVIEW_ID);

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'approval_expired');
    assert.equal(h.access.calls, 0);
  });

  it('accepts an approval within the validity window', async () => {
    const recentApproval = new Date(NOW.getTime() - 1_000);
    const h = harness({ reviews: [review({ reviewedAt: recentApproval })], approvalValidityMs: 5_000 });
    const service = createChangeExecutionService(h.deps);
    const result = await service.executeApprovedChanges(RUN_ID, REVIEW_ID);

    assert.equal(result.ok, true);
  });
});

describe('review superseded (Section 4, Section 11)', () => {
  it('refuses an approval whose proposal has since been superseded by a newer review for the run', async () => {
    const older = review({ createdAt: new Date(NOW.getTime() - 10_000) });
    const newer = review({
      _id: new ObjectId(),
      proposalHash: 'b'.repeat(64),
      status: 'pending',
      reviewedBy: null,
      reviewedAt: null,
      createdAt: NOW,
    });
    const h = harness({ reviews: [older, newer] });
    const service = createChangeExecutionService(h.deps);
    const result = await service.executeApprovedChanges(RUN_ID, REVIEW_ID);

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'review_superseded');
    assert.equal(h.access.calls, 0);
  });
});

describe('repository/branch identity re-verification (Section 5, Section 11)', () => {
  it('refuses when the run now resolves to a different repository', async () => {
    const h = harness({ identityResult: githubAccessSuccess({ owner: 'someone-else', repo: 'other-repo' }) });
    const service = createChangeExecutionService(h.deps);
    const result = await service.executeApprovedChanges(RUN_ID, REVIEW_ID);

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'repository_mismatch');
    assert.equal(h.access.calls, 1, 'must not read file content for an unauthorized repository');
  });

  it('refuses when the run now resolves to a different branch', async () => {
    const h = harness({ identityResult: githubAccessSuccess({ branch: 'feature/other' }) });
    const service = createChangeExecutionService(h.deps);
    const result = await service.executeApprovedChanges(RUN_ID, REVIEW_ID);

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'branch_mismatch');
  });

  it('propagates a GitHub access failure as retryable when GitHub itself says so', async () => {
    const h = harness({ identityResult: githubAccessFailure({ category: 'rate_limited', retryable: true }) });
    const service = createChangeExecutionService(h.deps);
    const result = await service.executeApprovedChanges(RUN_ID, REVIEW_ID);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.category, 'repository_access_failure');
      assert.equal(result.retryable, true);
    }
  });
});

describe('stale-file detection (Section 5, Section 11)', () => {
  it('refuses when the live content no longer matches the reviewed original hash', async () => {
    const h = harness({ liveContent: 'export const someoneElseChangedThis = true;' });
    const service = createChangeExecutionService(h.deps);
    const result = await service.executeApprovedChanges(RUN_ID, REVIEW_ID);

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'stale_file');
    assert.equal(h.executionStore.length, 1, 'a real attempt was made and is recorded');
    assert.equal(h.executionStore[0]!.status, 'failed');
  });

  it('refuses when the modify target no longer exists at all', async () => {
    const h = harness({ contentResult: githubAccessFailure({ category: 'file_not_found', message: 'gone' }) });
    const service = createChangeExecutionService(h.deps);
    const result = await service.executeApprovedChanges(RUN_ID, REVIEW_ID);

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'stale_file');
  });
});

describe('path safety (Section 6)', () => {
  it('refuses an absolute path', async () => {
    const h = harness({
      reviews: [
        review({
          proposedChanges: [
            {
              filePath: '/etc/passwd',
              operation: 'create',
              originalContentHash: null,
              proposedContent: 'x',
              reason: 'r',
              relatedPlanItemId: 'item-1',
            },
          ],
        }),
      ],
    });
    const service = createChangeExecutionService(h.deps);
    const result = await service.executeApprovedChanges(RUN_ID, REVIEW_ID);

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'invalid_path');
  });

  it('refuses a credential-shaped file', async () => {
    const h = harness({
      reviews: [
        review({
          proposedChanges: [
            {
              filePath: '.env',
              operation: 'create',
              originalContentHash: null,
              proposedContent: 'SECRET=x', // pragma: fixture
              reason: 'r',
              relatedPlanItemId: 'item-1',
            },
          ],
        }),
      ],
    });
    const service = createChangeExecutionService(h.deps);
    const result = await service.executeApprovedChanges(RUN_ID, REVIEW_ID);

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'unauthorized_file');
  });
});

describe('validation failure (Section 8)', () => {
  it('does not declare success when the tests step fails, but records what was applied', async () => {
    const h = harness({ validationOutcomes: { tests: false } });
    const service = createChangeExecutionService(h.deps);
    const result = await service.executeApprovedChanges(RUN_ID, REVIEW_ID);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.category, 'validation_failed');
      assert.deepEqual(result.appliedChanges, [{ path: 'src/index.ts', operation: 'modify' }]);
      assert.equal(result.validation!.tests.ok, false);
    }
    assert.deepEqual(h.auditEntries.map((e) => e.action), [
      'change-execution.started',
      'change-validation.started',
      'change-validation.failed',
      'change-execution.failed',
    ]);
  });
});

describe('idempotency (Section 10)', () => {
  it('does not re-apply changes on a duplicate sequential execution request', async () => {
    const h = harness();
    const service = createChangeExecutionService(h.deps);
    const first = await service.executeApprovedChanges(RUN_ID, REVIEW_ID);
    const second = await service.executeApprovedChanges(RUN_ID, REVIEW_ID);

    assert.ok(first.ok && second.ok);
    assert.deepEqual(first, second);
    assert.equal(h.access.calls, 2, 'identity check + content read, exactly once each — never repeated');
    assert.equal(h.validation.calls, 1, 'validation never re-runs for an already-recorded review');
    assert.equal(h.executionStore.length, 1);
  });

  it('returns the recorded failure, unchanged, on a duplicate request after a failed attempt', async () => {
    const h = harness({ validationOutcomes: { build: false } });
    const service = createChangeExecutionService(h.deps);
    const first = await service.executeApprovedChanges(RUN_ID, REVIEW_ID);
    const second = await service.executeApprovedChanges(RUN_ID, REVIEW_ID);

    assert.ok(!first.ok && !second.ok);
    assert.equal(first.category, second.category);
    assert.equal(h.validation.calls, 1);
  });
});

describe('concurrency (Section 11)', () => {
  it('de-duplicates two concurrent execution requests for the same review', async () => {
    const h = harness();
    const service = createChangeExecutionService(h.deps);
    const [first, second] = await Promise.all([
      service.executeApprovedChanges(RUN_ID, REVIEW_ID),
      service.executeApprovedChanges(RUN_ID, REVIEW_ID),
    ]);

    assert.ok(first.ok && second.ok);
    assert.deepEqual(first, second);
    assert.equal(h.validation.calls, 1, 'only one of the two concurrent calls actually executes');
    assert.equal(h.executionStore.length, 1);
  });
});

describe('security: no secrets or file content in the audit trail', () => {
  it('never records proposed file content in an audit entry', async () => {
    const h = harness();
    const service = createChangeExecutionService(h.deps);
    await service.executeApprovedChanges(RUN_ID, REVIEW_ID);

    for (const entry of h.auditEntries) {
      const serialized = JSON.stringify(entry.detail ?? {});
      assert.ok(!serialized.includes(MODIFY_CHANGE.proposedContent), 'audit detail must never contain proposed file content');
      assert.ok(!serialized.includes(LIVE_CONTENT), 'audit detail must never contain live file content');
    }
  });
});
