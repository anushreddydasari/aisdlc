import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId } from 'mongodb';

import type { WebhookDeliveryDocument, WebhookDeliveryRepository } from '../db/webhook-deliveries.ts';
import { createLogger } from '../logging/logger.ts';
import { hashSnapshot, type CreateIntakeInput, type IntakeRepository } from '../intake/repository.ts';
import type { FetchIssueResult, NeutaraClient, NeutaraIssue } from '../neutara/client.ts';
import {
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  backoffMs,
  drainPending,
  enrichDelivery,
  toSnapshot,
  toSnapshotMeta,
  type EnrichmentDeps,
} from './worker.ts';

const NOW = new Date('2026-09-20T12:00:00.000Z');

const ISSUE: NeutaraIssue = {
  key: 'AIS-1',
  cfKey: 'CF-9',
  summary: 'Login fails for SSO users',
  description: '<p>Steps to reproduce</p>',
  type: 'bug',
  priority: 'high',
  status: { name: 'Open' },
  spaceKey: 'AIS',
  spaceName: 'AISDLC',
  reporter: { email: 'reporter@example.com', displayName: 'A Reporter' },
  assignee: { email: 'assignee@example.com', displayName: 'An Assignee' },
  parentKey: 'AIS-0',
  labels: ['sso', 'auth'],
  createdAt: '2026-09-01T00:00:00.000Z',
};

