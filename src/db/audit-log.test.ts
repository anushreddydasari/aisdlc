import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId, type Collection, type Db } from 'mongodb';

import {
  AuditLogMutationError,
  FORBIDDEN_AUDIT_METHODS,
  createAuditLog,
  guardAuditCollection,
  type AuditEntryDocument,
} from './audit-log.ts';
import { createLogger } from '../logging/logger.ts';

const logger = createLogger({ write: () => {} });

interface Recorded {
  inserted: AuditEntryDocument[];
  findCalls: unknown[];
  sorted: unknown[];
  limits: number[];
}

function fakeCollection(): { collection: Collection<AuditEntryDocument>; recorded: Recorded } {
  const recorded: Recorded = { inserted: [], findCalls: [], sorted: [], limits: [] };

  const cursor = {
    sort(spec: unknown) {
      recorded.sorted.push(spec);
      return cursor;
    },
    limit(n: number) {
      recorded.limits.push(n);
      return cursor;
    },
    toArray: async () => recorded.inserted,
  };

  const collection = {
    async insertOne(document: AuditEntryDocument) {
      recorded.inserted.push(document);
      return { insertedId: new ObjectId(), acknowledged: true };
    },
    find(filter: unknown) {
      recorded.findCalls.push(filter);
      return cursor;
    },
    async updateOne() {
      return {};
    },
    async deleteMany() {
      return {};
    },
    async drop() {
      return true;
    },
    collectionName: 'auditLog',
  } as unknown as Collection<AuditEntryDocument>;

  return { collection, recorded };
}

function fakeDb(collection: Collection<AuditEntryDocument>): Db {
  return { collection: () => collection } as unknown as Db;
}

describe('guardAuditCollection', () => {
  it('throws on every mutating method', () => {
    const { collection } = fakeCollection();
    const guarded = guardAuditCollection(collection) as unknown as Record<string, () => unknown>;

    for (const method of FORBIDDEN_AUDIT_METHODS) {
      assert.throws(
        () => guarded[method]!(),
        (error: unknown) => {
          assert.ok(error instanceof AuditLogMutationError, `${method} did not throw`);
          assert.equal(error.method, method);
          return true;
        },
        `${method} should be blocked`,
      );
    }
  });

  it('blocks deletes and rewrites specifically', () => {
    const { collection, recorded } = fakeCollection();
    const guarded = guardAuditCollection(collection);

    assert.throws(() => guarded.deleteMany({}), AuditLogMutationError);
    assert.throws(() => guarded.updateOne({}, {}), AuditLogMutationError);
    assert.throws(() => guarded.drop(), AuditLogMutationError);
    // Nothing reached the underlying collection.
    assert.equal(recorded.inserted.length, 0);
  });

  it('still allows append and read', async () => {
    const { collection, recorded } = fakeCollection();
    const guarded = guardAuditCollection(collection);

    await guarded.insertOne({
      occurredAt: new Date(),
      actor: 'a',
      action: 'b',
      subjectType: 'run',
      subjectId: new ObjectId(),
    });
    assert.equal(recorded.inserted.length, 1);
    assert.ok(guarded.find({}));
  });

  it('passes non-method properties through', () => {
    const { collection } = fakeCollection();
    assert.equal(guardAuditCollection(collection).collectionName, 'auditLog');
  });

  it('names the method in the error, so the fix is obvious', () => {
    const { collection } = fakeCollection();
    assert.throws(() => guardAuditCollection(collection).deleteOne({}), (error: unknown) => {
      assert.ok(error instanceof AuditLogMutationError);
      assert.match(error.message, /append-only/);
      assert.match(error.message, /deleteOne/);
      return true;
    });
  });
});

describe('createAuditLog', () => {
  it('exposes no mutation surface at all', () => {
    const { collection } = fakeCollection();
    const audit = createAuditLog(fakeDb(collection), logger);

    // If a delete method ever appears here, the compile-time guarantee is gone.
    assert.deepEqual(Object.keys(audit).sort(), ['append', 'query']);
  });

  it('appends an entry with a default occurredAt', async () => {
    const { collection, recorded } = fakeCollection();
    const audit = createAuditLog(fakeDb(collection), logger);
    const subjectId = new ObjectId();

    const before = Date.now();
    const id = await audit.append({
      actor: 'operator:anush',
      action: 'intake.approved',
      subjectType: 'intakeItem',
      subjectId,
    });

    assert.ok(id instanceof ObjectId);
    const [entry] = recorded.inserted;
    assert.ok(entry);
    assert.equal(entry.actor, 'operator:anush');
    assert.equal(entry.action, 'intake.approved');
    assert.equal(entry.subjectType, 'intakeItem');
    assert.equal(entry.subjectId, subjectId);
    assert.ok(entry.occurredAt.getTime() >= before);
  });

  it('honours an explicit occurredAt', async () => {
    const { collection, recorded } = fakeCollection();
    const audit = createAuditLog(fakeDb(collection), logger);
    const occurredAt = new Date('2026-09-20T00:00:00.000Z');

    await audit.append({
      actor: 'svc:worker',
      action: 'run.started',
      subjectType: 'run',
      subjectId: new ObjectId(),
      occurredAt,
    });

    assert.equal(recorded.inserted[0]!.occurredAt, occurredAt);
  });

  it('omits detail entirely when not supplied', async () => {
    const { collection, recorded } = fakeCollection();
    const audit = createAuditLog(fakeDb(collection), logger);

    await audit.append({
      actor: 'svc:worker',
      action: 'run.started',
      subjectType: 'run',
      subjectId: new ObjectId(),
    });

    // The validator types `detail` as an object; an explicit undefined would
    // be stored as null and fail strict validation.
    assert.ok(!('detail' in recorded.inserted[0]!));
  });

  it('rejects an empty actor or action before reaching the server', async () => {
    const { collection } = fakeCollection();
    const audit = createAuditLog(fakeDb(collection), logger);
    const base = { subjectType: 'run', subjectId: new ObjectId() } as const;

    await assert.rejects(
      () => audit.append({ ...base, actor: '   ', action: 'run.started' }),
      /missing actor/,
    );
    await assert.rejects(
      () => audit.append({ ...base, actor: 'svc:worker', action: '' }),
      /missing action/,
    );
  });

  it('returns entries newest first', async () => {
    const { collection, recorded } = fakeCollection();
    const audit = createAuditLog(fakeDb(collection), logger);

    await audit.query({ subjectType: 'run' }, 25);
    assert.deepEqual(recorded.findCalls[0], { subjectType: 'run' });
    assert.deepEqual(recorded.sorted[0], { occurredAt: -1 });
    assert.deepEqual(recorded.limits[0], 25);
  });

  it('defaults to a bounded query', async () => {
    const { collection, recorded } = fakeCollection();
    const audit = createAuditLog(fakeDb(collection), logger);

    await audit.query();
    // An unbounded audit query would be a memory hazard as history grows.
    assert.equal(recorded.limits[0], 100);
  });
});
