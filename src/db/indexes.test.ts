import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Db, Document } from 'mongodb';

import { COLLECTION_NAMES, COLLECTIONS, INDEXES, allIndexes } from './collections.ts';
import { ensureIndex, initializeDatabase, isIndexConflict, isTtlOnlyChange } from './indexes.ts';
import { createLogger } from '../logging/logger.ts';

const logger = createLogger({ write: () => {} });

interface ExistingIndexSpec {
  name: string;
  key: Document;
  unique?: boolean;
  expireAfterSeconds?: number;
}

interface Recorded {
  readonly created: string[];
  readonly collModded: string[];
  readonly collModCommands: Document[];
  readonly indexes: { collection: string; name: string | undefined }[];
  readonly droppedIndexes: { collection: string; name: string }[];
}

interface FakeOptions {
  readonly existingCollections?: readonly string[];
  /** Index names that will reject a createIndex with IndexOptionsConflict. */
  readonly conflictingIndexes?: readonly string[];
  /** What listIndexes reports, keyed by collection. */
  readonly existingIndexes?: Readonly<Record<string, readonly ExistingIndexSpec[]>>;
}

/**
 * A stand-in for Db that records calls. Phase 0 has no Atlas connection, and
 * the behaviour worth testing is the reconciliation logic, not the driver.
 */
function fakeDb(options: FakeOptions = {}): { db: Db; recorded: Recorded } {
  const existingCollections = options.existingCollections ?? [];
  const conflicting = new Set(options.conflictingIndexes ?? []);
  const existingIndexes = options.existingIndexes ?? {};

  const recorded: Recorded = {
    created: [],
    collModded: [],
    collModCommands: [],
    indexes: [],
    droppedIndexes: [],
  };

  const db = {
    listCollections: () => ({
      toArray: async () => existingCollections.map((name) => ({ name })),
    }),
    createCollection: async (name: string) => {
      recorded.created.push(name);
    },
    command: async (cmd: Record<string, unknown>) => {
      if (typeof cmd['collMod'] === 'string') {
        recorded.collModded.push(cmd['collMod']);
        recorded.collModCommands.push(cmd as Document);
      }
      return {};
    },
    collection: (collection: string) => ({
      createIndex: async (_key: unknown, spec?: { name?: string }) => {
        const name = spec?.name ?? '';
        // Only conflict on the FIRST attempt; a post-drop rebuild succeeds.
        const alreadyDropped = recorded.droppedIndexes.some((d) => d.name === name);
        if (conflicting.has(name) && !alreadyDropped) {
          throw Object.assign(new Error('Index already exists with different options'), {
            code: 85,
            codeName: 'IndexOptionsConflict',
          });
        }
        recorded.indexes.push({ collection, name: spec?.name });
        return name;
      },
      listIndexes: () => ({
        toArray: async () => existingIndexes[collection] ?? [],
      }),
      dropIndex: async (name: string) => {
        recorded.droppedIndexes.push({ collection, name });
      },
    }),
  } as unknown as Db;

  return { db, recorded };
}

describe('isIndexConflict', () => {
  it('recognises both conflict codes', () => {
    assert.ok(isIndexConflict({ code: 85 }));
    assert.ok(isIndexConflict({ code: 86 }));
    assert.ok(isIndexConflict({ codeName: 'IndexOptionsConflict' }));
    assert.ok(isIndexConflict({ codeName: 'IndexKeySpecsConflict' }));
  });

  it('does not swallow unrelated failures', () => {
    assert.ok(!isIndexConflict({ code: 13, codeName: 'Unauthorized' }));
    assert.ok(!isIndexConflict(new Error('connection reset')));
    assert.ok(!isIndexConflict(null));
    assert.ok(!isIndexConflict('boom'));
  });
});