function delivery(overrides: Partial<WebhookDeliveryDocument> = {}): WebhookDeliveryDocument {
  return {
    _id: new ObjectId(),
    deliveryId: 'a'.repeat(64),
    event: 'issue.created',
    issueKey: 'AIS-1',
    eventTimestamp: NOW,
    payload: {},
    status: 'pending',
    invalidReason: null,
    attempts: 0,
    maxAttempts: 5,
    nextAttemptAt: NOW,
    lastError: null,
    intakeItemId: null,
    receivedAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

interface Harness {
  readonly deps: EnrichmentDeps;
  readonly created: CreateIntakeInput[];
  readonly enriched: { deliveryId: string; intakeItemId: ObjectId }[];
  readonly retries: { deliveryId: string; message: string; nextAttemptAt: Date }[];
  readonly failures: { deliveryId: string; message: string }[];
  readonly logs: string[];
}

function harness(
  options: {
    fetchResult?: FetchIssueResult;
    pending?: WebhookDeliveryDocument[];
    createThrows?: boolean;
    alreadyExists?: boolean;
  } = {},
): Harness {
  const created: CreateIntakeInput[] = [];
  const enriched: { deliveryId: string; intakeItemId: ObjectId }[] = [];
  const retries: { deliveryId: string; message: string; nextAttemptAt: Date }[] = [];
  const failures: { deliveryId: string; message: string }[] = [];
  const logs: string[] = [];

  const deliveries: WebhookDeliveryRepository = {
    async record() {
      throw new Error('not used by the worker');
    },
    async findByDeliveryId() {
      return null;
    },
    async findPending() {
      return options.pending ?? [];
    },
    async markEnriched(deliveryId, intakeItemId) {
      enriched.push({ deliveryId, intakeItemId });
    },
    async scheduleRetry(deliveryId, message, nextAttemptAt) {
      retries.push({ deliveryId, message, nextAttemptAt });
    },
    async markFailed(deliveryId, message) {
      failures.push({ deliveryId, message });
    },
  };

  const intake = {
    async create(input: CreateIntakeInput) {
      if (options.createThrows) throw new Error('mongo exploded');
      created.push(input);
      return {
        id: new ObjectId(),
        created: !options.alreadyExists,
        item: {} as never,
      };
    },
  } as unknown as IntakeRepository;

  const client: NeutaraClient = {
    async getIssue() {
      return options.fetchResult ?? { ok: true, issue: ISSUE };
    },
  };

  return {
    deps: {
      deliveries,
      intake,
      client,
      logger: createLogger({ write: (line) => logs.push(line) }),
      now: () => NOW,
    },
    created,
    enriched,
    retries,
    failures,
    logs,
  };
}

describe('mapping a Neutara issue onto the snapshot', () => {
  it('maps the hashed fields', () => {
    const snapshot = toSnapshot(ISSUE);
    assert.equal(snapshot.title, 'Login fails for SSO users');
    assert.equal(snapshot.description, '<p>Steps to reproduce</p>');
    assert.equal(snapshot.issueType, 'bug');
    assert.equal(snapshot.priority, 'high');
    assert.equal(snapshot.project, 'AIS');
    assert.equal(snapshot.parentKey, 'AIS-0');
    assert.deepEqual(snapshot.labels, ['sso', 'auth']);
  });

  it('prefers the reporter email over the display name', () => {
    // A display name changes when someone's name does; an email does not, and
    // a rename should not invalidate checkpoints.
    assert.equal(toSnapshot(ISSUE).reporter, 'reporter@example.com');
    assert.equal(
      toSnapshot({ ...ISSUE, reporter: { displayName: 'Only A Name' } }).reporter,
      'Only A Name',
    );
    assert.equal(toSnapshot({ ...ISSUE, reporter: null }).reporter, null);
  });

  it('defaults a missing description to empty rather than failing', () => {
    assert.equal(toSnapshot({ ...ISSUE, description: null }).description, '');
  });

  it('keeps volatile and identifying context out of the snapshot', () => {
    const snapshot = toSnapshot(ISSUE) as unknown as Record<string, unknown>;
    for (const field of ['status', 'assignee', 'cfKey', 'createdAt', 'spaceName']) {
      assert.ok(!(field in snapshot), `${field} leaked into the hashed snapshot`);
    }
  });

  it('puts that context in the metadata instead', () => {
    const meta = toSnapshotMeta(ISSUE, NOW);
    assert.equal(meta.status, 'Open');
    assert.equal(meta.assignee, 'assignee@example.com');
    assert.equal(meta.cfKey, 'CF-9');
    assert.equal(meta.createdAt, '2026-09-01T00:00:00.000Z');
    assert.equal(meta.fetchedAt, NOW);
  });
});

describe('sourceHash', () => {
  it('is identical when labels are reordered', () => {
    const a = hashSnapshot(toSnapshot({ ...ISSUE, labels: ['sso', 'auth'] }));
    const b = hashSnapshot(toSnapshot({ ...ISSUE, labels: ['auth', 'sso'] }));
    assert.equal(a, b);
  });

  it('changes when a label is added or removed', () => {
    const base = hashSnapshot(toSnapshot(ISSUE));
    assert.notEqual(base, hashSnapshot(toSnapshot({ ...ISSUE, labels: ['sso'] })));
    assert.notEqual(base, hashSnapshot(toSnapshot({ ...ISSUE, labels: ['sso', 'auth', 'x'] })));
  });

  it('treats absent and empty labels alike', () => {
    assert.equal(
      hashSnapshot(toSnapshot({ ...ISSUE, labels: null })),
      hashSnapshot(toSnapshot({ ...ISSUE, labels: [] })),
    );
  });

  for (const [field, value] of [
    ['status', { name: 'Closed' }],
    ['assignee', { email: 'someone-else@example.com' }],
    ['cfKey', 'CF-DIFFERENT'],
    ['createdAt', '2020-01-01T00:00:00.000Z'],
    ['spaceName', 'A Different Name'],
  ] as const) {
    it(`does not change when ${field} changes`, () => {
      // The approved exclusion list. If any of these start moving the hash,
      // every checkpoint for the issue silently invalidates.
      assert.equal(
        hashSnapshot(toSnapshot(ISSUE)),
        hashSnapshot(toSnapshot({ ...ISSUE, [field]: value })),
      );
    });
  }

  it('is unaffected by fields Neutara sends that we do not model', () => {
    const withExtras = {
      ...ISSUE,
      productType: 'content',
      customerPlan: 'standard',
      comments: [{ body: 'hello' }],
      attachments: [{ id: 'a' }],
      activity: [{ at: 'now' }],
    } as unknown as NeutaraIssue;
    assert.equal(hashSnapshot(toSnapshot(ISSUE)), hashSnapshot(toSnapshot(withExtras)));
  });

  for (const [field, value] of [
    ['summary', 'Different summary'],
    ['description', 'Different description'],
    ['type', 'task'],
    ['priority', 'low'],
    ['spaceKey', 'OTHER'],
    ['parentKey', 'AIS-99'],
  ] as const) {
    it(`does change when ${field} changes`, () => {
      assert.notEqual(
        hashSnapshot(toSnapshot(ISSUE)),
        hashSnapshot(toSnapshot({ ...ISSUE, [field]: value })),
      );
    });
  }
});

describe('successful enrichment', () => {
  it('creates the intake item and settles the delivery', async () => {
    const h = harness();
    const outcome = await enrichDelivery(delivery(), h.deps);

    assert.equal(outcome, 'enriched');
    assert.equal(h.created.length, 1);
    assert.equal(h.created[0]!.issueKey, 'AIS-1');
    assert.equal(h.created[0]!.source, 'webhook');
    assert.equal(h.enriched.length, 1);
    assert.equal(h.failures.length, 0);
  });

  it('stores the canonical issue key when the delivery named the cfKey', async () => {
    // Neutara resolves CF-9 to AIS-1, so the response is canonical even though
    // the delivery asked by the customer-facing identifier. The intake item
    // must be keyed by AIS-1, not by whatever was requested.
    const h = harness();
    const outcome = await enrichDelivery(delivery({ issueKey: 'CF-9' }), h.deps);

    assert.equal(outcome, 'enriched');
    assert.equal(h.created.length, 1);
    assert.equal(h.created[0]!.issueKey, 'AIS-1');
    assert.equal(h.created[0]!.snapshotMeta?.cfKey, 'CF-9');
  });

  it('does not create a second item when the same ticket arrives both ways', async () => {
    // The point of normalising: one delivery addressed by cfKey and one by the
    // canonical key name the same ticket, so both must resolve to one issueKey.
    // The unique index on intakeItems.issueKey collapses them — this asserts
    // the key we hand it, which is what makes that collapse happen at all.
    const h = harness();
    await enrichDelivery(delivery({ deliveryId: 'a'.repeat(64), issueKey: 'CF-9' }), h.deps);
    await enrichDelivery(delivery({ deliveryId: 'b'.repeat(64), issueKey: 'AIS-1' }), h.deps);

    assert.equal(h.created.length, 2, 'both deliveries should reach create()');
    assert.deepEqual(
      h.created.map((c) => c.issueKey),
      ['AIS-1', 'AIS-1'],
      'both must be keyed canonically so the unique index dedupes them',
    );
  });

  it('links the delivery to the intake item', async () => {
    const h = harness();
    const d = delivery();
    await enrichDelivery(d, h.deps);

    assert.equal(h.enriched[0]!.deliveryId, d.deliveryId);
    assert.ok(h.enriched[0]!.intakeItemId instanceof ObjectId);
    assert.equal(h.created[0]!.deliveryRef, d._id);
  });

  it('preserves the original receivedAt', async () => {
    const received = new Date('2026-01-01T00:00:00.000Z');
    const h = harness();
    await enrichDelivery(delivery({ receivedAt: received }), h.deps);
    assert.equal(h.created[0]!.receivedAt, received);
  });

  it('settles the delivery even when the intake item already existed', async () => {
    // Re-processing after a crash between create and markEnriched: create()
    // is idempotent, and the delivery must still be settled.
    const h = harness({ alreadyExists: true });
    const outcome = await enrichDelivery(delivery(), h.deps);

    assert.equal(outcome, 'enriched');
    assert.equal(h.enriched.length, 1);
  });
});

describe('failure handling', () => {
  it('schedules a retry for a transient failure', async () => {
    const h = harness({
      fetchResult: { ok: false, kind: 'transient', message: 'neutara returned 503', status: 503 },
    });
    const outcome = await enrichDelivery(delivery({ attempts: 0 }), h.deps);

    assert.equal(outcome, 'retry_scheduled');
    assert.equal(h.retries.length, 1);
    assert.equal(h.created.length, 0, 'an intake item was created despite a failed fetch');
    assert.equal(h.retries[0]!.nextAttemptAt.getTime(), NOW.getTime() + RETRY_BASE_MS);
  });

  for (const kind of ['not_found', 'unauthorized', 'malformed', 'too_large'] as const) {
    it(`fails permanently on ${kind} without retrying`, async () => {
      const h = harness({ fetchResult: { ok: false, kind, message: 'nope' } });
      const outcome = await enrichDelivery(delivery(), h.deps);

      assert.equal(outcome, 'failed_permanently');
      assert.equal(h.failures.length, 1);
      assert.equal(h.retries.length, 0);
      assert.match(h.failures[0]!.message, new RegExp(kind));
    });
  }

  it('fails permanently once attempts are exhausted', async () => {
    const h = harness({ fetchResult: { ok: false, kind: 'transient', message: 'still down' } });
    const outcome = await enrichDelivery(delivery({ attempts: 4, maxAttempts: 5 }), h.deps);

    assert.equal(outcome, 'failed_permanently');
    assert.equal(h.failures.length, 1);
    assert.equal(h.retries.length, 0);
  });

  it('retries on the attempt before last', async () => {
    const h = harness({ fetchResult: { ok: false, kind: 'transient', message: 'still down' } });
    assert.equal(await enrichDelivery(delivery({ attempts: 3, maxAttempts: 5 }), h.deps), 'retry_scheduled');
  });

  it('fails a delivery with no issue key rather than spinning', async () => {
    const h = harness();
    const outcome = await enrichDelivery(delivery({ issueKey: null }), h.deps);

    assert.equal(outcome, 'skipped_no_issue_key');
    assert.equal(h.failures.length, 1);
    assert.equal(h.created.length, 0);
  });

  it('never creates an intake item from a failed fetch', async () => {
    for (const kind of ['transient', 'not_found', 'unauthorized', 'malformed'] as const) {
      const h = harness({ fetchResult: { ok: false, kind, message: 'x' } });
      await enrichDelivery(delivery(), h.deps);
      assert.equal(h.created.length, 0, `${kind} created an intake item`);
    }
  });

  it('does not settle the delivery when creating the intake item throws', async () => {
    // The delivery stays pending so the next pass retries it; settling here
    // would lose the work with no record of why.
    const h = harness({ createThrows: true });
    await assert.rejects(() => enrichDelivery(delivery(), h.deps));
    assert.equal(h.enriched.length, 0);
    assert.equal(h.failures.length, 0);
  });
});

describe('backoff', () => {
  it('starts at one minute and doubles', () => {
    assert.equal(backoffMs(0), RETRY_BASE_MS);
    assert.equal(backoffMs(1), RETRY_BASE_MS * 2);
    assert.equal(backoffMs(2), RETRY_BASE_MS * 4);
    assert.equal(backoffMs(3), RETRY_BASE_MS * 8);
  });

  it('is capped', () => {
    assert.equal(backoffMs(100), RETRY_MAX_MS);
    assert.ok(backoffMs(100) <= RETRY_MAX_MS);
  });

  it('is never negative', () => {
    assert.ok(backoffMs(-5) > 0);
  });

  it('grows with the attempt already recorded', async () => {
    const h = harness({ fetchResult: { ok: false, kind: 'transient', message: 'down' } });
    await enrichDelivery(delivery({ attempts: 2 }), h.deps);
    assert.equal(h.retries[0]!.nextAttemptAt.getTime(), NOW.getTime() + RETRY_BASE_MS * 4);
  });
});

describe('drainPending', () => {
  it('reports nothing for an empty queue', async () => {
    const h = harness({ pending: [] });
    assert.deepEqual(await drainPending(h.deps), {
      examined: 0,
      enriched: 0,
      retryScheduled: 0,
      failed: 0,
    });
  });

  it('processes every due delivery', async () => {
    const h = harness({
      pending: [
        delivery({ deliveryId: 'a'.repeat(64) }),
        delivery({ deliveryId: 'b'.repeat(64) }),
        delivery({ deliveryId: 'c'.repeat(64) }),
      ],
    });
    const summary = await drainPending(h.deps);

    assert.equal(summary.examined, 3);
    assert.equal(summary.enriched, 3);
    assert.equal(h.created.length, 3);
  });

  it('keeps going when one delivery throws', async () => {
    // A single bad row must not stall the queue.
    const h = harness({ pending: [delivery(), delivery({ deliveryId: 'b'.repeat(64) })] });
    let calls = 0;
    const failing = {
      ...h.deps,
      intake: {
        async create(input: CreateIntakeInput) {
          calls += 1;
          if (calls === 1) throw new Error('transient mongo fault');
          return { id: new ObjectId(), created: true, item: {} as never };
        },
      } as unknown as IntakeRepository,
    };

    const summary = await drainPending(failing);
    assert.equal(summary.examined, 2);
    assert.equal(summary.enriched, 1);
    assert.ok(h.logs.join('\n').includes('leaving delivery pending'));
  });

  it('counts each outcome separately', async () => {
    const h = harness({
      fetchResult: { ok: false, kind: 'not_found', message: 'gone' },
      pending: [delivery(), delivery({ deliveryId: 'b'.repeat(64) })],
    });
    const summary = await drainPending(h.deps);

    assert.equal(summary.failed, 2);
    assert.equal(summary.enriched, 0);
  });
});
