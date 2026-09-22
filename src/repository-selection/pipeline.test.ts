/**
 * Cross-module pipeline tests: approval → run queueing → repository
 * selection matching → human confirmation, exercised together against
 * shared in-memory fakes.
 *
 * This is deliberately NOT a `.integration.test.ts` against a live Atlas
 * cluster. The only live-cluster integration test in this codebase
 * (intake/repository.integration.test.ts) exists to verify something no
 * mock can: that the SERVER refuses a write the application role does not
 * hold (the audit log's append-only guarantee). No other pipeline module —
 * orchestrator, requirements, enrichment — has one, because their
 * correctness does not depend on server-enforced behavior; it is verified
 * against mocked repositories, the same as this file does. A live-cluster
 * run would also not currently pass regardless: `repositoryRegistry` and
 * `repositorySelections` are not yet granted on either Atlas role — see
 * docs/atlas-roles.md.
 *
 * What this file proves that the individual unit-test files do not:
 * `queueApprovedRuns` (orchestrator/worker.ts) and
 * `matchRepositorySelections` (repository-selection/worker.ts) are two
 * separately-developed, separately-unit-tested functions, and this is the
 * only place that runs them back to back against the SAME underlying
 * stores, the way index.ts actually schedules them.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId } from 'mongodb';

import type { AuditEntryInput, AuditLog } from '../db/audit-log.ts';
import { createLogger } from '../logging/logger.ts';
import { InvalidTransitionError, assertTransition } from '../intake/state.ts';
import type {
  ApprovalOptions,
  IntakeItemDocument,
  IntakeRepository,
  TransitionArgs,
} from '../intake/repository.ts';
import type { IntakeStatus } from '../db/collections.ts';
import { queueApprovedRuns } from '../orchestrator/worker.ts';
import type { RunDocument, RunsRepository } from '../orchestrator/repository.ts';
import type { RepositoryRegistryDocument, RepositoryRegistryRepository } from '../repository-registry/repository.ts';
import { matchRepositorySelections } from './worker.ts';
import type { RepositorySelectionDocument, RepositorySelectionRepository } from './repository.ts';

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

interface Pipeline {
  readonly intake: IntakeRepository;
  readonly runs: RunsRepository;
  readonly registry: RepositoryRegistryRepository;
  readonly selections: RepositorySelectionRepository;
  readonly audit: AuditLog;
  readonly runsStore: RunDocument[];
  readonly selectionsStore: RepositorySelectionDocument[];
  readonly auditEntries: AuditEntryInput[];
}

function buildPipeline(seedIntakeItems: IntakeItemDocument[], registryEntries: RepositoryRegistryDocument[]): Pipeline {
  const intakeStore = [...seedIntakeItems];
  const runsStore: RunDocument[] = [];
  const selectionsStore: RepositorySelectionDocument[] = [];
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

  const intake: IntakeRepository = {
    async create() {
      throw new Error('not used by this pipeline');
    },
    async findByIssueKey(issueKey: string) {
      return intakeStore.find((i) => i.issueKey === issueKey) ?? null;
    },
    async list(filter = {}, limit = 100) {
      const status = (filter as Record<string, unknown>)['status'];
      return intakeStore.filter((i) => status === undefined || i.status === status).slice(0, limit);
    },
    async transition<T extends IntakeStatus>(issueKey: string, to: T, opts: TransitionArgs<T>) {
      const item = intakeStore.find((i) => i.issueKey === issueKey);
      if (!item) throw new Error('not found');
      assertTransition(item.status, to);
      item.status = to;
      if ('approvedBy' in opts) item.approvedBy = (opts as ApprovalOptions).approvedBy;
      return item;
    },
  };

  const runs: RunsRepository = {
    async createIfAbsent(input) {
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
    async list(filter = {}, limit = 100) {
      const status = (filter as Record<string, unknown>)['status'];
      return runsStore.filter((r) => status === undefined || r.status === status).slice(0, limit);
    },
  };

  const registryStore = [...registryEntries];
  const registry: RepositoryRegistryRepository = {
    async create() {
      throw new Error('not used by this pipeline');
    },
    async findById() {
      throw new Error('not used by this pipeline');
    },
    async list() {
      return registryStore;
    },
    async findActiveByProjectIdentifier(projectIdentifier) {
      return registryStore.filter((e) => e.projectIdentifier === projectIdentifier && e.status === 'active');
    },
    async update() {
      throw new Error('not used by this pipeline');
    },
    async setStatus() {
      throw new Error('not used by this pipeline');
    },
  };

  const selections: RepositorySelectionRepository = {
    async findByRunId(runId) {
      return selectionsStore.find((s) => s.runId.equals(runId)) ?? null;
    },
    async createInitial(input) {
      const doc: RepositorySelectionDocument = {
        _id: new ObjectId(),
        runId: input.runId,
        intakeItemId: input.intakeItemId,
        issueKey: input.issueKey,
        projectIdentifier: input.projectIdentifier,
        candidateRepositoryIds: [...input.candidateRepositoryIds],
        selectedRepositoryId: null,
        selectedRepositoryUrl: null,
        selectedDefaultBranch: null,
        selectedAllowedBranches: null,
        selectedAccessPolicy: null,
        status: input.status,
        failureReason: input.failureReason ?? null,
        attempts: 0,
        nextAttemptAt: input.nextAttemptAt,
        confirmedBy: null,
        confirmedAt: null,
        lastNotifiedStatus: input.lastNotifiedStatus ?? null,
        createdAt: NOW,
        updatedAt: NOW,
      };
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
    async confirm(runId, input) {
      const found = selectionsStore.find((s) => s.runId.equals(runId));
      if (!found) throw new Error('not found');
      if (found.status !== 'pending' && found.status !== 'ambiguous') {
        throw new Error(`selection is '${found.status}', not confirmable`);
      }
      if (!found.candidateRepositoryIds.includes(input.repositoryId)) {
        throw new Error(`repositoryId '${input.repositoryId}' is not among the candidates`);
      }
      found.status = 'selected';
      found.selectedRepositoryId = input.repositoryId;
      found.selectedRepositoryUrl = input.repositoryUrl;
      found.selectedDefaultBranch = input.defaultBranch;
      found.selectedAllowedBranches = [...input.allowedBranches];
      found.selectedAccessPolicy = input.accessPolicy;
      found.confirmedBy = input.confirmedBy;
      found.confirmedAt = NOW;
      await audit.append({
        actor: input.confirmedBy,
        action: 'repository-selection.confirmed',
        subjectType: 'repositorySelection',
        subjectId: found._id!,
        detail: { issueKey: found.issueKey, repositoryId: input.repositoryId },
      });
      return { ...found };
    },
    async findDueForRetry(now, limit) {
      return selectionsStore
        .filter((s) => (s.status === 'failed' || s.status === 'ambiguous') && s.nextAttemptAt <= now)
        .slice(0, limit);
    },
  };

  return { intake, runs, registry, selections, audit, runsStore, selectionsStore, auditEntries };
}

describe('approved run -> repository selection pipeline', () => {
  it('an approved intake item is queued and matched to a pending selection', async () => {
    const item = intakeItem();
    const pipeline = buildPipeline([item], [registryEntry()]);

    const queueSummary = await queueApprovedRuns(
      { intake: pipeline.intake, runs: pipeline.runs, audit: pipeline.audit, logger: createLogger({ write: () => {} }) },
    );
    assert.equal(queueSummary.queued, 1);
    assert.equal(pipeline.runsStore.length, 1);
    assert.equal(pipeline.runsStore[0]!.status, 'queued', 'repository selection must not alter run status');

    const matchSummary = await matchRepositorySelections({
      intake: pipeline.intake,
      runs: pipeline.runs,
      registry: pipeline.registry,
      selections: pipeline.selections,
      audit: pipeline.audit,
      logger: createLogger({ write: () => {} }),
      now: () => NOW,
    });

    assert.equal(matchSummary.pending, 1);
    assert.equal(pipeline.selectionsStore.length, 1);
    assert.equal(pipeline.selectionsStore[0]!.status, 'pending');
    assert.deepEqual(pipeline.selectionsStore[0]!.candidateRepositoryIds, ['aisdlc-service']);

    // The run itself is untouched by matching — status stays whatever the
    // orchestrator set it to. Selection status lives entirely in its own
    // collection, never overloaded onto runs.status.
    assert.equal(pipeline.runsStore[0]!.status, 'queued');
  });

  it('a rejected intake item never produces a run, and therefore never produces a selection', async () => {
    const item = intakeItem({ status: 'rejected', approvedBy: null, approvedAt: null });
    const pipeline = buildPipeline([item], [registryEntry()]);

    const queueSummary = await queueApprovedRuns(
      { intake: pipeline.intake, runs: pipeline.runs, audit: pipeline.audit, logger: createLogger({ write: () => {} }) },
    );
    assert.equal(queueSummary.queued, 0);
    assert.equal(pipeline.runsStore.length, 0, 'a rejected item must never be queued');

    const matchSummary = await matchRepositorySelections({
      intake: pipeline.intake,
      runs: pipeline.runs,
      registry: pipeline.registry,
      selections: pipeline.selections,
      audit: pipeline.audit,
      logger: createLogger({ write: () => {} }),
      now: () => NOW,
    });

    assert.equal(matchSummary.newlyExamined, 0);
    assert.equal(pipeline.selectionsStore.length, 0, 'no run exists, so no selection can be created');
  });

  it('an approved item with no active repository fails, notifies, and later resolves on retry', async () => {
    const item = intakeItem();
    // No active registry entry yet.
    const pipeline = buildPipeline([item], []);

    await queueApprovedRuns(
      { intake: pipeline.intake, runs: pipeline.runs, audit: pipeline.audit, logger: createLogger({ write: () => {} }) },
    );
    const deps = {
      intake: pipeline.intake,
      runs: pipeline.runs,
      registry: pipeline.registry,
      selections: pipeline.selections,
      audit: pipeline.audit,
      logger: createLogger({ write: () => {} }),
    };

    // queueApprovedRuns already wrote one audit entry ('run.queued') — the
    // audit log is shared across both pipeline stages, same as in production.
    assert.equal(pipeline.auditEntries.length, 1);
    const auditCountBeforeMatching = pipeline.auditEntries.length;

    const firstPass = await matchRepositorySelections({ ...deps, now: () => NOW });
    assert.equal(firstPass.failed, 1);
    assert.equal(pipeline.selectionsStore[0]!.status, 'failed');
    assert.equal(pipeline.auditEntries.length, auditCountBeforeMatching + 1);
    assert.equal(pipeline.auditEntries.at(-1)!.action, 'repository-selection.notification');

    // An admin registers the missing repository. The pipeline's registry
    // fake closes over its own store, so the "registry changed" step is
    // modeled by swapping in a registry view that now has an active entry.
    const registryNowActive: RepositoryRegistryRepository = {
      ...pipeline.registry,
      async findActiveByProjectIdentifier(projectIdentifier: string) {
        return projectIdentifier === 'CF' ? [registryEntry()] : [];
      },
    };

    const retryPass = await matchRepositorySelections({
      ...deps,
      registry: registryNowActive,
      now: () => new Date(NOW.getTime() + 61_000),
    });

    assert.equal(retryPass.pending, 1);
    assert.equal(pipeline.selectionsStore[0]!.status, 'pending');
    assert.equal(
      pipeline.auditEntries.length,
      auditCountBeforeMatching + 1,
      'resolving to pending must not add a second notification',
    );
  });

  it('confirming a pending selection uses the current registry snapshot', async () => {
    const item = intakeItem();
    const pipeline = buildPipeline([item], [registryEntry()]);
    const deps = {
      intake: pipeline.intake,
      runs: pipeline.runs,
      registry: pipeline.registry,
      selections: pipeline.selections,
      audit: pipeline.audit,
      logger: createLogger({ write: () => {} }),
      now: () => NOW,
    };

    await queueApprovedRuns({ intake: pipeline.intake, runs: pipeline.runs, audit: pipeline.audit, logger: deps.logger });
    await matchRepositorySelections(deps);

    const runId = pipeline.runsStore[0]!._id!;
    const confirmed = await pipeline.selections.confirm(runId, {
      repositoryId: 'aisdlc-service',
      repositoryUrl: 'https://github.com/cloudfuze/aisdlc-service',
      defaultBranch: 'main',
      allowedBranches: ['main'],
      accessPolicy: null,
      confirmedBy: 'operator:alice',
    });

    assert.equal(confirmed.status, 'selected');
    assert.equal(confirmed.selectedRepositoryId, 'aisdlc-service');
    assert.ok(pipeline.auditEntries.some((e) => e.action === 'repository-selection.confirmed'));
  });
});
