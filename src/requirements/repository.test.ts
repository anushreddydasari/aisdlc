import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId, type Db } from 'mongodb';

import { createLogger } from '../logging/logger.ts';
import {
  RequirementsAnalysisNotFoundError,
  createRequirementsRepository,
  shouldRecordUsage,
  type RequirementsAnalysisDocument,
} from './repository.ts';
import type { RequirementsResult } from './analyzer.ts';

const logger = createLogger({ write: () => {} });

const RESULT: RequirementsResult = {
  summary: 'Login fails for SSO users',
  problemStatement: 'Users see a blank page.',
  functionalRequirements: ['The system shall address: blank page.'],
  acceptanceCriteria: ['Given bug, when requirement 1 is implemented, then ...'],
  assumptions: ['The ticket description reflects the complete scope of the request.'],
  risks: ['No open questions identified from the available ticket data.'],
  suggestedArea: 'AISDLC',
};

interface Harness {
  readonly db: Db;
  readonly store: RequirementsAnalysisDocument[];
  failNextInsertWithDuplicate(): void;
}

function harness(seed: RequirementsAnalysisDocument[] = []): Harness {
  const store = [...seed];
  let duplicateNext = false;

  const matches = (
    doc: RequirementsAnalysisDocument,
    filter: Record<string, unknown>,
  ): boolean =>
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
    async insertOne(document: RequirementsAnalysisDocument) {
      if (duplicateNext) {
        duplicateNext = false;
        // Models a concurrent writer landing between our findOne check and
        // this insert: its row appears in the store right as ours is refused.
        store.push({ ...document, _id: new ObjectId(), status: 'completed' });
        throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      }
      const _id = new ObjectId();
      store.push({ ...document, _id });
      return { insertedId: _id, acknowledged: true };
    },
    async findOneAndUpdate(
      filter: Record<string, unknown>,
      update: { $set: Partial<RequirementsAnalysisDocument>; $inc?: { attempts: number } },
    ) {
      const found = store.find((doc) => matches(doc, filter));
      if (!found) return null;
      Object.assign(found, update.$set);
      if (update.$inc) found.attempts += update.$inc.attempts;
      return { ...found };
    },
  };

  const db = { collection: () => collection } as unknown as Db;

  return {
    db,
    store,
    failNextInsertWithDuplicate(): void {
      duplicateNext = true;
    },
  };
}

describe('createPending', () => {
  it('creates a new pending row for a fresh intakeItemId', async () => {
    const { db, store } = harness();
    const repo = createRequirementsRepository(db, logger);
    const intakeItemId = new ObjectId();

    const result = await repo.createPending({
      intakeItemId,
      issueKey: 'CF-1',
      inputHash: 'hash-1',
    });

    assert.equal(result.created, true);
    assert.equal(result.document.status, 'pending');
    assert.equal(result.document.attempts, 0);
    assert.equal(store.length, 1);
  });

  it('is idempotent: a second call for the same intakeItemId returns the existing row', async () => {
    const { db, store } = harness();
    const repo = createRequirementsRepository(db, logger);
    const intakeItemId = new ObjectId();

    const first = await repo.createPending({ intakeItemId, issueKey: 'CF-1', inputHash: 'hash-1' });
    const second = await repo.createPending({ intakeItemId, issueKey: 'CF-1', inputHash: 'hash-1' });

    assert.equal(second.created, false);
    assert.equal(second.document._id!.toHexString(), first.document._id!.toHexString());
    assert.equal(store.length, 1, 'must not create a second row');
  });

  it('returns the winner when it loses an insert race', async () => {
    const { db, store, failNextInsertWithDuplicate } = harness();
    const repo = createRequirementsRepository(db, logger);
    const intakeItemId = new ObjectId();

    failNextInsertWithDuplicate();
    const result = await repo.createPending({ intakeItemId, issueKey: 'CF-1', inputHash: 'hash-1' });

    assert.equal(result.created, false);
    assert.equal(result.document.status, 'completed', 'should reflect the concurrent writer\'s row');
    assert.equal(store.length, 1, 'must not leave a second row behind');
  });
});

