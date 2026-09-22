import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId } from 'mongodb';

import type { IntakeItemDocument, IntakeRepository } from '../intake/repository.ts';
import { createLogger } from '../logging/logger.ts';
import { DEFAULT_BATCH_LIMIT, DEFAULT_INTERVAL_MS, startOrchestratorLoop } from './scheduler.ts';
import type { QueueApprovedRunsDeps } from './worker.ts';
import type { RunDocument, RunsRepository } from './repository.ts';

const NOW = new Date('2026-09-23T12:00:00.000Z');

function approvedItem(): IntakeItemDocument {
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
  };
}

interface Harness {
  readonly deps: QueueApprovedRunsDeps;
  readonly logs: string[];
  listCalls: number;
  createCalls: number;
}

function harness(
  options: { approved?: IntakeItemDocument[]; listHangs?: boolean; listThrows?: boolean } = {},
): Harness {
  const logs: string[] = [];
  const state = { listCalls: 0, createCalls: 0 };

  const intake = {
    async list() {
      state.listCalls += 1;
      if (options.listThrows) throw new Error('mongo exploded');
      if (options.listHangs) await new Promise(() => {});
      return options.approved ?? [];
    },
  } as unknown as IntakeRepository;

  const runs: RunsRepository = {
    async createIfAbsent(input) {
      state.createCalls += 1;
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

  const audit = {
    async append() {
      return new ObjectId();
    },
    async query() {
      return [];
    },
  } as QueueApprovedRunsDeps['audit'];

  return {
    deps: { intake, runs, audit, logger: createLogger({ write: (line) => logs.push(line) }) },
    logs,
    get listCalls() {
      return state.listCalls;
    },
    get createCalls() {
      return state.createCalls;
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
  it('polls on the same order of magnitude as the enrichment loop', () => {
    assert.equal(DEFAULT_INTERVAL_MS, 30_000);
    assert.equal(DEFAULT_BATCH_LIMIT, 25);
  });
});

describe('the loop', () => {
  it('polls on each tick', async () => {
    const h = harness();
    const loop = startOrchestratorLoop(h.deps, { intervalMs: 5 });
    try {
      await waitFor(() => h.listCalls >= 3);
      assert.ok(h.listCalls >= 3);
    } finally {
      loop.stop();
    }
  });

  it('queues a run for an approved item', async () => {
    const h = harness({ approved: [approvedItem()] });
    const loop = startOrchestratorLoop(h.deps, { intervalMs: 5 });
    try {
      await waitFor(() => h.createCalls >= 1);
    } finally {
      loop.stop();
    }
  });

  it('stops ticking once stopped', async () => {
    const h = harness();
    const loop = startOrchestratorLoop(h.deps, { intervalMs: 5 });
    await waitFor(() => h.listCalls >= 2);
    loop.stop();

    const settled = h.listCalls;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(h.listCalls, settled, 'the loop kept running after stop()');
  });

  it('does not stack passes when one is slow', async () => {
    const h = harness({ listHangs: true });
    const loop = startOrchestratorLoop(h.deps, { intervalMs: 5 });
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(h.listCalls, 1, 'a second pass started while the first was in flight');
    } finally {
      loop.stop();
    }
  });

  it('survives a pass that throws', async () => {
    const h = harness({ listThrows: true });
    const loop = startOrchestratorLoop(h.deps, { intervalMs: 5 });
    try {
      await waitFor(() => h.listCalls >= 2);
      assert.ok(h.logs.join('\n').includes('orchestrator pass failed'));
    } finally {
      loop.stop();
    }
  });

  it('skips a pass when not ready', async () => {
    const h = harness();
    const loop = startOrchestratorLoop(h.deps, { intervalMs: 5, isReady: () => false });
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
    const loop = startOrchestratorLoop(h.deps, { intervalMs: 5, isReady: () => ready });
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
    const h = harness({ approved: [approvedItem()] });
    const loop = startOrchestratorLoop(h.deps, { intervalMs: 60_000 });
    try {
      const summary = await loop.runOnce();
      assert.equal(summary?.examined, 1);
      assert.equal(summary?.queued, 1);
    } finally {
      loop.stop();
    }
  });

  it('returns null when not ready', async () => {
    const h = harness();
    const loop = startOrchestratorLoop(h.deps, { intervalMs: 60_000, isReady: () => false });
    try {
      assert.equal(await loop.runOnce(), null);
    } finally {
      loop.stop();
    }
  });

  it('returns null after stop', async () => {
    const h = harness();
    const loop = startOrchestratorLoop(h.deps, { intervalMs: 60_000 });
    loop.stop();
    assert.equal(await loop.runOnce(), null);
  });
});
