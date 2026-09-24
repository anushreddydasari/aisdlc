import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId, type Db } from 'mongodb';

import type { AuditEntryInput, AuditLog } from '../db/audit-log.ts';
import { createLogger } from '../logging/logger.ts';
import { createChangeExecutionRepository, type ChangeExecutionDocument, type RecordExecutionInput } from './execution-repository.ts';

const RUN_ID = new ObjectId();
const REVIEW_ID = new ObjectId();

const SUCCESS_INPUT: RecordExecutionInput = {
  runId: RUN_ID,
  reviewId: REVIEW_ID,
  proposalHash: 'a'.repeat(64),
  status: 'succeeded',
  appliedChanges: [{ path: 'src/index.ts', operation: 'modify' }],
  validation: {
    tests: { ok: true, summary: 'mock: tests passed' },
    typecheck: { ok: true, summary: 'mock: typecheck passed' },
    build: { ok: true, summary: 'mock: build passed' },
  },
  failureCategory: null,
  failureMessage: null,
};

interface Harness {
  readonly db: Db;
  readonly audit: AuditLog;
  readonly auditEntries: AuditEntryInput[];
  readonly store: ChangeExecutionDocument[];
}

function harness(seed: ChangeExecutionDocument[] = []): Harness {
  const store = [...seed];
  const auditEntries: AuditEntryInput[] = [];

  const matches = (doc: ChangeExecutionDocument, filter: Record<string, unknown>): boolean =>
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
    async insertOne(document: ChangeExecutionDocument) {
      if (store.some((doc) => doc.reviewId.equals(document.reviewId))) {
        throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      }
      const _id = document._id ?? new ObjectId();
      store.push({ ...document, _id });
      return { insertedId: _id };
    },
    find(filter: Record<string, unknown> = {}) {
      const results = store.filter((doc) => matches(doc, filter)).map((doc) => ({ ...doc }));
      const cursor = {
        sort(spec: Record<string, 1 | -1>) {
          const [field, direction] = Object.entries(spec)[0] as [string, 1 | -1];
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
  it('records a successful execution and audits change-execution.completed', async () => {
    const h = harness();
    const repo = createChangeExecutionRepository(h.db, h.audit, logger);
    const { execution, created } = await repo.createIfAbsent(SUCCESS_INPUT);

    assert.equal(created, true);
    assert.equal(execution.status, 'succeeded');
    assert.deepEqual(execution.appliedChanges, SUCCESS_INPUT.appliedChanges);
    assert.equal(h.auditEntries.length, 1);
    assert.equal(h.auditEntries[0]!.action, 'change-execution.completed');
  });

  it('records a failed execution and audits change-execution.failed', async () => {
    const h = harness();
    const repo = createChangeExecutionRepository(h.db, h.audit, logger);
    const { execution } = await repo.createIfAbsent({
      ...SUCCESS_INPUT,
      status: 'failed',
      validation: null,
      failureCategory: 'stale_file',
      failureMessage: "'src/index.ts' has changed since review",
    });

    assert.equal(execution.status, 'failed');
    assert.equal(execution.failureCategory, 'stale_file');
    assert.equal(h.auditEntries[0]!.action, 'change-execution.failed');
    assert.equal((h.auditEntries[0]!.detail as Record<string, unknown>)['failureCategory'], 'stale_file');
  });

  it('is idempotent on reviewId: a second attempt returns the first recorded row unchanged', async () => {
    const h = harness();
    const repo = createChangeExecutionRepository(h.db, h.audit, logger);
    const first = await repo.createIfAbsent(SUCCESS_INPUT);
    const second = await repo.createIfAbsent({
      ...SUCCESS_INPUT,
      // A different outcome offered on the "second attempt" — must be
      // ignored; the FIRST recorded row is the durable source of truth.
      status: 'failed',
      failureCategory: 'apply_failed',
      failureMessage: 'should never be recorded',
    });

    assert.equal(second.created, false);
    assert.equal(second.execution.status, 'succeeded');
    assert.ok(second.execution._id!.equals(first.execution._id!));
    assert.equal(h.store.length, 1);
    assert.equal(h.auditEntries.length, 1, 'no audit entry for a duplicate execution attempt');
  });
});

describe('findByReviewId', () => {
  it('returns null when no execution has been recorded', async () => {
    const h = harness();
    const repo = createChangeExecutionRepository(h.db, h.audit, logger);
    assert.equal(await repo.findByReviewId(new ObjectId()), null);
  });

  it('returns the recorded execution for a review', async () => {
    const h = harness();
    const repo = createChangeExecutionRepository(h.db, h.audit, logger);
    const { execution } = await repo.createIfAbsent(SUCCESS_INPUT);

    const found = await repo.findByReviewId(REVIEW_ID);
    assert.ok(found !== null);
    assert.ok(found._id!.equals(execution._id!));
  });
});

describe('findById', () => {
  it('returns null for an unknown id', async () => {
    const h = harness();
    const repo = createChangeExecutionRepository(h.db, h.audit, logger);
    assert.equal(await repo.findById(new ObjectId()), null);
  });

  it('returns the execution by its own id — used by github-publish/, which is handed an executionId directly', async () => {
    const h = harness();
    const repo = createChangeExecutionRepository(h.db, h.audit, logger);
    const { execution } = await repo.createIfAbsent(SUCCESS_INPUT);

    const found = await repo.findById(execution._id!);
    assert.ok(found !== null);
    assert.ok(found.reviewId.equals(REVIEW_ID));
  });
});

describe('findSucceeded', () => {
  it('returns only executions currently in the succeeded status', async () => {
    const h = harness();
    const repo = createChangeExecutionRepository(h.db, h.audit, logger);
    const { execution } = await repo.createIfAbsent(SUCCESS_INPUT);
    const failedReviewId = new ObjectId();
    await repo.createIfAbsent({
      ...SUCCESS_INPUT,
      reviewId: failedReviewId,
      status: 'failed',
      validation: null,
      failureCategory: 'stale_file',
      failureMessage: 'x',
    });

    const succeeded = await repo.findSucceeded();
    assert.equal(succeeded.length, 1);
    assert.ok(succeeded[0]!._id!.equals(execution._id!));
  });

  it('returns an empty array when nothing has succeeded', async () => {
    const h = harness();
    const repo = createChangeExecutionRepository(h.db, h.audit, logger);
    await repo.createIfAbsent({ ...SUCCESS_INPUT, status: 'failed', validation: null, failureCategory: 'apply_failed', failureMessage: 'x' });
    assert.deepEqual(await repo.findSucceeded(), []);
  });
});
