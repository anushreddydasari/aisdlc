import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId, type Db } from 'mongodb';

import { WEBHOOK_DELIVERY_MAX_ATTEMPTS } from './collections.ts';
import {
  createWebhookDeliveryRepository,
  type WebhookDeliveryDocument,
} from './webhook-deliveries.ts';
import { createLogger } from '../logging/logger.ts';

const logger = createLogger({ write: () => {} });
const DELIVERY_ID = 'a'.repeat(64);

interface Harness {
  readonly db: Db;
  readonly store: WebhookDeliveryDocument[];
  failNextInsertWithDuplicate(): void;
  failNextInsertWith(error: unknown): void;
}

function harness(seed: WebhookDeliveryDocument[] = []): Harness {
  const store = [...seed];
  let duplicateNext = false;
  let customError: unknown;

  const collection = {
    async insertOne(document: WebhookDeliveryDocument) {
      if (customError !== undefined) {
        const error = customError;
        customError = undefined;
        throw error;
      }
      if (duplicateNext) {
        duplicateNext = false;
        throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      }
      const _id = new ObjectId();
      store.push({ ...document, _id });
      return { insertedId: _id, acknowledged: true };
    },
    async findOne(filter: Record<string, unknown>) {
      const found = store.find((d) => d.deliveryId === filter['deliveryId']);
      return found ? { ...found } : null;
    },
  };

  return {
    db: { collection: () => collection } as unknown as Db,
    store,
    failNextInsertWithDuplicate: () => {
      duplicateNext = true;
    },
    failNextInsertWith: (error: unknown) => {
      customError = error;
    },
  };
}

const repo = (h: Harness) => createWebhookDeliveryRepository(h.db, logger);

describe('recording a delivery', () => {
  it('stores a pending delivery with the queue defaults', async () => {
    const h = harness();
    const result = await repo(h).record({
      deliveryId: DELIVERY_ID,
      status: 'pending',
      event: 'issue.created',
      issueKey: 'AIS-1',
      eventTimestamp: new Date('2026-09-20T12:00:00.000Z'),
      payload: { event: 'issue.created' },
    });

    assert.ok(result.recorded);
    const [stored] = h.store;
    assert.ok(stored);
    assert.equal(stored.status, 'pending');
    assert.equal(stored.attempts, 0);
    assert.equal(stored.maxAttempts, WEBHOOK_DELIVERY_MAX_ATTEMPTS);
    assert.equal(stored.intakeItemId, null, 'Phase 3 must not link an intake item');
    assert.equal(stored.lastError, null);
  });

  it('makes a pending delivery immediately eligible for enrichment', async () => {
    const h = harness();
    await repo(h).record({ deliveryId: DELIVERY_ID, status: 'pending' });
    const [stored] = h.store;
    assert.equal(stored!.nextAttemptAt.getTime(), stored!.receivedAt.getTime());
  });

  it('stores an ignored delivery', async () => {
    const h = harness();
    await repo(h).record({
      deliveryId: DELIVERY_ID,
      status: 'ignored',
      event: 'issue.updated',
      issueKey: 'AIS-2',
    });
    assert.equal(h.store[0]!.status, 'ignored');
  });

  it('stores an invalid delivery with its reason and no event', async () => {
    const h = harness();
    await repo(h).record({
      deliveryId: DELIVERY_ID,
      status: 'invalid',
      invalidReason: 'malformed_json',
    });

    const [stored] = h.store;
    assert.equal(stored!.status, 'invalid');
    assert.equal(stored!.invalidReason, 'malformed_json');
    assert.equal(stored!.event, null);
    assert.equal(stored!.issueKey, null);
    assert.equal(stored!.payload, null);
  });

  it('defaults every nullable field rather than leaving it undefined', async () => {
    // undefined would be stored as a missing key; the validator types these
    // as nullable, so null is the correct stored value.
    const h = harness();
    await repo(h).record({ deliveryId: DELIVERY_ID, status: 'pending' });

    const [stored] = h.store;
    for (const field of ['event', 'issueKey', 'eventTimestamp', 'payload', 'invalidReason'] as const) {
      assert.equal(stored![field], null, `${field} was not defaulted to null`);
    }
  });

  it('honours an explicit receivedAt', async () => {
    const h = harness();
    const receivedAt = new Date('2026-01-01T00:00:00.000Z');
    await repo(h).record({ deliveryId: DELIVERY_ID, status: 'pending', receivedAt });
    assert.equal(h.store[0]!.receivedAt.getTime(), receivedAt.getTime());
  });
});

describe('duplicate deliveries', () => {
  it('returns the existing record without storing a second', async () => {
    const h = harness();
    const first = await repo(h).record({ deliveryId: DELIVERY_ID, status: 'pending' });
    h.failNextInsertWithDuplicate();
    const second = await repo(h).record({ deliveryId: DELIVERY_ID, status: 'pending' });

    assert.ok(first.recorded);
    assert.ok(!second.recorded);
    assert.equal(second.id.toString(), first.id.toString());
    assert.equal(h.store.length, 1);
  });

  it('leaves the original record untouched', async () => {
    // A replay carries no new information; overwriting would destroy the
    // first piece of evidence in favour of an identical one.
    const h = harness();
    await repo(h).record({
      deliveryId: DELIVERY_ID,
      status: 'pending',
      issueKey: 'AIS-1',
      event: 'issue.created',
    });
    const before = { ...h.store[0]! };

    h.failNextInsertWithDuplicate();
    await repo(h).record({ deliveryId: DELIVERY_ID, status: 'invalid', invalidReason: 'x' });

    assert.deepEqual(h.store[0], before);
  });

  it('rethrows when the unique index rejects but no record exists', async () => {
    // A concurrent delete or the TTL firing mid-flight. Returning a duplicate
    // result with nothing behind it would be a lie.
    const h = harness();
    h.failNextInsertWithDuplicate();
    await assert.rejects(() => repo(h).record({ deliveryId: DELIVERY_ID, status: 'pending' }));
  });
});

describe('other failures', () => {
  it('rethrows an error that is not a duplicate key', async () => {
    const h = harness();
    h.failNextInsertWith(Object.assign(new Error('not authorized'), { code: 13 }));
    await assert.rejects(
      () => repo(h).record({ deliveryId: DELIVERY_ID, status: 'pending' }),
      /not authorized/,
    );
  });
});

describe('findByDeliveryId', () => {
  it('finds a stored delivery', async () => {
    const h = harness();
    await repo(h).record({ deliveryId: DELIVERY_ID, status: 'pending' });
    const found = await repo(h).findByDeliveryId(DELIVERY_ID);
    assert.equal(found?.deliveryId, DELIVERY_ID);
  });

  it('returns null for an unknown delivery', async () => {
    assert.equal(await repo(harness()).findByDeliveryId('b'.repeat(64)), null);
  });
});
