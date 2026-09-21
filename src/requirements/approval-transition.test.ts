import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId, type Db } from 'mongodb';

import type { AuditEntryInput, AuditLog } from '../db/audit-log.ts';
import { createIntakeRepository, type IntakeItemDocument, type IntakeSnapshot } from '../intake/repository.ts';
import { createLogger } from '../logging/logger.ts';
import type { RequirementsOutcome } from './worker.ts';
import { REQUIREMENTS_AGENT_SYSTEM_ACTOR, advanceToPendingApproval } from './approval-transition.ts';

const SNAPSHOT: IntakeSnapshot = {
  title: 'Login fails for SSO users',
  description: 'Steps to reproduce...',
  issueType: 'bug',
};

/**
 * Real createIntakeRepository backed by a fake Mongo collection, mirroring
 * intake/repository.test.ts's own harness exactly — this exercises the
 * REAL transition() compare-and-set and audit-append logic, not a stand-in,
 * so the concurrency and audit assertions below mean something.
 */
interface Harness {
  readonly intake: ReturnType<typeof createIntakeRepository>;
  readonly store: IntakeItemDocument[];
  readonly auditEntries: AuditEntryInput[];
  readonly logs: string[];
  /** Makes the next findOneAndUpdate match nothing, simulating a race. */
  failNextUpdateWithConflict(): void;
}

function harness(itemOverrides: Partial<IntakeItemDocument> = {}): Harness {
  const now = new Date('2026-09-23T00:00:00.000Z');
  const store: IntakeItemDocument[] = [
    {
      _id: new ObjectId(),
      issueKey: 'CF-1',
      source: 'webhook',
      deliveryRef: null,
      snapshot: SNAPSHOT,
      snapshotMeta: null,
      sourceHash: 'hash-1',
      status: 'received',
      statusReason: null,
      approvedBy: null,
      approvedAt: null,
      receivedAt: now,
      createdAt: now,
      updatedAt: now,
      ...itemOverrides,
    },
  ];
  const auditEntries: AuditEntryInput[] = [];
  const logs: string[] = [];
  let conflictNext = false;

  const matches = (doc: IntakeItemDocument, filter: Record<string, unknown>): boolean =>
    Object.entries(filter).every(
      ([key, value]) => (doc as unknown as Record<string, unknown>)[key] === value,
    );

  const collection = {
    async findOne(filter: Record<string, unknown>) {
      const found = store.find((doc) => matches(doc, filter));
      return found ? { ...found } : null;
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
      return { ...found };
    },
  };

  const db = { collection: () => collection } as unknown as Db;
  const audit: AuditLog = {
    async append(entry) {
      auditEntries.push(entry);
      return new ObjectId();
    },
    async query() {
      return [];
    },
  };
  const logger = createLogger({ write: (line) => logs.push(line) });

  return {
    intake: createIntakeRepository(db, audit, logger),
    store,
    auditEntries,
    logs,
    failNextUpdateWithConflict: () => {
      conflictNext = true;
    },
  };
}

function deps(h: Harness) {
  return { intake: h.intake, logger: createLogger({ write: (line) => h.logs.push(line) }) };
}

describe('a fresh completed analysis', () => {
  it('transitions received -> pending_approval', async () => {
    const h = harness();
    const result = await advanceToPendingApproval(h.store[0]!, 'completed', deps(h));

    assert.equal(result, 'transitioned');
    assert.equal(h.store[0]!.status, 'pending_approval');
  });

  it('records the system actor, not a human operator', async () => {
    const h = harness();
    await advanceToPendingApproval(h.store[0]!, 'completed', deps(h));

    const entry = h.auditEntries.find((e) => e.action === 'intake.pending_approval');
    assert.ok(entry, 'no audit entry for the transition');
    assert.equal(entry!.actor, REQUIREMENTS_AGENT_SYSTEM_ACTOR);
    assert.equal(REQUIREMENTS_AGENT_SYSTEM_ACTOR, 'system:requirements-agent');
  });

  it('creates an audit entry via the existing mechanism (transition())', async () => {
    const h = harness();
    await advanceToPendingApproval(h.store[0]!, 'completed', deps(h));

    const entry = h.auditEntries.find((e) => e.action === 'intake.pending_approval');
    assert.ok(entry);
    assert.equal(entry!.subjectType, 'intakeItem');
    assert.ok(entry!.subjectId);
  });

  it('never approves — the final state is pending_approval, not approved', async () => {
    const h = harness();
    await advanceToPendingApproval(h.store[0]!, 'completed', deps(h));
    assert.equal(h.store[0]!.status, 'pending_approval');
    assert.notEqual(h.store[0]!.status, 'approved');
  });
});

