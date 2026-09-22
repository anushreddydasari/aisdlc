import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId, type Db } from 'mongodb';

import type { AuditEntryInput, AuditLog } from '../db/audit-log.ts';
import { createLogger } from '../logging/logger.ts';
import {
  SelectionConflictError,
  SelectionNotFoundError,
  SelectionValidationError,
  createRepositorySelectionRepository,
  type RepositorySelectionDocument,
} from './repository.ts';

const logger = createLogger({ write: () => {} });

const NOW = new Date('2026-09-22T00:00:00.000Z');

interface Harness {
  readonly db: Db;
  readonly audit: AuditLog;
  readonly store: RepositorySelectionDocument[];
  readonly auditEntries: AuditEntryInput[];
}

function harness(seed: RepositorySelectionDocument[] = []): Harness {
  const store = [...seed];

  const matches = (doc: RepositorySelectionDocument, filter: Record<string, unknown>): boolean =>
    Object.entries(filter).every(([key, value]) => {
      const actual = (doc as unknown as Record<string, unknown>)[key];
      if (value instanceof ObjectId) return actual instanceof ObjectId && actual.equals(value);
      if (typeof value === 'object' && value !== null && '$in' in (value as Record<string, unknown>)) {
        return (value as { $in: unknown[] }).$in.includes(actual);
      }
      if (typeof value === 'object' && value !== null && '$lte' in (value as Record<string, unknown>)) {
        return actual instanceof Date && actual.getTime() <= (value as { $lte: Date }).$lte.getTime();
      }
      return actual === value;
    });

  const collection = {
    async findOne(filter: Record<string, unknown>) {
      const found = store.find((doc) => matches(doc, filter));
      return found ? { ...found } : null;
    },
    async insertOne(document: RepositorySelectionDocument) {
      // Mirrors the real unique index on runId, which is what makes
      // createInitial idempotent.
      if (store.some((doc) => doc.runId.equals(document.runId))) {
        throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      }
      const _id = new ObjectId();
      store.push({ ...document, _id });
      return { insertedId: _id, acknowledged: true };
    },
    async findOneAndUpdate(
      filter: Record<string, unknown>,
      update: { $set: Partial<RepositorySelectionDocument>; $inc?: { attempts: number } },
    ) {
      const found = store.find((doc) => matches(doc, filter));
      if (!found) return null;
      Object.assign(found, update.$set);
      if (update.$inc) found.attempts += update.$inc.attempts;
      return { ...found };
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

  const auditEntries: AuditEntryInput[] = [];
  const audit: AuditLog = {
    async append(entry: AuditEntryInput) {
      auditEntries.push(entry);
      return new ObjectId();
    },
    async query() {
      return [];
    },
  };

  return { db, audit, store, auditEntries };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    runId: new ObjectId(),
    intakeItemId: new ObjectId(),
    issueKey: 'CF-1',
    projectIdentifier: 'CF',
    candidateRepositoryIds: ['aisdlc-service'],
    status: 'pending' as const,
    nextAttemptAt: NOW,
    ...overrides,
  };
}

describe('createInitial', () => {
  it('creates a pending row for a fresh runId', async () => {
    const { db, audit, store } = harness();
    const repo = createRepositorySelectionRepository(db, audit, logger);

    const result = await repo.createInitial(baseInput());

    assert.equal(result.created, true);
    assert.equal(result.selection.status, 'pending');
    assert.equal(result.selection.attempts, 0);
    assert.equal(result.selection.selectedRepositoryId, null);
    assert.equal(store.length, 1);
  });

  it('is idempotent: a second call for the same runId returns the existing row', async () => {
    const { db, audit, store } = harness();
    const repo = createRepositorySelectionRepository(db, audit, logger);
    const input = baseInput();

    const first = await repo.createInitial(input);
    const second = await repo.createInitial(input);

    assert.equal(second.created, false);
    assert.equal(second.selection._id!.toHexString(), first.selection._id!.toHexString());
    assert.equal(store.length, 1);
  });

  it('creates a failed row with a failureReason when there is no candidate', async () => {
    const { db, audit } = harness();
    const repo = createRepositorySelectionRepository(db, audit, logger);

    const result = await repo.createInitial(
      baseInput({ candidateRepositoryIds: [], status: 'failed', failureReason: 'no active repository mapped' }),
    );

    assert.equal(result.selection.status, 'failed');
    assert.equal(result.selection.failureReason, 'no active repository mapped');
  });

  it('creates an ambiguous row with multiple candidates', async () => {
    const { db, audit } = harness();
    const repo = createRepositorySelectionRepository(db, audit, logger);

    const result = await repo.createInitial(
      baseInput({ candidateRepositoryIds: ['repo-a', 'repo-b'], status: 'ambiguous' }),
    );

    assert.deepEqual(result.selection.candidateRepositoryIds, ['repo-a', 'repo-b']);
    assert.equal(result.selection.status, 'ambiguous');
  });
});

describe('findByRunId', () => {
  it('returns null when nothing has been created', async () => {
    const { db, audit } = harness();
    const repo = createRepositorySelectionRepository(db, audit, logger);
    assert.equal(await repo.findByRunId(new ObjectId()), null);
  });

  it('returns the stored row', async () => {
    const { db, audit } = harness();
    const repo = createRepositorySelectionRepository(db, audit, logger);
    const input = baseInput();
    await repo.createInitial(input);

    const found = await repo.findByRunId(input.runId);
    assert.equal(found?.issueKey, 'CF-1');
  });
});

describe('recordMatchResult', () => {
  it('updates a failed row to pending when a candidate now exists, incrementing attempts', async () => {
    const { db, audit } = harness();
    const repo = createRepositorySelectionRepository(db, audit, logger);
    const input = baseInput({ candidateRepositoryIds: [], status: 'failed', failureReason: 'no match' });
    const { selection } = await repo.createInitial(input);

    const updated = await repo.recordMatchResult(selection.runId, {
      candidateRepositoryIds: ['aisdlc-service'],
      status: 'pending',
      nextAttemptAt: NOW,
    });

    assert.equal(updated?.status, 'pending');
    assert.equal(updated?.failureReason, null);
    assert.equal(updated?.attempts, 1);
  });

  it('is a no-op (returns null) for a row that is already pending', async () => {
    const { db, audit } = harness();
    const repo = createRepositorySelectionRepository(db, audit, logger);
    const { selection } = await repo.createInitial(baseInput());

    const result = await repo.recordMatchResult(selection.runId, {
      candidateRepositoryIds: ['aisdlc-service'],
      status: 'pending',
      nextAttemptAt: NOW,
    });

    assert.equal(result, null);
  });

  it('is a no-op (returns null) for a row that has already been selected', async () => {
    const { db, audit } = harness();
    const repo = createRepositorySelectionRepository(db, audit, logger);
    const { selection } = await repo.createInitial(baseInput());
    await repo.confirm(selection.runId, {
      repositoryId: 'aisdlc-service',
      repositoryUrl: 'https://github.com/cloudfuze/aisdlc-service',
      defaultBranch: 'main',
      allowedBranches: ['main'],
      accessPolicy: null,
      confirmedBy: 'operator:alice',
    });

    const result = await repo.recordMatchResult(selection.runId, {
      candidateRepositoryIds: [],
      status: 'failed',
      nextAttemptAt: NOW,
    });

    assert.equal(result, null, 'must never overwrite an already-selected row');
  });

  it('sets lastNotifiedStatus only when explicitly provided', async () => {
    const { db, audit } = harness();
    const repo = createRepositorySelectionRepository(db, audit, logger);
    const { selection } = await repo.createInitial(baseInput({ candidateRepositoryIds: [], status: 'failed' }));

    const updated = await repo.recordMatchResult(selection.runId, {
      candidateRepositoryIds: [],
      status: 'failed',
      nextAttemptAt: NOW,
      lastNotifiedStatus: 'failed',
    });

    assert.equal(updated?.lastNotifiedStatus, 'failed');
  });
});

describe('confirm', () => {
  it('confirms a pending selection and snapshots the registry fields', async () => {
    const { db, audit, auditEntries } = harness();
    const repo = createRepositorySelectionRepository(db, audit, logger);
    const { selection } = await repo.createInitial(baseInput());

    const confirmed = await repo.confirm(selection.runId, {
      repositoryId: 'aisdlc-service',
      repositoryUrl: 'https://github.com/cloudfuze/aisdlc-service',
      defaultBranch: 'main',
      allowedBranches: ['main', 'feature/*'],
      accessPolicy: null,
      confirmedBy: 'operator:alice',
    });

    assert.equal(confirmed.status, 'selected');
    assert.equal(confirmed.selectedRepositoryId, 'aisdlc-service');
    assert.equal(confirmed.confirmedBy, 'operator:alice');
    assert.ok(confirmed.confirmedAt instanceof Date);

    assert.equal(auditEntries.length, 1);
    assert.equal(auditEntries[0]!.action, 'repository-selection.confirmed');
    assert.equal(auditEntries[0]!.actor, 'operator:alice');
  });

  it('confirms an ambiguous selection when the chosen id is among the candidates', async () => {
    const { db, audit } = harness();
    const repo = createRepositorySelectionRepository(db, audit, logger);
    const { selection } = await repo.createInitial(
      baseInput({ candidateRepositoryIds: ['repo-a', 'repo-b'], status: 'ambiguous' }),
    );

    const confirmed = await repo.confirm(selection.runId, {
      repositoryId: 'repo-b',
      repositoryUrl: 'https://github.com/cloudfuze/repo-b',
      defaultBranch: 'main',
      allowedBranches: ['main'],
      accessPolicy: null,
      confirmedBy: 'operator:bob',
    });

    assert.equal(confirmed.selectedRepositoryId, 'repo-b');
  });

  it('rejects a repositoryId that is not among the candidates', async () => {
    const { db, audit } = harness();
    const repo = createRepositorySelectionRepository(db, audit, logger);
    const { selection } = await repo.createInitial(baseInput());

    await assert.rejects(
      () =>
        repo.confirm(selection.runId, {
          repositoryId: 'some-other-repo',
          repositoryUrl: 'https://github.com/cloudfuze/some-other-repo',
          defaultBranch: 'main',
          allowedBranches: ['main'],
          accessPolicy: null,
          confirmedBy: 'operator:alice',
        }),
      (error: unknown) => error instanceof SelectionValidationError && error.field === 'repositoryId',
    );
  });

  it('rejects confirming an already-selected row', async () => {
    const { db, audit } = harness();
    const repo = createRepositorySelectionRepository(db, audit, logger);
    const { selection } = await repo.createInitial(baseInput());
    await repo.confirm(selection.runId, {
      repositoryId: 'aisdlc-service',
      repositoryUrl: 'https://github.com/cloudfuze/aisdlc-service',
      defaultBranch: 'main',
      allowedBranches: ['main'],
      accessPolicy: null,
      confirmedBy: 'operator:alice',
    });

    await assert.rejects(
      () =>
        repo.confirm(selection.runId, {
          repositoryId: 'aisdlc-service',
          repositoryUrl: 'https://github.com/cloudfuze/aisdlc-service',
          defaultBranch: 'main',
          allowedBranches: ['main'],
          accessPolicy: null,
          confirmedBy: 'operator:bob',
        }),
      SelectionConflictError,
    );
  });

  it('rejects confirming a failed row (no candidates to choose from)', async () => {
    const { db, audit } = harness();
    const repo = createRepositorySelectionRepository(db, audit, logger);
    const { selection } = await repo.createInitial(
      baseInput({ candidateRepositoryIds: [], status: 'failed', failureReason: 'no match' }),
    );

    await assert.rejects(
      () =>
        repo.confirm(selection.runId, {
          repositoryId: 'aisdlc-service',
          repositoryUrl: 'https://github.com/cloudfuze/aisdlc-service',
          defaultBranch: 'main',
          allowedBranches: ['main'],
          accessPolicy: null,
          confirmedBy: 'operator:alice',
        }),
      SelectionConflictError,
    );
  });

  it('throws SelectionNotFoundError for an unknown runId', async () => {
    const { db, audit } = harness();
    const repo = createRepositorySelectionRepository(db, audit, logger);

    await assert.rejects(
      () =>
        repo.confirm(new ObjectId(), {
          repositoryId: 'aisdlc-service',
          repositoryUrl: 'https://github.com/cloudfuze/aisdlc-service',
          defaultBranch: 'main',
          allowedBranches: ['main'],
          accessPolicy: null,
          confirmedBy: 'operator:alice',
        }),
      SelectionNotFoundError,
    );
  });
});

describe('findDueForRetry', () => {
  it('returns only failed/ambiguous rows whose nextAttemptAt has passed', async () => {
    const { db, audit } = harness();
    const repo = createRepositorySelectionRepository(db, audit, logger);

    const due = await repo.createInitial(
      baseInput({ candidateRepositoryIds: [], status: 'failed', nextAttemptAt: new Date(NOW.getTime() - 1000) }),
    );
    await repo.createInitial(
      baseInput({
        runId: new ObjectId(),
        candidateRepositoryIds: [],
        status: 'failed',
        nextAttemptAt: new Date(NOW.getTime() + 100_000),
      }),
    );
    await repo.createInitial(baseInput({ runId: new ObjectId(), status: 'pending' }));

    const results = await repo.findDueForRetry(NOW, 10);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.runId.toHexString(), due.selection.runId.toHexString());
  });
});
