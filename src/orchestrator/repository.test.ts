import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId, type Db } from 'mongodb';

import { createLogger } from '../logging/logger.ts';
import { createRunsRepository, type RunDocument } from './repository.ts';

const logger = createLogger({ write: () => {} });

interface Harness {
  readonly db: Db;
  readonly store: RunDocument[];
  failNextInsertWithDuplicate(): void;
}

function harness(seed: RunDocument[] = []): Harness {
  const store = [...seed];
  let duplicateNext = false;

  const matches = (doc: RunDocument, filter: Record<string, unknown>): boolean =>
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
    async insertOne(document: RunDocument) {
      if (duplicateNext) {
        duplicateNext = false;
        // Models a concurrent orchestrator pass landing between our findOne
        // check and this insert: its row appears right as ours is refused.
        store.push({ ...document, _id: new ObjectId(), status: 'queued' });
        throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      }
      const _id = new ObjectId();
      store.push({ ...document, _id });
      return { insertedId: _id, acknowledged: true };
    },
    find(filter: Record<string, unknown> = {}) {
      const results = store.filter((doc) => matches(doc, filter)).map((doc) => ({ ...doc }));
      return {
        sort() {
          return this;
        },
        limit() {
          return this;
        },
        async toArray() {
          return results;
        },
      };
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

describe('createIfAbsent', () => {
  it('creates a new queued run for a fresh intakeItemId', async () => {
    const { db, store } = harness();
    const repo = createRunsRepository(db, logger);
    const intakeItemId = new ObjectId();

    const result = await repo.createIfAbsent({ intakeItemId, issueKey: 'CF-1', trigger: 'approval' });

    assert.equal(result.created, true);
    assert.equal(result.run.status, 'queued');
    assert.equal(result.run.trigger, 'approval');
    assert.equal(result.run.startedAt, null);
    assert.equal(result.run.completedAt, null);
    assert.equal(store.length, 1);
  });

  it('is idempotent: a second call for the same intakeItemId returns the existing run', async () => {
    const { db, store } = harness();
    const repo = createRunsRepository(db, logger);
    const intakeItemId = new ObjectId();

    const first = await repo.createIfAbsent({ intakeItemId, issueKey: 'CF-1', trigger: 'approval' });
    const second = await repo.createIfAbsent({ intakeItemId, issueKey: 'CF-1', trigger: 'approval' });

    assert.equal(second.created, false);
    assert.equal(second.run._id!.toHexString(), first.run._id!.toHexString());
    assert.equal(store.length, 1, 'must not create a second run');
  });

  it('returns the winner when it loses an insert race', async () => {
    const { db, store, failNextInsertWithDuplicate } = harness();
    const repo = createRunsRepository(db, logger);
    const intakeItemId = new ObjectId();

    failNextInsertWithDuplicate();
    const result = await repo.createIfAbsent({ intakeItemId, issueKey: 'CF-1', trigger: 'approval' });

    assert.equal(result.created, false);
    assert.equal(store.length, 1, 'must not leave a second row behind');
  });

  it('rethrows an insert error that is not a duplicate key', async () => {
    const { db } = harness();
    const collection = {
      async findOne() {
        return null;
      },
      async insertOne() {
        throw Object.assign(new Error('not authorized'), { code: 13 });
      },
    };
    const brokenDb = { collection: () => collection } as unknown as Db;
    const repo = createRunsRepository(brokenDb, logger);

    await assert.rejects(
      () => repo.createIfAbsent({ intakeItemId: new ObjectId(), issueKey: 'CF-1', trigger: 'approval' }),
      /not authorized/,
    );
  });
});

describe('findByIntakeItemId', () => {
  it('returns null when nothing has been created yet', async () => {
    const { db } = harness();
    const repo = createRunsRepository(db, logger);
    assert.equal(await repo.findByIntakeItemId(new ObjectId()), null);
  });

  it('returns the stored run', async () => {
    const { db } = harness();
    const repo = createRunsRepository(db, logger);
    const intakeItemId = new ObjectId();
    await repo.createIfAbsent({ intakeItemId, issueKey: 'CF-1', trigger: 'approval' });

    const found = await repo.findByIntakeItemId(intakeItemId);
    assert.equal(found?.issueKey, 'CF-1');
  });
});

describe('findById', () => {
  it('returns null when nothing has been created yet', async () => {
    const { db } = harness();
    const repo = createRunsRepository(db, logger);
    assert.equal(await repo.findById(new ObjectId()), null);
  });

  it('returns the stored run by its own _id', async () => {
    const { db } = harness();
    const repo = createRunsRepository(db, logger);
    const intakeItemId = new ObjectId();
    const { run } = await repo.createIfAbsent({ intakeItemId, issueKey: 'CF-1', trigger: 'approval' });

    const found = await repo.findById(run._id!);
    assert.equal(found?.issueKey, 'CF-1');
  });
});

describe('list', () => {
  it('returns every run matching the filter', async () => {
    const { db } = harness();
    const repo = createRunsRepository(db, logger);
    await repo.createIfAbsent({ intakeItemId: new ObjectId(), issueKey: 'CF-1', trigger: 'approval' });
    await repo.createIfAbsent({ intakeItemId: new ObjectId(), issueKey: 'CF-2', trigger: 'approval' });

    const all = await repo.list();
    assert.equal(all.length, 2);

    const filtered = await repo.list({ status: 'queued' });
    assert.equal(filtered.length, 2);
  });
});
