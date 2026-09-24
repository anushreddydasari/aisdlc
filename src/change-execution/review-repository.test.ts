import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId, type Db } from 'mongodb';

import type { AuditEntryInput, AuditLog } from '../db/audit-log.ts';
import { createLogger } from '../logging/logger.ts';
import {
  ReviewDecisionRequiresOperatorError,
  ReviewNotFoundError,
  ReviewNotPendingError,
  createChangeReviewRepository,
  type ChangeReviewDocument,
} from './review-repository.ts';
import type { ImplementationPlan, ProposedChange } from './types.ts';

const NOW = new Date('2026-09-22T00:00:00.000Z');
const RUN_ID = new ObjectId();
const INTAKE_ITEM_ID = new ObjectId();

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

const CHANGES: ProposedChange[] = [
  {
    filePath: 'src/index.ts',
    operation: 'modify',
    originalContentHash: 'abc123',
    proposedContent: 'export {};',
    reason: 'r',
    relatedPlanItemId: 'item-1',
  },
];

const CREATE_INPUT = {
  runId: RUN_ID,
  intakeItemId: INTAKE_ITEM_ID,
  repositoryId: 'aisdlc-service',
  owner: 'cloudfuze',
  repo: 'aisdlc-service',
  branch: 'main',
  plan: PLAN,
  proposedChanges: CHANGES,
};

interface Harness {
  readonly db: Db;
  readonly audit: AuditLog;
  readonly auditEntries: AuditEntryInput[];
  readonly store: ChangeReviewDocument[];
}

function harness(seed: ChangeReviewDocument[] = []): Harness {
  const store = [...seed];
  const auditEntries: AuditEntryInput[] = [];

  const matches = (doc: ChangeReviewDocument, filter: Record<string, unknown>): boolean =>
    Object.entries(filter).every(([key, value]) => {
      const actual = (doc as unknown as Record<string, unknown>)[key];
      if (value instanceof ObjectId) return actual instanceof ObjectId && actual.equals(value);
      return actual === value;
    });

  const collection = {
    async findOne(filter: Record<string, unknown>) {
      const found = store.find((doc) => matches(doc, filter));
      return found ? { ...found } : null;
    },
    find(filter: Record<string, unknown> = {}) {
      const results = store.filter((doc) => matches(doc, filter)).map((doc) => ({ ...doc }));
      const cursor = {
        sort(spec: Record<string, 1 | -1>) {
          const entry = Object.entries(spec)[0] as [string, 1 | -1];
          const [field, direction] = entry;
          results.sort((a, b) => {
            const av = (a as unknown as Record<string, Date>)[field]!.getTime();
            const bv = (b as unknown as Record<string, Date>)[field]!.getTime();
            return direction === 1 ? av - bv : bv - av;
          });
          return cursor;
        },
        limit(n: number) {
          results.length = Math.min(results.length, n);
          return cursor;
        },
        async toArray() {
          return results;
        },
      };
      return cursor;
    },
    async insertOne(document: ChangeReviewDocument) {
      if (store.some((doc) => doc.proposalHash === document.proposalHash)) {
        throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      }
      const _id = document._id ?? new ObjectId();
      store.push({ ...document, _id });
      return { insertedId: _id };
    },
    async findOneAndUpdate(filter: Record<string, unknown>, update: { $set: Partial<ChangeReviewDocument> }) {
      const found = store.find((doc) => matches(doc, filter));
      if (!found) return null;
      Object.assign(found, update.$set);
      return { ...found };
    },
  };

  const db = { collection: () => collection } as unknown as Db;

  const audit: AuditLog = {
    async append(entry: AuditEntryInput) {
      auditEntries.push(entry);
      return new ObjectId();
    },
    async query() {
      return [];
    },
  };

  return { db, audit, auditEntries, store };
}

const logger = createLogger({ write: () => {} });

