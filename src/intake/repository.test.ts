import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId, type Db } from 'mongodb';

import { createLogger } from '../logging/logger.ts';
import type { AuditEntryInput, AuditLog } from '../db/audit-log.ts';
import { InvalidTransitionError } from './state.ts';
import {
  ApprovalRequiresOperatorError,
  IntakeConflictError,
  IntakeNotFoundError,
  createIntakeRepository,
  hashSnapshot,
  type IntakeItemDocument,
  type IntakeSnapshot,
} from './repository.ts';

const logger = createLogger({ write: () => {} });

const SNAPSHOT: IntakeSnapshot = {
  title: 'Login fails for SSO users',
  description: 'Steps to reproduce...',
  issueType: 'bug',
  priority: 'high',
  reporter: 'someone',
  project: 'AISDLC',
};

interface Harness {
  readonly db: Db;
  readonly audit: AuditLog;
  readonly entries: AuditEntryInput[];
  readonly store: IntakeItemDocument[];
  /** Forces the next insertOne to raise a duplicate-key error. */
  failNextInsertWithDuplicate(): void;
  /** Makes the next findOneAndUpdate match nothing, simulating a race. */
  failNextUpdateWithConflict(): void;
}

function harness(seed: IntakeItemDocument[] = []): Harness {
  const store = [...seed];
  const entries: AuditEntryInput[] = [];
  let duplicateNext = false;
  let conflictNext = false;

  const matches = (doc: IntakeItemDocument, filter: Record<string, unknown>): boolean =>
    Object.entries(filter).every(
      ([key, value]) => (doc as unknown as Record<string, unknown>)[key] === value,
    );

  const collection = {
    async findOne(filter: Record<string, unknown>) {
      const found = store.find((doc) => matches(doc, filter));
      // The driver deserializes a fresh object per read; returning the stored
      // reference would model aliasing that does not exist in production.
      return found ? { ...found } : null;
    },
    async insertOne(document: IntakeItemDocument) {
      if (duplicateNext) {
        duplicateNext = false;
        throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      }
      const _id = new ObjectId();
      store.push({ ...document, _id });
      return { insertedId: _id, acknowledged: true };
    },
    async findOneAndUpdate(
      filter: Record<string, unknown>,
      update: { $set: Partial<IntakeItemDocument> },
    ) {
      if (conflictNext) {
        conflictNext = false;
        return null;
      }
      const found = store.find((doc) => matches(doc, filter));
      if (!found) return null;
      Object.assign(found, update.$set);
      return found;
    },
    find(filter: Record<string, unknown>) {
      const cursor = {
        sort: () => cursor,
        limit: () => cursor,
        toArray: async () => store.filter((doc) => matches(doc, filter)),
      };
      return cursor;
    },
  };

  const audit: AuditLog = {
    async append(entry) {
      entries.push(entry);
      return new ObjectId();
    },
    async query() {
      return [];
    },
  };

  return {
    db: { collection: () => collection } as unknown as Db,
    audit,
    entries,
    store,
    failNextInsertWithDuplicate: () => {
      duplicateNext = true;
    },
    failNextUpdateWithConflict: () => {
      conflictNext = true;
    },
  };
}

function repo(h: Harness) {
  return createIntakeRepository(h.db, h.audit, logger);
}

describe('hashSnapshot', () => {
  it('is stable across field order', () => {
    const a = hashSnapshot(SNAPSHOT);
    const b = hashSnapshot({
      project: SNAPSHOT.project ?? null,
      reporter: SNAPSHOT.reporter ?? null,
      priority: SNAPSHOT.priority ?? null,
      issueType: SNAPSHOT.issueType,
      description: SNAPSHOT.description,
      title: SNAPSHOT.title,
    });
    assert.equal(a, b);
  });

  it('changes when the issue content changes', () => {
    assert.notEqual(hashSnapshot(SNAPSHOT), hashSnapshot({ ...SNAPSHOT, title: 'Something else' }));
  });

  it('treats an absent optional field the same as an explicit null', () => {
    const withNull = hashSnapshot({ ...SNAPSHOT, priority: null });
    const { priority: _omit, ...withoutKey } = SNAPSHOT;
    assert.equal(withNull, hashSnapshot(withoutKey as IntakeSnapshot));
  });
});

