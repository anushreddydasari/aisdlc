import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId } from 'mongodb';

import type { AuditEntryInput, AuditLog } from '../db/audit-log.ts';
import { createLogger } from '../logging/logger.ts';
import { hashSnapshot, type IntakeItemDocument, type IntakeRepository, type IntakeSnapshot } from '../intake/repository.ts';
import { assertTransition } from '../intake/state.ts';
import type { IntakeStatus } from '../db/collections.ts';
import type { CreatePendingInput, RequirementsAnalysisDocument, RequirementsRepository } from './repository.ts';
import { processReceivedIntakeItems, type RequirementsQueueDeps } from './queue.ts';

const NOW = new Date('2026-09-23T12:00:00.000Z');

const SNAPSHOT: IntakeSnapshot = {
  title: 'Login fails for SSO users',
  description: 'Users see a blank page.',
  issueType: 'bug',
};

function intakeItem(overrides: Partial<IntakeItemDocument> = {}): IntakeItemDocument {
  return {
    _id: new ObjectId(),
    issueKey: 'CF-1',
    source: 'webhook',
    deliveryRef: null,
    snapshot: SNAPSHOT,
    snapshotMeta: null,
    sourceHash: hashSnapshot(SNAPSHOT),
    status: 'received',
    statusReason: null,
    approvedBy: null,
    approvedAt: null,
    receivedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

interface Harness {
  readonly deps: RequirementsQueueDeps;
  readonly intakeStore: IntakeItemDocument[];
  readonly auditEntries: AuditEntryInput[];
}

function harness(items: IntakeItemDocument[] = [intakeItem()]): Harness {
  const intakeStore = items.map((i) => ({ ...i }));
  const auditEntries: AuditEntryInput[] = [];
  const analysisStore: RequirementsAnalysisDocument[] = [];

  const intake: IntakeRepository = {
    async create() {
      throw new Error('must not be called');
    },
    async findByIssueKey(issueKey) {
      return intakeStore.find((i) => i.issueKey === issueKey) ?? null;
    },
    async list(filter: Record<string, unknown> = {}, limit = 100) {
      const status = filter['status'] as IntakeStatus | undefined;
      return intakeStore.filter((i) => status === undefined || i.status === status).slice(0, limit);
    },
    async transition(issueKey, to) {
      const item = intakeStore.find((i) => i.issueKey === issueKey);
      if (item === undefined) throw new Error(`no intake item '${issueKey}'`);
      assertTransition(item.status, to as IntakeStatus);
      item.status = to as IntakeStatus;
      item.updatedAt = NOW;
      return { ...item };
    },
  };

  const repository: RequirementsRepository = {
    async createPending(input: CreatePendingInput) {
      const existing = analysisStore.find((r) => r.intakeItemId.equals(input.intakeItemId));
      if (existing) return { created: false, document: { ...existing } };
      const document: RequirementsAnalysisDocument = {
        _id: new ObjectId(),
        intakeItemId: input.intakeItemId,
        issueKey: input.issueKey,
        status: 'pending',
        inputHash: input.inputHash,
        result: null,
        error: null,
        attempts: 0,
        agentVersion: 'unassigned',
        usage: null,
        createdAt: NOW,
        updatedAt: NOW,
        completedAt: null,
      };
      analysisStore.push(document);
      return { created: true, document: { ...document } };
    },
    async findByIntakeItemId(intakeItemId) {
      return analysisStore.find((r) => r.intakeItemId.equals(intakeItemId)) ?? null;
    },
    async markCompleted(intakeItemId, input) {
      const row = analysisStore.find((r) => r.intakeItemId.equals(intakeItemId))!;
      Object.assign(row, { status: 'completed', result: input.result, inputHash: input.inputHash, agentVersion: input.agentVersion, completedAt: input.now, updatedAt: input.now });
      return { ...row };
    },
    async markFailed(intakeItemId, input) {
      const row = analysisStore.find((r) => r.intakeItemId.equals(intakeItemId))!;
      Object.assign(row, { status: 'failed', error: { message: input.message }, inputHash: input.inputHash, agentVersion: input.agentVersion, updatedAt: input.now });
      return { ...row };
    },
    async recordUsage() {
      throw new Error('must not be called');
    },
  };

  const audit: AuditLog = {
    async append(entry: AuditEntryInput) {
      auditEntries.push(entry);
      return new ObjectId();
    },
    async query() {
      return [];
    },
  };

  return {
    deps: { intake, repository, audit, logger: createLogger({ write: () => {} }), now: () => NOW },
    intakeStore,
    auditEntries,
  };
}

describe('processReceivedIntakeItems', () => {
  it('runs requirements analysis and advances a received item to pending_approval', async () => {
    const h = harness();
    const summary = await processReceivedIntakeItems(h.deps);

    assert.equal(summary.examined, 1);
    assert.equal(summary.completed, 1);
    assert.equal(summary.advancedToApproval, 1);
    assert.equal(h.intakeStore[0]!.status, 'pending_approval');
  });

  it('never queries or touches items in any other status', async () => {
    const h = harness([intakeItem({ status: 'approved' }), intakeItem({ issueKey: 'CF-2', status: 'received' })]);
    const summary = await processReceivedIntakeItems(h.deps);

    assert.equal(summary.examined, 1);
    assert.equal(h.intakeStore.find((i) => i.issueKey === 'CF-1')!.status, 'approved');
  });

  it('is idempotent: a second pass over an already-advanced item does nothing further', async () => {
    const h = harness();
    await processReceivedIntakeItems(h.deps);
    // The item is now pending_approval, so the next pass's `received` query returns nothing for it.
    const second = await processReceivedIntakeItems(h.deps);

    assert.equal(second.examined, 0);
    assert.equal(h.intakeStore[0]!.status, 'pending_approval');
  });

  it('advances a received item whose analysis already completed elsewhere, without re-analyzing', async () => {
    const h = harness();
    // Simulates an out-of-band analysis (e.g. `npm run requirements:run`): completed, but the item left `received`.
    await processReceivedIntakeItems(h.deps);
    h.intakeStore[0]!.status = 'received';

    const summary = await processReceivedIntakeItems(h.deps);

    assert.equal(summary.skipped, 1);
    assert.equal(summary.completed, 0);
    assert.equal(summary.advancedToApproval, 1);
    assert.equal(h.intakeStore[0]!.status, 'pending_approval');
  });

  it('one failing item does not stop the pass', async () => {
    const good = intakeItem({ issueKey: 'CF-2' });
    const bad = intakeItem({ issueKey: 'CF-1', snapshot: { ...SNAPSHOT, title: '' } });
    const h = harness([bad, good]);
    const summary = await processReceivedIntakeItems(h.deps);

    assert.equal(summary.examined, 2);
    assert.equal(summary.completed, 1);
    assert.equal(h.intakeStore.find((i) => i.issueKey === 'CF-2')!.status, 'pending_approval');
    // The bad item stays `received` — nothing to advance to for a human to review.
    assert.equal(h.intakeStore.find((i) => i.issueKey === 'CF-1')!.status, 'received');
  });
});