describe('isTtlOnlyChange', () => {
  const desired = {
    name: 'receivedAt_ttl',
    key: { receivedAt: 1 },
    options: { expireAfterSeconds: 7_776_000 },
  };

  it('detects a changed TTL on an otherwise identical index', () => {
    assert.ok(
      isTtlOnlyChange({ name: 'receivedAt_ttl', key: { receivedAt: 1 }, expireAfterSeconds: 2_592_000 }, desired),
    );
  });

  it('is false when the TTL already matches', () => {
    assert.ok(
      !isTtlOnlyChange({ name: 'receivedAt_ttl', key: { receivedAt: 1 }, expireAfterSeconds: 7_776_000 }, desired),
    );
  });

  it('is false when the key differs', () => {
    assert.ok(
      !isTtlOnlyChange({ name: 'receivedAt_ttl', key: { createdAt: 1 }, expireAfterSeconds: 10 }, desired),
    );
  });

  it('is false when uniqueness differs, so that goes down the rebuild path', () => {
    assert.ok(
      !isTtlOnlyChange(
        { name: 'receivedAt_ttl', key: { receivedAt: 1 }, unique: true, expireAfterSeconds: 10 },
        desired,
      ),
    );
  });

  it('is false for an index that has no TTL', () => {
    assert.ok(
      !isTtlOnlyChange({ name: 'issueKey_unique', key: { issueKey: 1 }, unique: true }, {
        name: 'issueKey_unique',
        key: { issueKey: 1 },
        options: { unique: true },
      }),
    );
  });
});

describe('ensureIndex conflict reconciliation', () => {
  const ttlIndex = {
    name: 'receivedAt_ttl',
    key: { receivedAt: 1 },
    options: { expireAfterSeconds: 7_776_000 },
  };

  it('creates cleanly when there is no conflict', async () => {
    const { db, recorded } = fakeDb();
    assert.equal(await ensureIndex(db, COLLECTIONS.webhookDeliveries, ttlIndex, logger), 'ensured');
    assert.equal(recorded.droppedIndexes.length, 0);
    assert.equal(recorded.indexes.length, 1);
  });

  it('adjusts a changed TTL in place rather than rebuilding', async () => {
    // This is the case that used to fail db:init outright: the 30 -> 90 day
    // retention change after the index already exists.
    const { db, recorded } = fakeDb({
      conflictingIndexes: ['receivedAt_ttl'],
      existingIndexes: {
        webhookDeliveries: [
          { name: 'receivedAt_ttl', key: { receivedAt: 1 }, expireAfterSeconds: 2_592_000 },
        ],
      },
    });

    assert.equal(
      await ensureIndex(db, COLLECTIONS.webhookDeliveries, ttlIndex, logger),
      'ttl_updated',
    );
    assert.deepEqual(recorded.droppedIndexes, [], 'should not have rebuilt the index');
    assert.deepEqual(recorded.collModCommands[0], {
      collMod: 'webhookDeliveries',
      index: { name: 'receivedAt_ttl', expireAfterSeconds: 7_776_000 },
    });
  });

  it('drops and recreates when the key itself changed', async () => {
    const { db, recorded } = fakeDb({
      conflictingIndexes: ['status_createdAt'],
      existingIndexes: {
        intakeItems: [{ name: 'status_createdAt', key: { status: 1 } }],
      },
    });

    const outcome = await ensureIndex(
      db,
      COLLECTIONS.intakeItems,
      { name: 'status_createdAt', key: { status: 1, createdAt: -1 } },
      logger,
    );

    assert.equal(outcome, 'recreated');
    assert.deepEqual(recorded.droppedIndexes, [
      { collection: 'intakeItems', name: 'status_createdAt' },
    ]);
    assert.deepEqual(recorded.indexes, [{ collection: 'intakeItems', name: 'status_createdAt' }]);
  });

  it('rebuilds when a unique constraint is added', async () => {
    const { db, recorded } = fakeDb({
      conflictingIndexes: ['issueKey_unique'],
      existingIndexes: { intakeItems: [{ name: 'issueKey_unique', key: { issueKey: 1 } }] },
    });

    const outcome = await ensureIndex(
      db,
      COLLECTIONS.intakeItems,
      { name: 'issueKey_unique', key: { issueKey: 1 }, options: { unique: true } },
      logger,
    );

    assert.equal(outcome, 'recreated');
    assert.equal(recorded.droppedIndexes.length, 1);
  });

  it('rethrows an error that is not a conflict', async () => {
    const db = {
      collection: () => ({
        createIndex: async () => {
          throw Object.assign(new Error('not authorized'), { code: 13, codeName: 'Unauthorized' });
        },
      }),
    } as unknown as Db;

    await assert.rejects(
      () => ensureIndex(db, COLLECTIONS.intakeItems, { name: 'x', key: { a: 1 } }, logger),
      /not authorized/,
    );
  });
});