describe('create', () => {
  it('stores a new item in the initial state', async () => {
    const h = harness();
    const result = await repo(h).create({ issueKey: 'AIS-1', source: 'webhook', snapshot: SNAPSHOT });

    assert.ok(result.created);
    assert.equal(result.item.status, 'received');
    assert.equal(result.item.issueKey, 'AIS-1');
    assert.equal(result.item.sourceHash, hashSnapshot(SNAPSHOT));
    assert.equal(result.item.approvedBy, null);
    assert.equal(result.item.deliveryRef, null);
  });

  it('records an audit entry naming the source', async () => {
    const h = harness();
    const result = await repo(h).create({ issueKey: 'AIS-1', source: 'webhook', snapshot: SNAPSHOT });

    assert.equal(h.entries.length, 1);
    const [entry] = h.entries;
    assert.equal(entry!.action, 'intake.received');
    assert.equal(entry!.subjectType, 'intakeItem');
    assert.equal(entry!.subjectId, result.id);
    assert.equal(entry!.actor, 'source:webhook');
  });

  it('is idempotent on issueKey: a redelivery returns the existing item', async () => {
    const h = harness();
    const first = await repo(h).create({ issueKey: 'AIS-1', source: 'webhook', snapshot: SNAPSHOT });
    const second = await repo(h).create({
      issueKey: 'AIS-1',
      source: 'webhook',
      snapshot: { ...SNAPSHOT, title: 'Edited upstream' },
    });

    assert.ok(!second.created);
    assert.equal(second.id.toString(), first.id.toString());
    assert.equal(h.store.length, 1);
    // The first snapshot wins: it is the one already being worked on.
    assert.equal(second.item.snapshot.title, SNAPSHOT.title);
  });

  it('writes no second audit entry for a duplicate', async () => {
    const h = harness();
    await repo(h).create({ issueKey: 'AIS-1', source: 'webhook', snapshot: SNAPSHOT });
    await repo(h).create({ issueKey: 'AIS-1', source: 'webhook', snapshot: SNAPSHOT });
    assert.equal(h.entries.length, 1);
  });

  it('survives losing an insert race to a concurrent writer', async () => {
    const h = harness();
    const existing: IntakeItemDocument = {
      _id: new ObjectId(),
      issueKey: 'AIS-1',
      source: 'webhook',
      deliveryRef: null,
      snapshot: SNAPSHOT,
      snapshotMeta: null,
      sourceHash: hashSnapshot(SNAPSHOT),
      status: 'received',
      statusReason: null,
      approvedBy: null,
      approvedAt: null,
      receivedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // findOne sees nothing, then the unique index rejects the insert.
    const racing = harness([]);
    racing.failNextInsertWithDuplicate();
    racing.store.push(existing);

    const result = await repo(racing).create({
      issueKey: 'AIS-1',
      source: 'webhook',
      snapshot: SNAPSHOT,
    });

    assert.ok(!result.created);
    assert.equal(result.id.toString(), existing._id!.toString());
    assert.equal(racing.entries.length, 0);
    assert.equal(h.entries.length, 0);
  });

  it('carries the delivery reference when one is supplied', async () => {
    const h = harness();
    const deliveryRef = new ObjectId();
    const result = await repo(h).create({
      issueKey: 'AIS-2',
      source: 'webhook',
      snapshot: SNAPSHOT,
      deliveryRef,
    });
    assert.equal(result.item.deliveryRef, deliveryRef);
  });
});

describe('findByIssueKey and list', () => {
  it('finds an existing item', async () => {
    const h = harness();
    await repo(h).create({ issueKey: 'AIS-1', source: 'manual', snapshot: SNAPSHOT });
    const found = await repo(h).findByIssueKey('AIS-1');
    assert.equal(found?.issueKey, 'AIS-1');
  });

  it('returns null rather than throwing for an unknown key', async () => {
    assert.equal(await repo(harness()).findByIssueKey('AIS-404'), null);
  });

  it('lists items', async () => {
    const h = harness();
    await repo(h).create({ issueKey: 'AIS-1', source: 'manual', snapshot: SNAPSHOT });
    await repo(h).create({ issueKey: 'AIS-2', source: 'manual', snapshot: SNAPSHOT });
    assert.equal((await repo(h).list()).length, 2);
  });
});

describe('transition', () => {
  async function seeded(): Promise<{ h: Harness; issueKey: string }> {
    const h = harness();
    await repo(h).create({ issueKey: 'AIS-1', source: 'webhook', snapshot: SNAPSHOT });
    return { h, issueKey: 'AIS-1' };
  }

  it('moves through the approval path', async () => {
    const { h, issueKey } = await seeded();
    await repo(h).transition(issueKey, 'pending_approval', { actor: 'svc:intake' });
    const approved = await repo(h).transition(issueKey, 'approved', {
      actor: 'operator:anush',
      approvedBy: 'operator:anush',
    });

    assert.equal(approved.status, 'approved');
    assert.equal(approved.approvedBy, 'operator:anush');
    assert.ok(approved.approvedAt instanceof Date);
  });

  it('refuses to skip the approval gate', async () => {
    const { h, issueKey } = await seeded();
    await assert.rejects(
      () =>
        repo(h).transition(issueKey, 'approved', {
          actor: 'svc:intake',
          approvedBy: 'operator:anush',
        }),
      InvalidTransitionError,
    );
  });

  it('does not write to the database when the transition is illegal', async () => {
    const { h, issueKey } = await seeded();
    const auditCountBefore = h.entries.length;
    await assert.rejects(() =>
      repo(h).transition(issueKey, 'approved', { actor: 'x', approvedBy: 'operator:x' }),
    );

    assert.equal(h.store[0]!.status, 'received', 'status changed despite an illegal transition');
    assert.equal(h.entries.length, auditCountBefore, 'an audit entry was written anyway');
  });

  it('audits every transition with from and to', async () => {
    const { h, issueKey } = await seeded();
    await repo(h).transition(issueKey, 'pending_approval', {
      actor: 'svc:intake',
      reason: 'ready for review',
    });

    const entry = h.entries.at(-1)!;
    assert.equal(entry.action, 'intake.pending_approval');
    assert.equal(entry.actor, 'svc:intake');
    assert.deepEqual(entry.detail, {
      issueKey,
      from: 'received',
      to: 'pending_approval',
      reason: 'ready for review',
    });
  });

  it('records a rejection reason on the document', async () => {
    const { h, issueKey } = await seeded();
    await repo(h).transition(issueKey, 'pending_approval', { actor: 'svc:intake' });
    const rejected = await repo(h).transition(issueKey, 'rejected', {
      actor: 'operator:anush',
      reason: 'out of scope',
    });

    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.statusReason, 'out of scope');
    assert.equal(rejected.approvedBy, null);
  });

  it('refuses to move out of a terminal state', async () => {
    const { h, issueKey } = await seeded();
    await repo(h).transition(issueKey, 'pending_approval', { actor: 'a' });
    await repo(h).transition(issueKey, 'rejected', { actor: 'b' });

    await assert.rejects(
      () => repo(h).transition(issueKey, 'approved', { actor: 'c', approvedBy: 'operator:c' }),
      /'rejected' is terminal/,
    );
  });

  it('throws IntakeNotFoundError for an unknown issueKey', async () => {
    await assert.rejects(
      () => repo(harness()).transition('AIS-404', 'pending_approval', { actor: 'a' }),
      IntakeNotFoundError,
    );
  });

  it('detects a concurrent change instead of clobbering it', async () => {
    const { h, issueKey } = await seeded();
    h.failNextUpdateWithConflict();

    await assert.rejects(
      () => repo(h).transition(issueKey, 'pending_approval', { actor: 'a' }),
      IntakeConflictError,
    );
    // No audit entry for a transition that did not happen.
    assert.equal(h.entries.length, 1);
  });

  it('lets approvedBy differ from the acting service', async () => {
    const { h, issueKey } = await seeded();
    await repo(h).transition(issueKey, 'pending_approval', { actor: 'svc:intake' });
    const approved = await repo(h).transition(issueKey, 'approved', {
      actor: 'svc:api',
      approvedBy: 'operator:anush',
    });
    assert.equal(approved.approvedBy, 'operator:anush');
  });
});

