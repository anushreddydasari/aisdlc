import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId } from 'mongodb';

import { createLogger } from '../logging/logger.ts';
import type { ChangeExecutionDocument, ChangeExecutionRepository } from '../change-execution/execution-repository.ts';
import type { ChangeReviewDocument, ChangeReviewRepository } from '../change-execution/review-repository.ts';
import type { ChangeExecutionService } from '../change-execution/execution-service.ts';
import type { ImplementationPlan } from '../change-execution/types.ts';
import type { ExecutionResult } from '../change-execution/types.ts';
import { executeApprovedReviews, type ChangeExecutionQueueDeps } from './change-execution-queue.ts';

const NOW = new Date('2026-09-23T12:00:00.000Z');
const RUN_ID = new ObjectId();

const PLAN: ImplementationPlan = {
  summary: 's',
  requirementsUnderstanding: 'u',
  relevantFiles: [],
  items: [],
  dependenciesAndImpact: [],
  testsRequired: [],
  assumptions: [],
  risks: [],
};

function review(overrides: Partial<ChangeReviewDocument> = {}): ChangeReviewDocument {
  return {
    _id: new ObjectId(),
    runId: RUN_ID,
    intakeItemId: new ObjectId(),
    repositoryId: 'aisdlc-service',
    owner: 'cloudfuze',
    repo: 'aisdlc-service',
    branch: 'main',
    plan: PLAN,
    proposedChanges: [],
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

function fakeReviewRepository(reviews: ChangeReviewDocument[]): ChangeReviewRepository {
  return {
    async createIfAbsent() {
      throw new Error('must not be called');
    },
    async findById() {
      throw new Error('must not be called');
    },
    async findLatestByRunId() {
      throw new Error('must not be called');
    },
    async approve() {
      throw new Error('must not be called');
    },
    async reject() {
      throw new Error('must not be called');
    },
    async findApproved(limit = 25) {
      return reviews.slice(0, limit);
    },
  };
}

function fakeExecutionRepository(existing: ChangeExecutionDocument[]): ChangeExecutionRepository {
  return {
    async createIfAbsent() {
      throw new Error('must not be called');
    },
    async findByReviewId(reviewId) {
      return existing.find((e) => e.reviewId.equals(reviewId)) ?? null;
    },
    async findById() {
      throw new Error('must not be called');
    },
    async findSucceeded() {
      throw new Error('must not be called');
    },
  };
}

function executionDoc(reviewId: ObjectId): ChangeExecutionDocument {
  return {
    _id: new ObjectId(),
    runId: RUN_ID,
    reviewId,
    proposalHash: 'a'.repeat(64),
    status: 'succeeded',
    appliedChanges: [],
    validation: { tests: { ok: true, summary: 'ok' }, typecheck: { ok: true, summary: 'ok' }, build: { ok: true, summary: 'ok' } },
    failureCategory: null,
    failureMessage: null,
    createdAt: NOW,
    completedAt: NOW,
  };
}

function harness(
  options: { reviews?: ChangeReviewDocument[]; existingExecutions?: ChangeExecutionDocument[]; serviceResults?: Record<string, ExecutionResult> } = {},
): { deps: ChangeExecutionQueueDeps; executeCalls: string[] } {
  const executeCalls: string[] = [];
  const executionService: ChangeExecutionService = {
    async executeApprovedChanges(runId, reviewId) {
      executeCalls.push(reviewId.toHexString());
      const override = options.serviceResults?.[reviewId.toHexString()];
      if (override !== undefined) return override;
      return {
        ok: true,
        runId,
        reviewId,
        proposalHash: 'a'.repeat(64),
        appliedChanges: [],
        validation: { tests: { ok: true, summary: 'ok' }, typecheck: { ok: true, summary: 'ok' }, build: { ok: true, summary: 'ok' } },
      };
    },
  };

  return {
    deps: {
      reviews: fakeReviewRepository(options.reviews ?? [review()]),
      executions: fakeExecutionRepository(options.existingExecutions ?? []),
      executionService,
      logger: createLogger({ write: () => {} }),
    },
    executeCalls,
  };
}

describe('executeApprovedReviews', () => {
  it('executes an approved review with no execution yet', async () => {
    const h = harness();
    const summary = await executeApprovedReviews(h.deps);

    assert.equal(summary.examined, 1);
    assert.equal(summary.executed, 1);
    assert.equal(h.executeCalls.length, 1);
  });

  it('skips a review that already has an execution recorded, without calling the service', async () => {
    const r = review();
    const h = harness({ reviews: [r], existingExecutions: [executionDoc(r._id!)] });
    const summary = await executeApprovedReviews(h.deps);

    assert.equal(summary.examined, 1);
    assert.equal(summary.alreadyExecuted, 1);
    assert.equal(summary.executed, 0);
    assert.equal(h.executeCalls.length, 0);
  });

  it('counts a failed execution attempt without stopping the pass', async () => {
    const good = review({ _id: new ObjectId() });
    const bad = review({ _id: new ObjectId() });
    const failure: ExecutionResult = {
      ok: false,
      runId: RUN_ID,
      reviewId: bad._id!,
      proposalHash: 'a'.repeat(64),
      category: 'stale_file',
      message: 'x changed',
      retryable: false,
      appliedChanges: [],
      validation: null,
    };
    const h = harness({ reviews: [bad, good], serviceResults: { [bad._id!.toHexString()]: failure } });
    const summary = await executeApprovedReviews(h.deps);

    assert.equal(summary.examined, 2);
    assert.equal(summary.executed, 1);
    assert.equal(summary.failed, 1);
  });
});