describe('markCompleted / markFailed', () => {
  it('marks a pending row completed and stores the result', async () => {
    const { db, store } = harness();
    const repo = createRequirementsRepository(db, logger);
    const intakeItemId = new ObjectId();
    await repo.createPending({ intakeItemId, issueKey: 'CF-1', inputHash: 'hash-1' });

    const completed = await repo.markCompleted(intakeItemId, {
      result: RESULT,
      inputHash: 'hash-1',
      agentVersion: 'stub-v1',
      now: new Date('2026-09-21T00:00:00.000Z'),
    });

    assert.equal(completed.status, 'completed');
    assert.deepEqual(completed.result, RESULT);
    assert.equal(completed.error, null);
    assert.equal(completed.attempts, 1);
    assert.equal(completed.completedAt?.toISOString(), '2026-09-21T00:00:00.000Z');
    assert.equal(store.length, 1, 'must update in place, not append');
  });

  it('marks a pending row failed and stores the error', async () => {
    const { db, store } = harness();
    const repo = createRequirementsRepository(db, logger);
    const intakeItemId = new ObjectId();
    await repo.createPending({ intakeItemId, issueKey: 'CF-1', inputHash: 'hash-1' });

    const failed = await repo.markFailed(intakeItemId, {
      message: 'missing description',
      inputHash: 'hash-1',
      agentVersion: 'stub-v1',
    });

    assert.equal(failed.status, 'failed');
    assert.equal(failed.result, null);
    assert.equal(failed.error?.message, 'missing description');
    assert.equal(failed.attempts, 1);
    assert.equal(store.length, 1);
  });

  it('a retry after failure updates the same row and increments attempts', async () => {
    const { db, store } = harness();
    const repo = createRequirementsRepository(db, logger);
    const intakeItemId = new ObjectId();
    await repo.createPending({ intakeItemId, issueKey: 'CF-1', inputHash: 'hash-1' });
    await repo.markFailed(intakeItemId, {
      message: 'boom',
      inputHash: 'hash-1',
      agentVersion: 'stub-v1',
    });

    const completed = await repo.markCompleted(intakeItemId, {
      result: RESULT,
      inputHash: 'hash-1',
      agentVersion: 'stub-v1',
    });

    assert.equal(completed.status, 'completed');
    assert.equal(completed.attempts, 2);
    assert.equal(store.length, 1);
  });

  it('throws RequirementsAnalysisNotFoundError when no row exists', async () => {
    const { db } = harness();
    const repo = createRequirementsRepository(db, logger);
    await assert.rejects(
      () =>
        repo.markCompleted(new ObjectId(), {
          result: RESULT,
          inputHash: 'hash-1',
          agentVersion: 'stub-v1',
        }),
      RequirementsAnalysisNotFoundError,
    );
  });
});

describe('findByIntakeItemId', () => {
  it('returns null when nothing has been created yet', async () => {
    const { db } = harness();
    const repo = createRequirementsRepository(db, logger);
    assert.equal(await repo.findByIntakeItemId(new ObjectId()), null);
  });

  it('returns the stored row', async () => {
    const { db } = harness();
    const repo = createRequirementsRepository(db, logger);
    const intakeItemId = new ObjectId();
    await repo.createPending({ intakeItemId, issueKey: 'CF-1', inputHash: 'hash-1' });

    const found = await repo.findByIntakeItemId(intakeItemId);
    assert.equal(found?.issueKey, 'CF-1');
  });
});

describe('recordUsage', () => {
  const USAGE = { promptTokens: 120, completionTokens: 45, totalTokens: 165 };

  it('attaches usage to an existing completed row without touching the result', async () => {
    const { db, store } = harness();
    const repo = createRequirementsRepository(db, logger);
    const intakeItemId = new ObjectId();
    await repo.createPending({ intakeItemId, issueKey: 'CF-1', inputHash: 'hash-1' });
    const completed = await repo.markCompleted(intakeItemId, {
      result: RESULT,
      inputHash: 'hash-1',
      agentVersion: 'openai-gpt-4.1',
    });

    const updated = await repo.recordUsage(intakeItemId, USAGE);

    assert.deepEqual(updated.usage, USAGE);
    assert.deepEqual(updated.result, RESULT);
    assert.equal(updated.status, 'completed');
    assert.equal(store.length, 1, 'must update in place, not append');

    // Full-document check (review point 2): recordUsage must touch ONLY
    // `usage` and `updatedAt`, nothing else about the analysis.
    const { usage: _u1, updatedAt: _t1, ...beforeRest } = completed;
    const { usage: _u2, updatedAt: _t2, ...afterRest } = updated;
    assert.deepEqual(afterRest, beforeRest, 'recordUsage changed a field other than usage/updatedAt');
  });

  it('defaults usage to null for a row that never had it recorded', async () => {
    const { db } = harness();
    const repo = createRequirementsRepository(db, logger);
    const intakeItemId = new ObjectId();
    const { document } = await repo.createPending({ intakeItemId, issueKey: 'CF-1', inputHash: 'hash-1' });
    assert.equal(document.usage, null);
  });

  it('throws RequirementsAnalysisNotFoundError when no row exists', async () => {
    const { db } = harness();
    const repo = createRequirementsRepository(db, logger);
    await assert.rejects(
      () => repo.recordUsage(new ObjectId(), USAGE),
      RequirementsAnalysisNotFoundError,
    );
  });
});

describe('shouldRecordUsage', () => {
  const USAGE = { promptTokens: 120, completionTokens: 45, totalTokens: 165 };

  it('is true only for a completed outcome with usage present', () => {
    assert.equal(shouldRecordUsage('completed', USAGE), true);
  });

  it('is false for completed with no usage (e.g. the deterministic stub ran)', () => {
    assert.equal(shouldRecordUsage('completed', undefined), false);
  });

  it('is false for skipped_up_to_date, even if usage were somehow present', () => {
    // Can't actually happen (the analyzer is never called on a skip), but
    // the rule itself must not depend on that — it must gate on outcome.
    assert.equal(shouldRecordUsage('skipped_up_to_date', USAGE), false);
    assert.equal(shouldRecordUsage('skipped_up_to_date', undefined), false);
  });

  it('is false for failed_validation', () => {
    assert.equal(shouldRecordUsage('failed_validation', USAGE), false);
    assert.equal(shouldRecordUsage('failed_validation', undefined), false);
  });

  it('is false for failed_analysis, even when usage was captured before the failure', () => {
    // The real scenario this guards: openai-analyzer.ts logs and hands off
    // usage BEFORE validating the tool call, so a malformed response can
    // still have fired onUsage right before the analyzer throws.
    assert.equal(shouldRecordUsage('failed_analysis', USAGE), false);
  });
});