describe('approval requires a human operator', () => {
  async function pending(): Promise<{ h: Harness; issueKey: string }> {
    const h = harness();
    await repo(h).create({ issueKey: 'AIS-1', source: 'webhook', snapshot: SNAPSHOT });
    await repo(h).transition('AIS-1', 'pending_approval', { actor: 'svc:intake' });
    return { h, issueKey: 'AIS-1' };
  }

  it('rejects a service identity as the approver', async () => {
    // The regression this exists for: approvedBy used to default to `actor`,
    // so a worker could record itself as the approver and D5's null check
    // would never fire.
    const { h, issueKey } = await pending();
    await assert.rejects(
      () =>
        repo(h).transition(issueKey, 'approved', {
          actor: 'svc:worker',
          approvedBy: 'svc:worker',
        }),
      ApprovalRequiresOperatorError,
    );
  });

  it('rejects an unprefixed principal', async () => {
    const { h, issueKey } = await pending();
    await assert.rejects(
      () => repo(h).transition(issueKey, 'approved', { actor: 'svc:api', approvedBy: 'anush' }),
      ApprovalRequiresOperatorError,
    );
  });

  it('rejects an empty approver', async () => {
    const { h, issueKey } = await pending();
    await assert.rejects(
      () => repo(h).transition(issueKey, 'approved', { actor: 'svc:api', approvedBy: '' }),
      ApprovalRequiresOperatorError,
    );
  });

  it('leaves the item untouched when approval is refused', async () => {
    const { h, issueKey } = await pending();
    const auditBefore = h.entries.length;

    await assert.rejects(() =>
      repo(h).transition(issueKey, 'approved', { actor: 'svc:worker', approvedBy: 'svc:worker' }),
    );

    assert.equal(h.store[0]!.status, 'pending_approval', 'status changed despite refusal');
    assert.equal(h.store[0]!.approvedBy, null, 'approvedBy was written despite refusal');
    assert.equal(h.entries.length, auditBefore, 'an audit entry was written despite refusal');
  });

  it('does not leak the rejected principal into the error message', async () => {
    const { h, issueKey } = await pending();
    await assert.rejects(
      () =>
        repo(h).transition(issueKey, 'approved', {
          actor: 'svc:api',
          approvedBy: 'svc:secret-internal-name',
        }),
      (error: unknown) => {
        assert.ok(error instanceof ApprovalRequiresOperatorError);
        assert.ok(!error.message.includes('secret-internal-name'));
        assert.equal(error.approvedBy, 'svc:secret-internal-name');
        return true;
      },
    );
  });

  it('records the approver in the audit entry, separately from the actor', async () => {
    const { h, issueKey } = await pending();
    await repo(h).transition(issueKey, 'approved', {
      actor: 'svc:api',
      approvedBy: 'operator:anush',
    });

    const entry = h.entries.at(-1)!;
    assert.equal(entry.actor, 'svc:api');
    assert.equal((entry.detail as Record<string, unknown>)['approvedBy'], 'operator:anush');
  });

  it('does not add approvedBy to the audit detail of other transitions', async () => {
    const h = harness();
    await repo(h).create({ issueKey: 'AIS-2', source: 'webhook', snapshot: SNAPSHOT });
    await repo(h).transition('AIS-2', 'pending_approval', { actor: 'svc:intake' });
    assert.ok(!('approvedBy' in (h.entries.at(-1)!.detail as Record<string, unknown>)));
  });
});