describe('createIfAbsent', () => {
  it('creates a pending review with a computed proposalHash', async () => {
    const h = harness();
    const repo = createChangeReviewRepository(h.db, h.audit, logger);
    const { review, created } = await repo.createIfAbsent(CREATE_INPUT);

    assert.equal(created, true);
    assert.equal(review.status, 'pending');
    assert.equal(review.reviewedBy, null);
    assert.equal(review.reviewedAt, null);
    assert.match(review.proposalHash, /^[0-9a-f]{64}$/);
    assert.equal(h.auditEntries.length, 1);
    assert.equal(h.auditEntries[0]!.action, 'change-review.created');
    assert.equal(h.auditEntries[0]!.subjectType, 'changeReview');
  });

  it('is idempotent on proposal content: identical content returns the existing row', async () => {
    const h = harness();
    const repo = createChangeReviewRepository(h.db, h.audit, logger);
    const first = await repo.createIfAbsent(CREATE_INPUT);
    const second = await repo.createIfAbsent(CREATE_INPUT);

    assert.equal(second.created, false);
    assert.ok(second.review._id!.equals(first.review._id!));
    assert.equal(h.store.length, 1);
    assert.equal(h.auditEntries.length, 1, 'no second audit entry for a duplicate proposal');
  });

  it('creates a second, distinct row for a regenerated proposal with different content', async () => {
    const h = harness();
    const repo = createChangeReviewRepository(h.db, h.audit, logger);
    const first = await repo.createIfAbsent(CREATE_INPUT);
    const second = await repo.createIfAbsent({
      ...CREATE_INPUT,
      plan: { ...PLAN, summary: 'A revised plan' },
    });

    assert.equal(second.created, true);
    assert.notEqual(first.review.proposalHash, second.review.proposalHash);
    assert.equal(h.store.length, 2);
  });
});

describe('findById / findLatestByRunId', () => {
  it('returns null for a missing id', async () => {
    const h = harness();
    const repo = createChangeReviewRepository(h.db, h.audit, logger);
    assert.equal(await repo.findById(new ObjectId()), null);
  });

  it('returns the most recently created review for a run', async () => {
    const h = harness();
    const repo = createChangeReviewRepository(h.db, h.audit, logger);
    const first = await repo.createIfAbsent(CREATE_INPUT);
    // A distinct proposal for the same run, created later. createdAt is
    // forced apart explicitly rather than relying on two `new Date()` calls
    // landing in different milliseconds, which is not guaranteed.
    const newer = await repo.createIfAbsent({ ...CREATE_INPUT, plan: { ...PLAN, summary: 'Newer plan' } });
    const firstStored = h.store.find((r) => r._id!.equals(first.review._id!))!;
    const newerStored = h.store.find((r) => r._id!.equals(newer.review._id!))!;
    firstStored.createdAt = new Date(NOW.getTime());
    newerStored.createdAt = new Date(NOW.getTime() + 1_000);

    const latest = await repo.findLatestByRunId(RUN_ID);
    assert.ok(latest !== null);
    assert.ok(latest._id!.equals(newer.review._id!));
  });

  it('returns null when the run has no reviews', async () => {
    const h = harness();
    const repo = createChangeReviewRepository(h.db, h.audit, logger);
    assert.equal(await repo.findLatestByRunId(new ObjectId()), null);
  });
});

describe('findApproved', () => {
  it('returns only reviews currently in the approved status', async () => {
    const h = harness();
    const repo = createChangeReviewRepository(h.db, h.audit, logger);
    const { review } = await repo.createIfAbsent(CREATE_INPUT);
    await repo.approve(review._id!, { actor: 'operator:alice' });
    const other = await repo.createIfAbsent({ ...CREATE_INPUT, plan: { ...PLAN, summary: 'still pending' } });

    const approved = await repo.findApproved();
    assert.equal(approved.length, 1);
    assert.ok(approved[0]!._id!.equals(review._id!));
    assert.ok(!approved.some((r) => r._id!.equals(other.review._id!)));
  });

  it('returns an empty array when nothing is approved', async () => {
    const h = harness();
    const repo = createChangeReviewRepository(h.db, h.audit, logger);
    await repo.createIfAbsent(CREATE_INPUT);
    assert.deepEqual(await repo.findApproved(), []);
  });
});

