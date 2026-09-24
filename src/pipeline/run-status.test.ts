import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId } from 'mongodb';

import type { RunDocument } from '../orchestrator/repository.ts';
import type { RepositorySelectionDocument } from '../repository-selection/repository.ts';
import type { ChangeReviewDocument } from '../change-execution/review-repository.ts';
import type { ChangeExecutionDocument } from '../change-execution/execution-repository.ts';
import type { GithubPublicationDocument } from '../github-publish/publish-repository.ts';
import type { ImplementationPlan, ProposedChange } from '../change-execution/types.ts';
import { computeRunStatus } from './run-status.ts';

const NOW = new Date('2026-09-23T12:00:00.000Z');
const RUN_ID = new ObjectId();
const INTAKE_ITEM_ID = new ObjectId();

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
    status: 'pending',
    failureReason: null,
    attempts: 0,
    nextAttemptAt: NOW,
    confirmedBy: null,
    confirmedAt: null,
    lastNotifiedStatus: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

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
const CHANGES: ProposedChange[] = [];

function review(overrides: Partial<ChangeReviewDocument> = {}): ChangeReviewDocument {
  return {
    _id: new ObjectId(),
    runId: RUN_ID,
    intakeItemId: INTAKE_ITEM_ID,
    repositoryId: 'aisdlc-service',
    owner: 'cloudfuze',
    repo: 'aisdlc-service',
    branch: 'main',
    plan: PLAN,
    proposedChanges: CHANGES,
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

function execution(overrides: Partial<ChangeExecutionDocument> = {}): ChangeExecutionDocument {
  return {
    _id: new ObjectId(),
    runId: RUN_ID,
    reviewId: new ObjectId(),
    proposalHash: 'a'.repeat(64),
    status: 'succeeded',
    appliedChanges: [],
    validation: {
      tests: { ok: true, summary: 'ok' },
      typecheck: { ok: true, summary: 'ok' },
      build: { ok: true, summary: 'ok' },
    },
    failureCategory: null,
    failureMessage: null,
    createdAt: NOW,
    completedAt: NOW,
    ...overrides,
  };
}

function publication(overrides: Partial<GithubPublicationDocument> = {}): GithubPublicationDocument {
  return {
    _id: new ObjectId(),
    runId: RUN_ID,
    reviewId: new ObjectId(),
    executionId: new ObjectId(),
    owner: 'cloudfuze',
    repo: 'aisdlc-service',
    baseBranch: 'main',
    branch: 'aisdlc/x/y',
    baseSha: 'sha1',
    commitSha: 'sha2',
    status: 'published',
    pullRequestNumber: 42,
    pullRequestUrl: 'https://github.com/cloudfuze/aisdlc-service/pull/42',
    failureCategory: null,
    failureMessage: null,
    createdAt: NOW,
    completedAt: NOW,
    ...overrides,
  };
}

describe('computeRunStatus — stage derivation', () => {
  it('reports queued when no selection exists yet', () => {
    const status = computeRunStatus({ run: run(), selection: null, review: null, execution: null, publication: null, deployment: null });
    assert.equal(status.stage, 'queued');
    assert.equal(status.humanActionRequired, false);
  });

  it('reports repository_selection and requires human action for a pending selection', () => {
    const status = computeRunStatus({ run: run(), selection: selection({ status: 'pending' }), review: null, execution: null, publication: null, deployment: null });
    assert.equal(status.stage, 'repository_selection');
    assert.equal(status.humanActionRequired, true);
  });

  it('reports repository_selection for an ambiguous selection too', () => {
    const status = computeRunStatus({ run: run(), selection: selection({ status: 'ambiguous' }), review: null, execution: null, publication: null, deployment: null });
    assert.equal(status.stage, 'repository_selection');
  });

  it('reports repository_selection_failed with the failure reason', () => {
    const status = computeRunStatus({ run: run(), selection: selection({ status: 'failed', failureReason: 'no candidates' }), review: null, execution: null, publication: null, deployment: null });
    assert.equal(status.stage, 'repository_selection_failed');
    assert.equal(status.failureMessage, 'no candidates');
  });

  it('reports repository_confirmed once selected, awaiting the Coding Agent trigger', () => {
    const status = computeRunStatus({ run: run(), selection: selection({ status: 'selected', confirmedBy: 'operator:alice' }), review: null, execution: null, publication: null, deployment: null });
    assert.equal(status.stage, 'repository_confirmed');
    assert.equal(status.humanActionRequired, false);
  });

  it('reports change_review and requires human action for a pending review', () => {
    const status = computeRunStatus({ run: run(), selection: selection({ status: 'selected' }), review: review({ status: 'pending' }), execution: null, publication: null, deployment: null });
    assert.equal(status.stage, 'change_review');
    assert.equal(status.humanActionRequired, true);
    assert.equal(status.repository?.owner, 'cloudfuze');
  });

  it('reports change_rejected for a rejected review, with no further human action pending', () => {
    const status = computeRunStatus({ run: run(), selection: selection({ status: 'selected' }), review: review({ status: 'rejected' }), execution: null, publication: null, deployment: null });
    assert.equal(status.stage, 'change_rejected');
    assert.equal(status.humanActionRequired, false);
  });

  it('reports executing for an approved review with no execution yet', () => {
    const status = computeRunStatus({ run: run(), selection: selection({ status: 'selected' }), review: review({ status: 'approved' }), execution: null, publication: null, deployment: null });
    assert.equal(status.stage, 'executing');
  });

  it('reports execution_failed with category and message', () => {
    const status = computeRunStatus({
      run: run(),
      selection: selection({ status: 'selected' }),
      review: review({ status: 'approved' }),
      execution: execution({ status: 'failed', failureCategory: 'stale_file', failureMessage: 'x changed' }),
      publication: null,
      deployment: null,
    });
    assert.equal(status.stage, 'execution_failed');
    assert.equal(status.failureCategory, 'stale_file');
  });

  it('reports publishing once execution succeeds, before a publication exists', () => {
    const status = computeRunStatus({
      run: run(),
      selection: selection({ status: 'selected' }),
      review: review({ status: 'approved' }),
      execution: execution({ status: 'succeeded' }),
      publication: null,
      deployment: null,
    });
    assert.equal(status.stage, 'publishing');
    assert.deepEqual(status.validationSummary, { tests: true, typecheck: true, build: true });
  });

  it('reports publish_failed with category and message', () => {
    const status = computeRunStatus({
      run: run(),
      selection: selection({ status: 'selected' }),
      review: review({ status: 'approved' }),
      execution: execution({ status: 'succeeded' }),
      publication: publication({ status: 'failed', pullRequestNumber: null, pullRequestUrl: null, failureCategory: 'branch_conflict', failureMessage: 'x' }),
      deployment: null,
    });
    assert.equal(status.stage, 'publish_failed');
    assert.equal(status.failureCategory, 'branch_conflict');
  });

  it('reports awaiting_human_merge with the PR reference once published — the terminal automated stage', () => {
    const status = computeRunStatus({
      run: run(),
      selection: selection({ status: 'selected' }),
      review: review({ status: 'approved' }),
      execution: execution({ status: 'succeeded' }),
      publication: publication(),
      deployment: null,
    });
    assert.equal(status.stage, 'awaiting_human_merge');
    assert.equal(status.humanActionRequired, true);
    assert.equal(status.pullRequestNumber, 42);
    assert.match(status.pullRequestUrl!, /\/pull\/42$/);
  });

  it('reports failed/cancelled directly from the run document, overriding everything else', () => {
    const failedStatus = computeRunStatus({ run: run({ status: 'failed' }), selection: selection({ status: 'selected' }), review: null, execution: null, publication: null, deployment: null });
    assert.equal(failedStatus.stage, 'failed');

    const cancelledStatus = computeRunStatus({ run: run({ status: 'cancelled' }), selection: null, review: null, execution: null, publication: null, deployment: null });
    assert.equal(cancelledStatus.stage, 'cancelled');
  });

  it('never includes a token, key, or Authorization-shaped field in its output', () => {
    const status = computeRunStatus({
      run: run(),
      selection: selection({ status: 'selected' }),
      review: review({ status: 'approved' }),
      execution: execution({ status: 'succeeded' }),
      publication: publication(),
      deployment: null,
    });
    const serialized = JSON.stringify(status).toLowerCase();
    assert.ok(!serialized.includes('token'));
    assert.ok(!serialized.includes('authorization'));
    assert.ok(!serialized.includes('private_key'));
  });
});
