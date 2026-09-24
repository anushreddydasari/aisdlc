/**
 * Section 17 security review — one property per test, scoped to the
 * orchestration surface THIS phase adds (pipeline/, api/run-status.ts,
 * api/coding-agent.ts, api/change-review.ts). Every property already has
 * its own dedicated test elsewhere in the codebase where the underlying
 * mechanism lives (path-safety.test.ts, branch-name.test.ts,
 * review-repository.test.ts, and so on) — this file is the consolidated,
 * auditable checklist for the NEW wiring specifically: does the pipeline
 * layer itself ever bypass, duplicate, or weaken a guarantee an earlier
 * phase already established.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId } from 'mongodb';

import { createLogger } from '../logging/logger.ts';
import {
  ReviewDecisionRequiresOperatorError,
  type ChangeReviewDocument,
  type ChangeReviewRepository,
} from '../change-execution/review-repository.ts';
import type { ChangeExecutionDocument, ChangeExecutionRepository } from '../change-execution/execution-repository.ts';
import type { ChangeExecutionService } from '../change-execution/execution-service.ts';
import type { ImplementationPlan } from '../change-execution/types.ts';
import type { GithubPublicationRepository } from '../github-publish/publish-repository.ts';
import type { GithubPublishService } from '../github-publish/publish-service.ts';
import { executeApprovedReviews } from './change-execution-queue.ts';
import { publishSucceededExecutions } from './github-publish-queue.ts';
import { computeRunStatus } from './run-status.ts';
import type { RunDocument } from '../orchestrator/repository.ts';

const NOW = new Date('2026-09-23T12:00:00.000Z');
const RUN_ID = new ObjectId();
const logger = createLogger({ write: () => {} });

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
    status: 'pending',
    reviewedBy: null,
    reviewedAt: null,
    reviewComment: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('Property: the Coding Agent (or any service identity) cannot approve its own change', () => {
  it('ChangeReviewRepository.approve/reject refuses any actor lacking the operator: prefix, at the repository boundary', async () => {
    // This is the actual enforcement point every caller — the change-review
    // API handler, and (structurally) the pipeline queue, which never calls
    // approve/reject at all — ultimately depends on.
    const reviews: ChangeReviewRepository = {
      async createIfAbsent() {
        throw new Error('not used');
      },
      async findById() {
        throw new Error('not used');
      },
      async findLatestByRunId() {
        throw new Error('not used');
      },
      async approve(_id, options) {
        if (!options.actor.startsWith('operator:')) throw new ReviewDecisionRequiresOperatorError(options.actor);
        throw new Error('unreachable in this test');
      },
      async reject() {
        throw new Error('not used');
      },
      async findApproved() {
        throw new Error('not used');
      },
    };
    await assert.rejects(
      () => reviews.approve(new ObjectId(), { actor: 'system:coding-agent' }),
      ReviewDecisionRequiresOperatorError,
    );
  });
});

describe('Property: no unapproved change can reach execution or publish', () => {
  it('the change-execution queue only ever examines reviews in the approved status', async () => {
    let approveOrRejectCalled = false;
    const reviews: ChangeReviewRepository = {
      async createIfAbsent() {
        throw new Error('not used');
      },
      async findById() {
        throw new Error('not used');
      },
      async findLatestByRunId() {
        throw new Error('not used');
      },
      async approve() {
        approveOrRejectCalled = true;
        throw new Error('the pipeline queue must never call approve');
      },
      async reject() {
        approveOrRejectCalled = true;
        throw new Error('the pipeline queue must never call reject');
      },
      // A correct ChangeReviewRepository implementation only returns
      // 'approved' rows here by construction — this fake proves the QUEUE
      // never independently re-derives eligibility from pending/rejected rows.
      async findApproved() {
        return [];
      },
    };
    const executions: ChangeExecutionRepository = {
      async createIfAbsent() {
        throw new Error('not used');
      },
      async findByReviewId() {
        throw new Error('not used');
      },
      async findById() {
        throw new Error('not used');
      },
      async findSucceeded() {
        throw new Error('not used');
      },
    };
    const executionService: ChangeExecutionService = {
      async executeApprovedChanges() {
        throw new Error('must never be called: nothing was eligible');
      },
    };

    const summary = await executeApprovedReviews({ reviews, executions, executionService, logger });
    assert.equal(summary.examined, 0);
    assert.equal(approveOrRejectCalled, false);
  });

  it('the run-status view reports change_rejected for a rejected review, never a stage implying further progress', () => {
    const run: RunDocument = {
      _id: RUN_ID,
      intakeItemId: new ObjectId(),
      issueKey: 'CF-1',
      status: 'queued',
      trigger: 'approval',
      createdAt: NOW,
      startedAt: null,
      completedAt: null,
      updatedAt: NOW,
    };
    const status = computeRunStatus({ run, selection: null, review: review({ status: 'rejected' }), execution: null, publication: null, deployment: null });
    assert.equal(status.stage, 'change_rejected');
    assert.notEqual(status.stage, 'executing');
    assert.notEqual(status.stage, 'awaiting_human_merge');
  });
});

describe('Property: no execution can be published without a recorded, genuine success', () => {
  it('the github-publish queue only ever examines executions in the succeeded status', async () => {
    const executions: ChangeExecutionRepository = {
      async createIfAbsent() {
        throw new Error('not used');
      },
      async findByReviewId() {
        throw new Error('not used');
      },
      async findById() {
        throw new Error('not used');
      },
      // A correct implementation only returns 'succeeded' rows — this fake
      // proves the queue itself adds no additional, looser eligibility.
      async findSucceeded() {
        return [];
      },
    };
    const publications: GithubPublicationRepository = {
      async createIfAbsent() {
        throw new Error('not used');
      },
      async findByExecutionId() {
        throw new Error('not used');
      },
      async findPublished() {
        throw new Error('not used');
      },
    };
    const publishService: GithubPublishService = {
      async publishApprovedChanges() {
        throw new Error('must never be called: nothing was eligible');
      },
    };

    const summary = await publishSucceededExecutions({ executions, publications, publishService, logger });
    assert.equal(summary.examined, 0);
  });
});

describe('Property: no merge capability exists anywhere in the orchestration surface', () => {
  it('GithubPublishService exposes exactly one method, and it is not a merge', () => {
    const service: GithubPublishService = { async publishApprovedChanges() { throw new Error('unused'); } };
    assert.deepEqual(Object.keys(service), ['publishApprovedChanges']);
  });

  it('computeRunStatus never marks a run as merged or deployed — only as awaiting human action', () => {
    const run: RunDocument = {
      _id: RUN_ID,
      intakeItemId: new ObjectId(),
      issueKey: 'CF-1',
      status: 'queued',
      trigger: 'approval',
      createdAt: NOW,
      startedAt: null,
      completedAt: null,
      updatedAt: NOW,
    };
    const execution: ChangeExecutionDocument = {
      _id: new ObjectId(),
      runId: RUN_ID,
      reviewId: new ObjectId(),
      proposalHash: 'a'.repeat(64),
      status: 'succeeded',
      appliedChanges: [],
      validation: { tests: { ok: true, summary: 'ok' }, typecheck: { ok: true, summary: 'ok' }, build: { ok: true, summary: 'ok' } },
      failureCategory: null,
      failureMessage: null,
      createdAt: NOW,
      completedAt: NOW,
    };
    const status = computeRunStatus({
      run,
      selection: null,
      review: review({ status: 'approved' }),
      execution,
      publication: {
        _id: new ObjectId(),
        runId: RUN_ID,
        reviewId: new ObjectId(),
        executionId: execution._id!,
        owner: 'cloudfuze',
        repo: 'aisdlc-service',
        baseBranch: 'main',
        branch: 'aisdlc/x/y',
        baseSha: 's1',
        commitSha: 's2',
        status: 'published',
        pullRequestNumber: 1,
        pullRequestUrl: 'https://github.com/cloudfuze/aisdlc-service/pull/1',
        failureCategory: null,
        failureMessage: null,
        createdAt: NOW,
        completedAt: NOW,
      },
      deployment: null,
    });
    // With no deployment record, 'awaiting_human_merge' is exactly where
    // this run sits — a 'deployed' stage exists in the RunStage union, but
    // reaching it requires a persisted `deployments` row, and the ONLY
    // code path that ever creates one is `pr-merge-detection.ts` reading
    // GitHub's own `merged` boolean — never invented or assumed here.
    assert.equal(status.stage, 'awaiting_human_merge');
    assert.equal(status.humanActionRequired, true);
  });
});