describe('outcomes that must not transition anything', () => {
  const NON_TRANSITIONING: RequirementsOutcome[] = [
    'failed_validation',
    'failed_analysis',
    'skipped_up_to_date',
  ];

  for (const outcome of NON_TRANSITIONING) {
    it(`leaves the item unchanged for ${outcome}`, async () => {
      const h = harness();
      const result = await advanceToPendingApproval(h.store[0]!, outcome, deps(h));

      assert.equal(result, 'skipped_no_fresh_completion');
      assert.equal(h.store[0]!.status, 'received', 'status must not move');
      assert.equal(
        h.auditEntries.filter((e) => e.action === 'intake.pending_approval').length,
        0,
        'no transition audit entry should exist',
      );
    });
  }
});

describe('an item already in another state', () => {
  for (const status of ['pending_approval', 'approved', 'rejected', 'failed'] as const) {
    it(`does not force a transition when already ${status}`, async () => {
      const h = harness({ status });
      const result = await advanceToPendingApproval(h.store[0]!, 'completed', deps(h));

      assert.equal(result, 'skipped_not_received');
      assert.equal(h.store[0]!.status, status, 'status must be left exactly as it was');
      assert.equal(
        h.auditEntries.filter((e) => e.action === 'intake.pending_approval').length,
        0,
      );
    });
  }

  it('logs the reason rather than throwing', async () => {
    const h = harness({ status: 'approved' });
    // Must resolve, not reject — an already-approved item is an expected,
    // non-fatal case, not an error.
    await assert.doesNotReject(() => advanceToPendingApproval(h.store[0]!, 'completed', deps(h)));
    assert.ok(h.logs.some((line) => line.includes('not in received state')));
  });
});

describe('concurrent modification', () => {
  it('reports a conflict rather than corrupting state or throwing', async () => {
    const h = harness();
    h.failNextUpdateWithConflict();

    const result = await advanceToPendingApproval(h.store[0]!, 'completed', deps(h));

    assert.equal(result, 'conflict');
    // The race means the write never happened; the stored item is
    // untouched by this call (whatever the OTHER writer did is out of
    // scope for this fake, which models "someone else won").
    assert.equal(h.store[0]!.status, 'received');
    assert.equal(
      h.auditEntries.filter((e) => e.action === 'intake.pending_approval').length,
      0,
    );
  });

  it('logs the conflict safely, without throwing', async () => {
    const h = harness();
    h.failNextUpdateWithConflict();
    await assert.doesNotReject(() => advanceToPendingApproval(h.store[0]!, 'completed', deps(h)));
    assert.ok(h.logs.some((line) => line.includes('concurrent modification')));
  });
});

describe('idempotency: repeated execution', () => {
  it('a second call after a successful transition does not create a duplicate transition', async () => {
    const h = harness();
    const item = h.store[0]!;

    const first = await advanceToPendingApproval(item, 'completed', deps(h));
    assert.equal(first, 'transitioned');
    assert.equal(item.status, 'pending_approval');

    // Simulates a caller that (incorrectly, or via a stale local copy)
    // calls again with the same 'completed' outcome. Because
    // intake.transition() re-reads the CURRENT status itself, this fails
    // safely rather than re-transitioning.
    const second = await advanceToPendingApproval(item, 'completed', deps(h));
    assert.equal(second, 'skipped_not_received');

    assert.equal(
      h.auditEntries.filter((e) => e.action === 'intake.pending_approval').length,
      1,
      'must never produce a second transition audit entry',
    );
  });

  it('mirrors the real flow: runRequirementsAgent returns skipped_up_to_date on a genuine repeat, which never attempts a transition at all', async () => {
    // This is the actual guarantee in production: worker.ts's own
    // idempotency (inputHash comparison) is what stops a second CLI run
    // from ever reaching this function with 'completed' a second time for
    // unchanged content. Exercised here as the outcome this function must
    // handle correctly, since worker.ts's own behavior is covered in
    // worker.test.ts.
    const h = harness();
    const result = await advanceToPendingApproval(h.store[0]!, 'skipped_up_to_date', deps(h));
    assert.equal(result, 'skipped_no_fresh_completion');
    assert.equal(h.store[0]!.status, 'received');
  });
});
