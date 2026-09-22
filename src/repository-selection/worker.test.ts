import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId } from 'mongodb';

import type { AuditEntryInput, AuditLog } from '../db/audit-log.ts';
import { createLogger } from '../logging/logger.ts';
import type { IntakeItemDocument, IntakeRepository } from '../intake/repository.ts';
import type { RunDocument, RunsRepository } from '../orchestrator/repository.ts';
import type {
  CreateRegistryEntryInput,
  RepositoryRegistryDocument,
  RepositoryRegistryRepository,
} from '../repository-registry/repository.ts';
import type { RepositorySelectionDocument, RepositorySelectionRepository } from './repository.ts';
import {
  REPOSITORY_SELECTION_SYSTEM_ACTOR,
  backoffMs,
  classifyCandidates,
  matchRepositorySelections,
  type MatchRepositorySelectionsDeps,
} from './worker.ts';

const NOW = new Date('2026-09-23T12:00:00.000Z');

function intakeItem(overrides: Partial<IntakeItemDocument> = {}): IntakeItemDocument {
  return {
    _id: new ObjectId(),
    issueKey: 'CF-1',
    source: 'webhook',
    deliveryRef: null,
    snapshot: { title: 't', description: 'd', issueType: 'bug', project: 'CF' },
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

function run(overrides: Partial<RunDocument> = {}): RunDocument {
  return {
    _id: new ObjectId(),
    intakeItemId: new ObjectId(),
    issueKey: 'CF-1',
    status: 'queued',
    trigger: 'approval',
    createdAt: NOW,
    startedAt: null,
    completedAt: null,
    updatedAt: NOW,
    ...overrides,
  };
}

function registryEntry(overrides: Partial<RepositoryRegistryDocument> = {}): RepositoryRegistryDocument {
  return {
    _id: new ObjectId(),
    projectIdentifier: 'CF',
    repositoryId: 'aisdlc-service',
    repositoryUrl: 'https://github.com/cloudfuze/aisdlc-service',
    defaultBranch: 'main',
    allowedBranches: ['main'],
    status: 'active',
    accessPolicy: null,
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: 'operator:alice',
    updatedBy: 'operator:alice',
    ...overrides,
  };
}

function selectionDoc(overrides: Partial<RepositorySelectionDocument> = {}): RepositorySelectionDocument {
  return {
    _id: new ObjectId(),
    runId: new ObjectId(),
    intakeItemId: new ObjectId(),
    issueKey: 'CF-1',
    projectIdentifier: 'CF',
    candidateRepositoryIds: [],
    selectedRepositoryId: null,
    selectedRepositoryUrl: null,
    selectedDefaultBranch: null,
    selectedAllowedBranches: null,
    selectedAccessPolicy: null,
    status: 'failed',
    failureReason: 'no active repository is mapped to project \'CF\'',
    attempts: 1,
    nextAttemptAt: NOW,
    confirmedBy: null,
    confirmedAt: null,
    lastNotifiedStatus: 'failed',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

interface Harness {
  readonly deps: MatchRepositorySelectionsDeps;
  readonly selectionsStore: RepositorySelectionDocument[];
  readonly auditEntries: AuditEntryInput[];
  readonly logs: string[];
}

function harness(
  options: {
    runs?: RunDocument[];
    intakeItems?: IntakeItemDocument[];
    registryEntries?: RepositoryRegistryDocument[];
    dueForRetry?: RepositorySelectionDocument[];
    createInitialThrowsFor?: string; // issueKey
  } = {},
): Harness {
  const selectionsStore: RepositorySelectionDocument[] = [];
  const auditEntries: AuditEntryInput[] = [];
  const logs: string[] = [];

  const intake: IntakeRepository = {
    async create() {
      throw new Error('must not be called');
    },
    async findByIssueKey(issueKey: string) {
      return options.intakeItems?.find((i) => i.issueKey === issueKey) ?? null;
    },
    async list() {
      throw new Error('must not be called');
    },
    async transition() {
      throw new Error('must not be called');
    },
  };

  const runsRepo: RunsRepository = {
    async createIfAbsent() {
      throw new Error('must not be called');
    },
    async findByIntakeItemId() {
      throw new Error('must not be called');
    },
    async findById() {
      throw new Error('must not be called');
    },
    async list() {
      return options.runs ?? [];
    },
  };

  const registry: RepositoryRegistryRepository = {
    async create(_input: CreateRegistryEntryInput) {
      throw new Error('must not be called');
    },
    async findById() {
      throw new Error('must not be called');
    },
    async list() {
      throw new Error('must not be called');
    },
    async findActiveByProjectIdentifier(projectIdentifier: string) {
      return (options.registryEntries ?? []).filter(
        (e) => e.projectIdentifier === projectIdentifier && e.status === 'active',
      );
    },
    async update() {
      throw new Error('must not be called');
    },
    async setStatus() {
      throw new Error('must not be called');
    },
  };

  const selections: RepositorySelectionRepository = {
    async findByRunId(runId) {
      return selectionsStore.find((s) => s.runId.equals(runId)) ?? null;
    },
    async createInitial(input) {
      if (options.createInitialThrowsFor === input.issueKey) throw new Error('mongo exploded');
      const doc = selectionDoc({
        _id: new ObjectId(),
        runId: input.runId,
        intakeItemId: input.intakeItemId,
        issueKey: input.issueKey,
        projectIdentifier: input.projectIdentifier,
        candidateRepositoryIds: [...input.candidateRepositoryIds],
        status: input.status,
        failureReason: input.failureReason ?? null,
        attempts: 0,
        nextAttemptAt: input.nextAttemptAt,
        lastNotifiedStatus: input.lastNotifiedStatus ?? null,
      });
      selectionsStore.push(doc);
      return { created: true, selection: doc };
    },
    async recordMatchResult(runId, input) {
      const found = selectionsStore.find((s) => s.runId.equals(runId));
      if (!found || (found.status !== 'failed' && found.status !== 'ambiguous')) return null;
      found.candidateRepositoryIds = [...input.candidateRepositoryIds];
      found.status = input.status;
      found.failureReason = input.failureReason ?? null;
      found.nextAttemptAt = input.nextAttemptAt;
      found.attempts += 1;
      if (input.lastNotifiedStatus !== undefined) found.lastNotifiedStatus = input.lastNotifiedStatus;
      return { ...found };
    },
    async confirm() {
      throw new Error('must not be called');
    },
    async findDueForRetry() {
      return options.dueForRetry ?? [];
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
    deps: {
      intake,
      runs: runsRepo,
      registry,
      selections,
      audit,
      logger: createLogger({ level: 'debug', write: (line) => logs.push(line) }),
      now: () => NOW,
    },
    selectionsStore,
    auditEntries,
    logs,
  };
}

describe('classifyCandidates', () => {
  it('classifies zero, one, and many candidates', () => {
    assert.equal(classifyCandidates([]), 'failed');
    assert.equal(classifyCandidates(['a']), 'pending');
    assert.equal(classifyCandidates(['a', 'b']), 'ambiguous');
  });
});

describe('backoffMs', () => {
  it('doubles from the base and caps at the maximum', () => {
    assert.equal(backoffMs(0), 60_000);
    assert.equal(backoffMs(1), 120_000);
    assert.equal(backoffMs(10), 60 * 60_000);
  });
});

describe('matchRepositorySelections: new queued runs', () => {
  it('creates a pending selection for a single active mapping, without notifying', async () => {
    const theRun = run();
    const item = intakeItem({ issueKey: theRun.issueKey, _id: theRun.intakeItemId });
    const entry = registryEntry();
    const h = harness({ runs: [theRun], intakeItems: [item], registryEntries: [entry] });

    const summary = await matchRepositorySelections(h.deps);

    assert.equal(summary.pending, 1);
    assert.equal(summary.ambiguous, 0);
    assert.equal(summary.failed, 0);
    assert.equal(h.selectionsStore[0]!.status, 'pending');
    assert.deepEqual(h.selectionsStore[0]!.candidateRepositoryIds, ['aisdlc-service']);
    assert.equal(h.auditEntries.length, 0, 'a single match must not notify');
  });

  it('creates a failed selection and notifies when no active mapping exists', async () => {
    const theRun = run();
    const item = intakeItem({ issueKey: theRun.issueKey, _id: theRun.intakeItemId });
    const h = harness({ runs: [theRun], intakeItems: [item], registryEntries: [] });

    const summary = await matchRepositorySelections(h.deps);

    assert.equal(summary.failed, 1);
    assert.equal(h.selectionsStore[0]!.status, 'failed');
    assert.ok(h.selectionsStore[0]!.failureReason?.includes("project 'CF'"));

    assert.equal(h.auditEntries.length, 1);
    assert.equal(h.auditEntries[0]!.action, 'repository-selection.notification');
    assert.equal(h.auditEntries[0]!.actor, REPOSITORY_SELECTION_SYSTEM_ACTOR);
  });

  it('creates an ambiguous selection and notifies when multiple active mappings exist', async () => {
    const theRun = run();
    const item = intakeItem({ issueKey: theRun.issueKey, _id: theRun.intakeItemId });
    const h = harness({
      runs: [theRun],
      intakeItems: [item],
      registryEntries: [registryEntry(), registryEntry({ _id: new ObjectId(), repositoryId: 'other-repo' })],
    });

    const summary = await matchRepositorySelections(h.deps);

    assert.equal(summary.ambiguous, 1);
    assert.equal(h.selectionsStore[0]!.status, 'ambiguous');
    assert.equal(h.auditEntries.length, 1);
  });

  it('treats a missing project identifier as a failure, never as a match', async () => {
    const theRun = run();
    const item = intakeItem({
      issueKey: theRun.issueKey,
      _id: theRun.intakeItemId,
      snapshot: { title: 't', description: 'd', issueType: 'bug', project: null },
    });
    const h = harness({ runs: [theRun], intakeItems: [item], registryEntries: [registryEntry()] });

    const summary = await matchRepositorySelections(h.deps);

    assert.equal(summary.failed, 1);
    assert.equal(h.selectionsStore[0]!.failureReason, 'intake item has no project identifier');
  });

  it('does not re-examine a run that already has a selection', async () => {
    const theRun = run();
    const item = intakeItem({ issueKey: theRun.issueKey, _id: theRun.intakeItemId });
    const h = harness({ runs: [theRun], intakeItems: [item], registryEntries: [registryEntry()] });
    await matchRepositorySelections(h.deps);
    assert.equal(h.selectionsStore.length, 1);

    const summary = await matchRepositorySelections(h.deps);
    assert.equal(summary.newlyExamined, 0);
    assert.equal(h.selectionsStore.length, 1, 'must not create a second row for the same run');
  });

  it('skips a queued run whose intake item cannot be found, without throwing', async () => {
    const theRun = run();
    const h = harness({ runs: [theRun], intakeItems: [], registryEntries: [] });

    const summary = await matchRepositorySelections(h.deps);

    assert.equal(summary.skipped, 1);
    assert.equal(h.selectionsStore.length, 0);
  });

  it('one failing run does not stop the rest of the pass', async () => {
    const runA = run({ issueKey: 'CF-1' });
    const runB = run({ issueKey: 'CF-2' });
    const itemA = intakeItem({ issueKey: 'CF-1', _id: runA.intakeItemId });
    const itemB = intakeItem({ issueKey: 'CF-2', _id: runB.intakeItemId });
    const h = harness({
      runs: [runA, runB],
      intakeItems: [itemA, itemB],
      registryEntries: [registryEntry()],
      createInitialThrowsFor: 'CF-1',
    });

    const summary = await matchRepositorySelections(h.deps);

    assert.equal(summary.skipped, 1);
    assert.equal(summary.pending, 1);
    assert.equal(h.selectionsStore.length, 1);
    assert.equal(h.selectionsStore[0]!.issueKey, 'CF-2');
  });
});

describe('matchRepositorySelections: retries', () => {
  it('re-matches a failed row, transitions to pending, and does not notify again', async () => {
    const due = selectionDoc({ status: 'failed', lastNotifiedStatus: 'failed', attempts: 2 });
    const h = harness({
      runs: [],
      dueForRetry: [due],
      registryEntries: [registryEntry({ projectIdentifier: due.projectIdentifier })],
    });
    h.selectionsStore.push(due);

    const summary = await matchRepositorySelections(h.deps);

    assert.equal(summary.pending, 1);
    assert.equal(due.status, 'pending');
    assert.equal(due.attempts, 3);
    assert.equal(h.auditEntries.length, 0, 'resolving to pending must not notify');
  });

  it('re-notifies when a failed row becomes ambiguous', async () => {
    const due = selectionDoc({ status: 'failed', lastNotifiedStatus: 'failed' });
    const h = harness({
      runs: [],
      dueForRetry: [due],
      registryEntries: [
        registryEntry({ projectIdentifier: due.projectIdentifier }),
        registryEntry({ _id: new ObjectId(), projectIdentifier: due.projectIdentifier, repositoryId: 'other' }),
      ],
    });
    h.selectionsStore.push(due);

    await matchRepositorySelections(h.deps);

    assert.equal(due.status, 'ambiguous');
    assert.equal(due.lastNotifiedStatus, 'ambiguous');
    assert.equal(h.auditEntries.length, 1);
  });

  it('does not re-notify when a retry lands on the same unresolved status', async () => {
    const due = selectionDoc({ status: 'failed', lastNotifiedStatus: 'failed' });
    const h = harness({ runs: [], dueForRetry: [due], registryEntries: [] });
    h.selectionsStore.push(due);

    await matchRepositorySelections(h.deps);

    assert.equal(due.status, 'failed');
    assert.equal(h.auditEntries.length, 0);
  });

  it('skips a retry that was concurrently confirmed (recordMatchResult returns null)', async () => {
    const due = selectionDoc({ status: 'failed' });
    // Not pushed into selectionsStore, so recordMatchResult's lookup misses —
    // models a row that moved on (e.g. confirmed) between listing and processing.
    const h = harness({ runs: [], dueForRetry: [due], registryEntries: [registryEntry()] });

    const summary = await matchRepositorySelections(h.deps);

    assert.equal(summary.skipped, 1);
    assert.equal(h.auditEntries.length, 0);
  });
});