describe('initializeDatabase', () => {
  it('creates every collection on an empty database', async () => {
    const { db, recorded } = fakeDb();
    const result = await initializeDatabase(db, logger);

    assert.deepEqual([...result.collectionsCreated].sort(), [...COLLECTION_NAMES].sort());
    assert.deepEqual(result.collectionsExisting, []);
    assert.deepEqual([...recorded.created].sort(), [...COLLECTION_NAMES].sort());
  });

  it('creates every declared index', async () => {
    const { db, recorded } = fakeDb();
    const result = await initializeDatabase(db, logger);

    const expected = allIndexes().map((e) => `${e.collection}.${e.index.name}`).sort();
    const actual = recorded.indexes.map((e) => `${e.collection}.${e.name}`).sort();

    assert.deepEqual(actual, expected);
    assert.equal(result.indexesEnsured, allIndexes().length);
    assert.equal(result.indexesRecreated, 0);
    assert.equal(result.indexesTtlUpdated, 0);
  });

  it('names every index it creates', async () => {
    const { db, recorded } = fakeDb();
    await initializeDatabase(db, logger);
    // An unnamed index gets a generated name, which makes a re-run non-idempotent.
    assert.ok(recorded.indexes.every((e) => typeof e.name === 'string' && e.name !== ''));
  });

  it('is idempotent: a second run creates nothing but still ensures indexes', async () => {
    const { db, recorded } = fakeDb({ existingCollections: COLLECTION_NAMES });
    const result = await initializeDatabase(db, logger);

    assert.deepEqual(result.collectionsCreated, []);
    assert.deepEqual([...result.collectionsExisting].sort(), [...COLLECTION_NAMES].sort());
    assert.deepEqual(recorded.created, []);
    assert.equal(result.indexesEnsured, allIndexes().length);
  });

  it('reapplies every validator on an existing database', async () => {
    const { db, recorded } = fakeDb({ existingCollections: COLLECTION_NAMES });
    await initializeDatabase(db, logger);

    assert.deepEqual([...recorded.collModded].sort(), [
      'auditLog',
      'checkpoints',
      'intakeItems',
      'outboundWrites',
      'webhookDeliveries',
    ]);
  });

  it('creates validated collections with their validator attached', async () => {
    const { db, recorded } = fakeDb();
    await initializeDatabase(db, logger);
    // On a fresh database the validator arrives via createCollection.
    assert.deepEqual(recorded.collModded, []);
    for (const name of [
      'auditLog',
      'checkpoints',
      'outboundWrites',
      'intakeItems',
      'webhookDeliveries',
    ]) {
      assert.ok(recorded.created.includes(name));
    }
  });

  it('handles a partially initialized database', async () => {
    const { db, recorded } = fakeDb({ existingCollections: ['intakeItems'] });
    const result = await initializeDatabase(db, logger);

    assert.deepEqual(result.collectionsExisting, ['intakeItems']);
    assert.ok(!recorded.created.includes('intakeItems'));
    assert.equal(result.collectionsCreated.length, COLLECTION_NAMES.length - 1);
    const intakeIndexes = recorded.indexes.filter((e) => e.collection === 'intakeItems');
    assert.equal(intakeIndexes.length, INDEXES['intakeItems'].length);
  });

  it('reports reconciliations in its result', async () => {
    const { db } = fakeDb({
      existingCollections: COLLECTION_NAMES,
      conflictingIndexes: ['receivedAt_ttl'],
      existingIndexes: {
        webhookDeliveries: [
          { name: 'receivedAt_ttl', key: { receivedAt: 1 }, expireAfterSeconds: 2_592_000 },
        ],
      },
    });

    const result = await initializeDatabase(db, logger);
    assert.equal(result.indexesTtlUpdated, 1);
    assert.equal(result.indexesRecreated, 0);
    assert.equal(result.indexesEnsured, allIndexes().length);
  });
});
