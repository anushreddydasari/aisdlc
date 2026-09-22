import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId } from 'mongodb';

import type { IntakeRepository } from '../intake/repository.ts';
import { createLogger } from '../logging/logger.ts';
import type { RunDocument, RunsRepository } from '../orchestrator/repository.ts';
import type { RepositoryRegistryRepository } from '../repository-registry/repository.ts';
import type { RepositorySelectionRepository } from './repository.ts';
import { DEFAULT_BATCH_LIMIT, DEFAULT_INTERVAL_MS, startRepositorySelectionLoop } from './scheduler.ts';
import type { MatchRepositorySelectionsDeps } from './worker.ts';

const NOW = new Date('2026-09-23T12:00:00.000Z');

function run(): RunDocument {
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
  };
}

interface Harness {
  readonly deps: MatchRepositorySelectionsDeps;
  readonly logs: string[];
  listCalls: number;
  createInitialCalls: number;
}

function harness(
  options: { queuedRuns?: RunDocument[]; listHangs?: boolean; listThrows?: boolean } = {},
): Harness {
  const logs: string[] = [];
  const state = { listCalls: 0, createInitialCalls: 0 };

  const intake = {
    async findByIssueKey(issueKey: string) {
      const match = (options.queuedRuns ?? []).find((r) => r.issueKey === issueKey);
      if (!match) return null;
      return {
        _id: match.intakeItemId,
        issueKey,
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
      };
    },
  } as unknown as IntakeRepository;

  const runs: RunsRepository = {
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
      state.listCalls += 1;
      if (options.listThrows) throw new Error('mongo exploded');
      if (options.listHangs) await new Promise(() => {});
      return options.queuedRuns ?? [];
    },
  };

  const registry = {
    async findActiveByProjectIdentifier() {
      return [];
    },
  } as unknown as RepositoryRegistryRepository;

  const selections: RepositorySelectionRepository = {
    async findByRunId() {
      return null;
    },
    async createInitial(input) {
      state.createInitialCalls += 1;
      return {
        created: true,
        selection: {
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
        },
      };
    },
    async recordMatchResult() {
      return null;
    },
    async confirm() {
      throw new Error('must not be called');
    },
    async findDueForRetry() {
      return [];
    },
  };

  const audit = {
    async append() {
      return new ObjectId();
    },
    async query() {
      return [];
    },
  } as MatchRepositorySelectionsDeps['audit'];

  return {
    deps: {
      intake,
      runs,
      registry,
      selections,
      audit,
      logger: createLogger({ write: (line) => logs.push(line) }),
      now: () => NOW,
    },
    logs,
    get listCalls() {
      return state.listCalls;
    },
    get createInitialCalls() {
      return state.createInitialCalls;
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met within timeout');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe('defaults', () => {
  it('polls on the same order of magnitude as the orchestrator loop', () => {
    assert.equal(DEFAULT_INTERVAL_MS, 30_000);
    assert.equal(DEFAULT_BATCH_LIMIT, 25);
  });
});

describe('the loop', () => {
  it('polls on each tick', async () => {
    const h = harness();
    const loop = startRepositorySelectionLoop(h.deps, { intervalMs: 5 });
    try {
      await waitFor(() => h.listCalls >= 3);
      assert.ok(h.listCalls >= 3);
    } finally {
      loop.stop();
    }
  });

  it('creates a selection for a queued run', async () => {
    const h = harness({ queuedRuns: [run()] });
    const loop = startRepositorySelectionLoop(h.deps, { intervalMs: 5 });
    try {
      await waitFor(() => h.createInitialCalls >= 1);
    } finally {
      loop.stop();
    }
  });

  it('stops ticking once stopped', async () => {
    const h = harness();
    const loop = startRepositorySelectionLoop(h.deps, { intervalMs: 5 });
    await waitFor(() => h.listCalls >= 2);
    loop.stop();

    const settled = h.listCalls;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(h.listCalls, settled, 'the loop kept running after stop()');
  });

  it('does not stack passes when one is slow', async () => {
    const h = harness({ listHangs: true });
    const loop = startRepositorySelectionLoop(h.deps, { intervalMs: 5 });
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(h.listCalls, 1, 'a second pass started while the first was in flight');
    } finally {
      loop.stop();
    }
  });

  it('survives a pass that throws', async () => {
    const h = harness({ listThrows: true });
    const loop = startRepositorySelectionLoop(h.deps, { intervalMs: 5 });
    try {
      await waitFor(() => h.listCalls >= 2);
      assert.ok(h.logs.join('\n').includes('repository selection matching pass failed'));
    } finally {
      loop.stop();
    }
  });

  it('skips a pass when not ready', async () => {
    const h = harness();
    const loop = startRepositorySelectionLoop(h.deps, { intervalMs: 5, isReady: () => false });
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(h.listCalls, 0);
    } finally {
      loop.stop();
    }
  });

  it('resumes once readiness returns', async () => {
    const h = harness();
    let ready = false;
    const loop = startRepositorySelectionLoop(h.deps, { intervalMs: 5, isReady: () => ready });
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(h.listCalls, 0);
      ready = true;
      await waitFor(() => h.listCalls >= 1);
    } finally {
      loop.stop();
    }
  });
});

describe('runOnce', () => {
  it('runs immediately without waiting for a tick', async () => {
    const h = harness({ queuedRuns: [run()] });
    const loop = startRepositorySelectionLoop(h.deps, { intervalMs: 60_000 });
    try {
      const summary = await loop.runOnce();
      assert.equal(summary?.newlyExamined, 1);
    } finally {
      loop.stop();
    }
  });

  it('returns null when not ready', async () => {
    const h = harness();
    const loop = startRepositorySelectionLoop(h.deps, { intervalMs: 60_000, isReady: () => false });
    try {
      assert.equal(await loop.runOnce(), null);
    } finally {
      loop.stop();
    }
  });

  it('returns null after stop', async () => {
    const h = harness();
    const loop = startRepositorySelectionLoop(h.deps, { intervalMs: 60_000 });
    loop.stop();
    assert.equal(await loop.runOnce(), null);
  });
});