describe('approve', () => {
  it('refuses a non-operator actor without touching the store', async () => {
    const h = harness();
    const repo = createChangeReviewRepository(h.db, h.audit, logger);
    const { review } = await repo.createIfAbsent(CREATE_INPUT);

    await assert.rejects(
      () => repo.approve(review._id!, { actor: 'system:coding-agent' }),
      ReviewDecisionRequiresOperatorError,
    );
    const reread = await repo.findById(review._id!);
    assert.equal(reread!.status, 'pending', 'the Coding Agent must never approve its own changes');
  });

  it('refuses a missing reviewer identity', async () => {
    const h = harness();
    const repo = createChangeReviewRepository(h.db, h.audit, logger);
    const { review } = await repo.createIfAbsent(CREATE_INPUT);

    await assert.rejects(() => repo.approve(review._id!, { actor: '' }), ReviewDecisionRequiresOperatorError);
  });

  it('approves a pending review for an operator actor', async () => {
    const h = harness();
    const repo = createChangeReviewRepository(h.db, h.audit, logger);
    const { review } = await repo.createIfAbsent(CREATE_INPUT);

    const approved = await repo.approve(review._id!, { actor: 'operator:alice', comment: 'looks good' });

    assert.equal(approved.status, 'approved');
    assert.equal(approved.reviewedBy, 'operator:alice');
    assert.ok(approved.reviewedAt instanceof Date);
    assert.equal(approved.reviewComment, 'looks good');
    assert.equal(h.auditEntries.at(-1)!.action, 'change-review.approved');
    assert.equal(h.auditEntries.at(-1)!.actor, 'operator:alice');
  });

  it('throws ReviewNotFoundError for a missing review', async () => {
    const h = harness();
    const repo = createChangeReviewRepository(h.db, h.audit, logger);
    await assert.rejects(() => repo.approve(new ObjectId(), { actor: 'operator:alice' }), ReviewNotFoundError);
  });

  it('throws ReviewNotPendingError on duplicate approval', async () => {
    const h = harness();
    const repo = createChangeReviewRepository(h.db, h.audit, logger);
    const { review } = await repo.createIfAbsent(CREATE_INPUT);
    await repo.approve(review._id!, { actor: 'operator:alice' });

    await assert.rejects(() => repo.approve(review._id!, { actor: 'operator:bob' }), ReviewNotPendingError);
  });

  it('throws ReviewNotPendingError when approving an already-rejected review', async () => {
    const h = harness();
    const repo = createChangeReviewRepository(h.db, h.audit, logger);
    const { review } = await repo.createIfAbsent(CREATE_INPUT);
    await repo.reject(review._id!, { actor: 'operator:alice' });

    await assert.rejects(() => repo.approve(review._id!, { actor: 'operator:alice' }), ReviewNotPendingError);
  });
});

describe('reject', () => {
  it('rejects a pending review for an operator actor, leaving it usable for audit/history', async () => {
    const h = harness();
    const repo = createChangeReviewRepository(h.db, h.audit, logger);
    const { review } = await repo.createIfAbsent(CREATE_INPUT);

    const rejected = await repo.reject(review._id!, { actor: 'operator:alice', comment: 'wrong approach' });

    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.reviewedBy, 'operator:alice');
    assert.equal(rejected.reviewComment, 'wrong approach');
    assert.equal(h.auditEntries.at(-1)!.action, 'change-review.rejected');
    // The row itself is preserved, not deleted — see the module comment.
    assert.ok(await repo.findById(review._id!));
  });

  it('refuses a non-operator actor', async () => {
    const h = harness();
    const repo = createChangeReviewRepository(h.db, h.audit, logger);
    const { review } = await repo.createIfAbsent(CREATE_INPUT);

    await assert.rejects(
      () => repo.reject(review._id!, { actor: 'system:coding-agent' }),
      ReviewDecisionRequiresOperatorError,
    );
  });

  it('throws ReviewNotPendingError on duplicate rejection', async () => {
    const h = harness();
    const repo = createChangeReviewRepository(h.db, h.audit, logger);
    const { review } = await repo.createIfAbsent(CREATE_INPUT);
    await repo.reject(review._id!, { actor: 'operator:alice' });

    await assert.rejects(() => repo.reject(review._id!, { actor: 'operator:alice' }), ReviewNotPendingError);
  });
});
