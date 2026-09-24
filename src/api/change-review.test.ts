import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import type { IncomingMessage } from 'node:http';
import { ObjectId } from 'mongodb';

import {
  ReviewDecisionRequiresOperatorError,
  ReviewNotFoundError,
  ReviewNotPendingError,
  type ChangeReviewDocument,
  type ChangeReviewRepository,
  type ReviewDecisionInput,
} from '../change-execution/review-repository.ts';
import type { ImplementationPlan } from '../change-execution/types.ts';
import { createLogger } from '../logging/logger.ts';
import { BEARER_PREFIX } from './operator-auth.ts';
import { handleChangeReviewDecision, type ChangeReviewDeps } from './change-review.ts';

const TOKEN = 'op_test_token_value_not_real'; // pragma: fixture
const NOW = new Date('2026-09-23T00:00:00.000Z');
const REVIEW_ID = new ObjectId();

function request(body: Record<string, unknown> | Buffer | null, headers: Record<string, string | undefined> = {}): IncomingMessage {
  const buf = body === null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const stream = Readable.from([buf]) as unknown as IncomingMessage;
  stream.headers = { authorization: `${BEARER_PREFIX}${TOKEN}`, ...headers } as IncomingMessage['headers'];
  return stream;
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

function review(overrides: Partial<ChangeReviewDocument> = {}): ChangeReviewDocument {
  return {
    _id: REVIEW_ID,
    runId: new ObjectId(),
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

interface Harness {
  readonly deps: ChangeReviewDeps;
  readonly decisions: { id: string; options: ReviewDecisionInput }[];
}

function harness(
  options: { token?: string | undefined; noDatabase?: boolean; item?: ChangeReviewDocument; throwOn?: 'not_found' | 'not_pending' | 'operator_missing' | 'unexpected' } = {},
): Harness {
  const decisions: Harness['decisions'] = [];
  const stored = options.item ?? review();

  async function decide(id: ObjectId, opts: ReviewDecisionInput, to: 'approved' | 'rejected'): Promise<ChangeReviewDocument> {
    decisions.push({ id: id.toHexString(), options: opts });
    if (options.throwOn === 'not_found') throw new ReviewNotFoundError(id.toHexString());
    if (options.throwOn === 'not_pending') throw new ReviewNotPendingError(id.toHexString(), 'approved');
    if (options.throwOn === 'operator_missing') throw new ReviewDecisionRequiresOperatorError(opts.actor);
    if (options.throwOn === 'unexpected') throw new Error('mongo exploded');
    return { ...stored, status: to, reviewedBy: opts.actor, reviewedAt: NOW, reviewComment: opts.comment ?? null };
  }

  const reviews: ChangeReviewRepository = {
    async createIfAbsent() {
      throw new Error('not used by this handler');
    },
    async findById() {
      return stored;
    },
    async findLatestByRunId() {
      return stored;
    },
    async approve(id, opts) {
      return decide(id, opts, 'approved');
    },
    async reject(id, opts) {
      return decide(id, opts, 'rejected');
    },
    async findApproved() {
      return [];
    },
  };

  return {
    deps: {
      logger: createLogger({ write: () => {} }),
      operatorToken: 'token' in options ? options.token : TOKEN,
      reviews: options.noDatabase ? undefined : reviews,
    },
    decisions,
  };
}

describe('handleChangeReviewDecision — authorization', () => {
  it('rejects a request with no bearer token', async () => {
    const h = harness();
    const result = await handleChangeReviewDecision(request({ operator: 'alice' }, { authorization: '' }), h.deps, REVIEW_ID.toHexString(), 'approve');
    assert.equal(result.statusCode, 401);
  });

  it('rejects a request when OPERATOR_TOKEN is not configured', async () => {
    const h = harness({ token: undefined });
    const result = await handleChangeReviewDecision(request({ operator: 'alice' }), h.deps, REVIEW_ID.toHexString(), 'approve');
    assert.equal(result.statusCode, 401);
  });

  it('never reads the body when unauthorized', async () => {
    const h = harness();
    await handleChangeReviewDecision(request({ operator: 'alice' }, { authorization: 'Bearer wrong' }), h.deps, REVIEW_ID.toHexString(), 'approve');
    assert.equal(h.decisions.length, 0);
  });
});

describe('handleChangeReviewDecision — approve', () => {
  it('approves a pending review, naming the operator', async () => {
    const h = harness();
    const result = await handleChangeReviewDecision(request({ operator: 'alice' }), h.deps, REVIEW_ID.toHexString(), 'approve');

    assert.equal(result.statusCode, 200);
    assert.equal(result.body['status'], 'approved');
    assert.equal(h.decisions[0]!.options.actor, 'operator:alice');
  });

  it('accepts an optional comment', async () => {
    const h = harness();
    const result = await handleChangeReviewDecision(request({ operator: 'alice', comment: 'looks good' }), h.deps, REVIEW_ID.toHexString(), 'approve');
    assert.equal(result.statusCode, 200);
    assert.equal(h.decisions[0]!.options.comment, 'looks good');
  });

  it('rejects a request with no operator field', async () => {
    const h = harness();
    const result = await handleChangeReviewDecision(request({}), h.deps, REVIEW_ID.toHexString(), 'approve');
    assert.equal(result.statusCode, 400);
  });

  it('rejects an invalid reviewId', async () => {
    const h = harness();
    const result = await handleChangeReviewDecision(request({ operator: 'alice' }), h.deps, 'not-an-object-id', 'approve');
    assert.equal(result.statusCode, 400);
  });

  it('maps ReviewNotFoundError to 404', async () => {
    const h = harness({ throwOn: 'not_found' });
    const result = await handleChangeReviewDecision(request({ operator: 'alice' }), h.deps, REVIEW_ID.toHexString(), 'approve');
    assert.equal(result.statusCode, 404);
  });

  it('maps ReviewNotPendingError to 409 (duplicate approval)', async () => {
    const h = harness({ throwOn: 'not_pending' });
    const result = await handleChangeReviewDecision(request({ operator: 'alice' }), h.deps, REVIEW_ID.toHexString(), 'approve');
    assert.equal(result.statusCode, 409);
  });

  it('returns 503 when the database is unavailable', async () => {
    const h = harness({ noDatabase: true });
    const result = await handleChangeReviewDecision(request({ operator: 'alice' }), h.deps, REVIEW_ID.toHexString(), 'approve');
    assert.equal(result.statusCode, 503);
  });
});

describe('handleChangeReviewDecision — reject', () => {
  it('rejects a pending review, naming the operator', async () => {
    const h = harness();
    const result = await handleChangeReviewDecision(request({ operator: 'bob', comment: 'wrong approach' }), h.deps, REVIEW_ID.toHexString(), 'reject');

    assert.equal(result.statusCode, 200);
    assert.equal(result.body['status'], 'rejected');
    assert.equal(h.decisions[0]!.options.actor, 'operator:bob');
  });
});
