import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId } from 'mongodb';

import type { AuditEntryInput, AuditLog } from '../db/audit-log.ts';
import { createLogger } from '../logging/logger.ts';
import type { IntakeItemDocument, IntakeRepository } from '../intake/repository.ts';
import type { CreateRunInput, RunDocument, RunsRepository } from './repository.ts';
import { ORCHESTRATOR_SYSTEM_ACTOR, queueApprovedRuns, type QueueApprovedRunsDeps } from './worker.ts';

const NOW = new Date('2026-09-23T12:00:00.000Z');

function approvedItem(overrides: Partial<IntakeItemDocument> = {}): IntakeItemDocument {
  return {
    _id: new ObjectId(),
    issueKey: 'CF-1',
    source: 'webhook',
    deliveryRef: null,
    snapshot: { title: 't', description: 'd', issueType: 'bug' },
    snapshotMeta: null,
    sourceHash: 'hash',
    status: 'approved',
    statusReason: null,
    approvedBy: 'operator:jane',
    approvedAt: NOW,
    receivedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

interface Harness {
  readonly deps: QueueApprovedRunsDeps;
  readonly runsStore: RunDocument[];
  readonly auditEntries: AuditEntryInput[];
  readonly listCalls: Record<string, unknown>[];
  readonly logs: string[];
}

function harness(
  options: {
    approved?: IntakeItemDocument[];
    createThrowsFor?: string; // issueKey
  } = {},
): Harness {
  const runsStore: RunDocument[] = [];
  const auditEntries: AuditEntryInput[] = [];
  const listCalls: Record<string, unknown>[] = [];
  const logs: string[] = [];

  const intake = {
    async list(filter: Record<string, unknown> = {}) {
      listCalls.push(filter);
      return options.approved ?? [];
    },
  } as unknown as IntakeRepository;

  const runs: RunsRepository = {
    async createIfAbsent(input: CreateRunInput) {
      if (options.createThrowsFor === input.issueKey) {
        throw new Error('mongo exploded');
      }
      const existing = runsStore.find((r) => r.intakeItemId.equals(input.intakeItemId));
      if (existing) return { created: false, run: existing };
      const run: RunDocument = {
        _id: new ObjectId(),
        intakeItemId: input.intakeItemId,
        issueKey: input.issueKey,
        status: 'queued',
        trigger: input.trigger,
        createdAt: NOW,
        startedAt: null,
        completedAt: null,
        updatedAt: NOW,
      };
      runsStore.push(run);
      return { created: true, run };
    },
    async findByIntakeItemId(intakeItemId) {
      return runsStore.find((r) => r.intakeItemId.equals(intakeItemId)) ?? null;
    },
    async findById(runId) {
      return runsStore.find((r) => r._id?.equals(runId)) ?? null;
    },
    async list() {
      return runsStore;
    },
  };

  const audit: AuditLog = {
    async append(entry) {
      auditEntries.push(entry);
      return new ObjectId();
    },
    async query() {
      return [];
    },
  };

  return {
    deps: { intake, runs, audit, logger: createLogger({ write: (line) => logs.push(line) }) },
    runsStore,
    auditEntries,
    listCalls,
    logs,
  };
}

describe('queueApprovedRuns: happy path', () => {
  it('queues a run for an approved intake item', async () => {
    const item = approvedItem();
    const h = harness({ approved: [item] });

    const summary = await queueApprovedRuns(h.deps);

    assert.equal(summary.examined, 1);
    assert.equal(summary.queued, 1);
    assert.equal(summary.alreadyQueued, 0);
    assert.equal(summary.failed, 0);
    assert.equal(h.runsStore.length, 1);
    assert.equal(h.runsStore[0]!.status, 'queued');
    assert.equal(h.runsStore[0]!.trigger, 'approval');
  });

  it('only queries intakeItems with status approved', async () => {
    const h = harness({ approved: [] });
    await queueApprovedRuns(h.deps);
    assert.equal(h.listCalls.length, 1);
    assert.deepEqual(h.listCalls[0], { status: 'approved' });
  });

  it('records an audit entry with the system actor, action, and subject', async () => {
    const item = approvedItem();
    const h = harness({ approved: [item] });

    await queueApprovedRuns(h.deps);

    assert.equal(h.auditEntries.length, 1);
    const entry = h.auditEntries[0]!;
    assert.equal(entry.actor, ORCHESTRATOR_SYSTEM_ACTOR);
    assert.equal(ORCHESTRATOR_SYSTEM_ACTOR, 'system:orchestrator');
    assert.equal(entry.action, 'run.queued');
    assert.equal(entry.subjectType, 'run');
    assert.ok(entry.subjectId);
  });

  it('queues a run for every approved item in the batch', async () => {
    const a = approvedItem({ issueKey: 'CF-1' });
    const b = approvedItem({ issueKey: 'CF-2' });
    const h = harness({ approved: [a, b] });

    const summary = await queueApprovedRuns(h.deps);

    assert.equal(summary.queued, 2);
    assert.equal(h.runsStore.length, 2);
  });
});

describe('queueApprovedRuns: idempotency', () => {
  it('does not queue a second run when one already exists (repeated execution is safe)', async () => {
    const item = approvedItem();
    const h = harness({ approved: [item] });

    const first = await queueApprovedRuns(h.deps);
    const second = await queueApprovedRuns(h.deps);

    assert.equal(first.queued, 1);
    assert.equal(second.queued, 0);
    assert.equal(second.alreadyQueued, 1);
    assert.equal(h.runsStore.length, 1, 'must never create a second run');
    assert.equal(h.auditEntries.length, 1, 'must never audit a second time');
  });
});

describe('queueApprovedRuns: resilience', () => {
  it('one failing item does not stop the rest of the pass', async () => {
    const bad = approvedItem({ issueKey: 'CF-BAD' });
    const good = approvedItem({ issueKey: 'CF-GOOD' });
    const h = harness({ approved: [bad, good], createThrowsFor: 'CF-BAD' });

    const summary = await queueApprovedRuns(h.deps);

    assert.equal(summary.failed, 1);
    assert.equal(summary.queued, 1);
    assert.equal(h.runsStore.length, 1);
    assert.equal(h.runsStore[0]!.issueKey, 'CF-GOOD');
    assert.ok(h.logs.join('\n').includes('failed to queue run'));
  });
});

describe('queueApprovedRuns: no-ops', () => {
  it('does nothing when there are no approved items', async () => {
    const h = harness({ approved: [] });
    const summary = await queueApprovedRuns(h.deps);

    assert.deepEqual(summary, { examined: 0, queued: 0, alreadyQueued: 0, failed: 0 });
    assert.equal(h.auditEntries.length, 0);
  });
});

describe('queueApprovedRuns: never writes to intakeItems', () => {
  it('never calls anything on the intake repository beyond list()', async () => {
    const item = approvedItem();
    const listOnly: IntakeRepository = {
      async create() {
        throw new Error('must not be called');
      },
      async findByIssueKey() {
        throw new Error('must not be called');
      },
      async list() {
        return [item];
      },
      async transition() {
        throw new Error('must not be called');
      },
    };
    const runsStore: RunDocument[] = [];
    const runs: RunsRepository = {
      async createIfAbsent(input) {
        const run: RunDocument = {
          _id: new ObjectId(),
          intakeItemId: input.intakeItemId,
          issueKey: input.issueKey,
          status: 'queued',
          trigger: input.trigger,
          createdAt: NOW,
          startedAt: null,
          completedAt: null,
          updatedAt: NOW,
        };
        runsStore.push(run);
        return { created: true, run };
      },
      async findByIntakeItemId() {
        return null;
      },
      async findById() {
        return null;
      },
      async list() {
        return [];
      },
    };
    const audit: AuditLog = {
      async append() {
        return new ObjectId();
      },
      async query() {
        return [];
      },
    };

    const summary = await queueApprovedRuns({
      intake: listOnly,
      runs,
      audit,
      logger: createLogger({ write: () => {} }),
    });

    assert.equal(summary.queued, 1);
  });
});
