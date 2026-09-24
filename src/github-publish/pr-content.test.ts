import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId } from 'mongodb';

import type { ChangeReviewDocument } from '../change-execution/review-repository.ts';
import type { ChangeExecutionDocument } from '../change-execution/execution-repository.ts';
import type { ImplementationPlan, ProposedChange } from '../change-execution/types.ts';
import { buildCommitMessage, buildPullRequestContent } from './pr-content.ts';

const NOW = new Date('2026-09-22T00:00:00.000Z');
const RUN_ID = new ObjectId();
const REVIEW_ID = new ObjectId();
const EXECUTION_ID = new ObjectId();

const SECRET_LOOKING_CONTENT = 'const apiKey = "sk-proj-should-never-appear-in-a-commit-message-or-pr-body";';

const PLAN: ImplementationPlan = {
  summary: 'Add a health field to the status endpoint',
  requirementsUnderstanding: 'The status endpoint is missing a health field the frontend now requires.',
  relevantFiles: ['src/index.ts'],
  items: [{ id: 'item-1', filePath: 'src/index.ts', operation: 'modify', changeDescription: 'add field' }],
  dependenciesAndImpact: [],
  testsRequired: [],
  assumptions: [],
  risks: [],
};

const CHANGES: ProposedChange[] = [
  {
    filePath: 'src/index.ts',
    operation: 'modify',
    originalContentHash: 'a'.repeat(64),
    proposedContent: SECRET_LOOKING_CONTENT,
    reason: 'r',
    relatedPlanItemId: 'item-1',
  },
];

function review(overrides: Partial<ChangeReviewDocument> = {}): ChangeReviewDocument {
  return {
    _id: REVIEW_ID,
    runId: RUN_ID,
    intakeItemId: new ObjectId(),
    repositoryId: 'aisdlc-service',
    owner: 'cloudfuze',
    repo: 'aisdlc-service',
    branch: 'main',
    plan: PLAN,
    proposedChanges: CHANGES,
    proposalHash: 'b'.repeat(64),
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
    proposalHash: 'b'.repeat(64),
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

const IDS = { runId: RUN_ID, reviewId: REVIEW_ID, executionId: EXECUTION_ID };

describe('buildCommitMessage', () => {
  it('references run, review, and execution identifiers', () => {
    const message = buildCommitMessage(review(), IDS);
    assert.match(message, new RegExp(`Run: ${RUN_ID.toHexString()}`));
    assert.match(message, new RegExp(`Review: ${REVIEW_ID.toHexString()}`));
    assert.match(message, new RegExp(`Execution: ${EXECUTION_ID.toHexString()}`));
  });

  it('starts with an AISDLC-prefixed subject line', () => {
    const message = buildCommitMessage(review(), IDS);
    assert.match(message, /^AISDLC: /);
  });

  it('never includes proposed file content', () => {
    const message = buildCommitMessage(review(), IDS);
    assert.ok(!message.includes(SECRET_LOOKING_CONTENT));
  });

  it('truncates an overlong plan summary rather than overflowing the subject line', () => {
    const longPlan = { ...PLAN, summary: 'x'.repeat(200) };
    const message = buildCommitMessage(review({ plan: longPlan }), IDS);
    const subjectLine = message.split('\n')[0]!;
    assert.ok(subjectLine.length <= 72);
  });
});

describe('buildPullRequestContent', () => {
  it('includes the plan summary in the title', () => {
    const { title } = buildPullRequestContent(review(), execution(), IDS);
    assert.match(title, /^AISDLC: /);
    assert.match(title, /health field/);
  });

  it('lists the applied file paths and operations', () => {
    const { body } = buildPullRequestContent(review(), execution(), IDS);
    assert.match(body, /`modify`: `src\/index\.ts`/);
  });

  it('includes validation results for tests, typecheck, and build', () => {
    const { body } = buildPullRequestContent(review(), execution(), IDS);
    assert.match(body, /Tests: ✅ passed/);
    assert.match(body, /Typecheck: ✅ passed/);
    assert.match(body, /Build: ✅ passed/);
  });

  it('reports a failing validation step honestly, not as passed', () => {
    const failedExecution = execution({
      validation: {
        tests: { ok: false, summary: 'mock: tests failed' },
        typecheck: { ok: true, summary: 'mock: typecheck passed' },
        build: { ok: true, summary: 'mock: build passed' },
      },
    });
    const { body } = buildPullRequestContent(review(), failedExecution, IDS);
    assert.match(body, /Tests: ❌ failed/);
  });

  it('references run, review, and execution identifiers', () => {
    const { body } = buildPullRequestContent(review(), execution(), IDS);
    assert.match(body, new RegExp(RUN_ID.toHexString()));
    assert.match(body, new RegExp(REVIEW_ID.toHexString()));
    assert.match(body, new RegExp(EXECUTION_ID.toHexString()));
  });

  it('states the changes were generated through the approved AISDLC workflow', () => {
    const { body } = buildPullRequestContent(review(), execution(), IDS);
    assert.match(body, /AISDLC workflow/i);
    assert.match(body, /human-controlled/i);
  });

  it('never includes proposed file content, a token, or a credential-shaped string', () => {
    const { title, body } = buildPullRequestContent(review(), execution(), IDS);
    assert.ok(!title.includes(SECRET_LOOKING_CONTENT));
    assert.ok(!body.includes(SECRET_LOOKING_CONTENT));
    assert.ok(!body.includes('sk-proj-'));
  });
});
