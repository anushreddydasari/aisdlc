import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId } from 'mongodb';

import type { IntakeRepository } from '../intake/repository.ts';
import { createLogger } from '../logging/logger.ts';
import type { RequirementsQueueDeps } from './queue.ts';
import type { RequirementsRepository } from './repository.ts';
import { DEFAULT_BATCH_LIMIT, DEFAULT_INTERVAL_MS, startRequirementsLoop } from './scheduler.ts';

interface Harness {
  readonly deps: RequirementsQueueDeps;
  readonly logs: string[];
  listCalls: number;
}

function harness(options: { listThrows?: boolean; listHangs?: boolean } = {}): Harness {
  const logs: string[] = [];
  const state = { listCalls: 0 };

  const intake = {
    async list() {
      state.listCalls += 1;
      if (options.listThrows) throw new Error('mongo exploded');
      if (options.listHangs) await new Promise(() => {});
      return [];
    },
  } as unknown as IntakeRepository;

  const repository = {} as RequirementsRepository;
  const audit = {
    async append() {
      return new ObjectId();
    },
    async query() {
      return [];
    },
  } as RequirementsQueueDeps['audit'];

  return {
    deps: { intake, repository, audit, logger: createLogger({ write: (line) => logs.push(line) }) },
    logs,
    get listCalls() {
      return state.listCalls;
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
  it('matches the other schedulers in this codebase', () => {
    assert.equal(DEFAULT_INTERVAL_MS, 30_000);
    assert.equal(DEFAULT_BATCH_LIMIT, 25);
  });
});

describe('the loop', () => {
  it('polls on each tick', async () => {
    const h = harness();
    const loop = startRequirementsLoop(h.deps, { intervalMs: 5 });
    try {
      await waitFor(() => h.listCalls >= 3);
    } finally {
      loop.stop();
    }
  });

  it('stops ticking once stopped', async () => {
    const h = harness();
    const loop = startRequirementsLoop(h.deps, { intervalMs: 5 });
    await waitFor(() => h.listCalls >= 2);
    loop.stop();

    const settled = h.listCalls;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(h.listCalls, settled, 'the loop kept running after stop()');
  });

  it('does not stack passes when one is slow', async () => {
    const h = harness({ listHangs: true });
    const loop = startRequirementsLoop(h.deps, { intervalMs: 5 });
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(h.listCalls, 1);
    } finally {
      loop.stop();
    }
  });

  it('survives a pass that throws', async () => {
    const h = harness({ listThrows: true });
    const loop = startRequirementsLoop(h.deps, { intervalMs: 5 });
    try {
      await waitFor(() => h.listCalls >= 2);
      assert.ok(h.logs.join('\n').includes('requirements queue pass failed'));
    } finally {
      loop.stop();
    }
  });

  it('skips a pass when not ready', async () => {
    const h = harness();
    const loop = startRequirementsLoop(h.deps, { intervalMs: 5, isReady: () => false });
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(h.listCalls, 0);
    } finally {
      loop.stop();
    }
  });
});

describe('runOnce', () => {
  it('runs immediately without waiting for a tick', async () => {
    const h = harness();
    const loop = startRequirementsLoop(h.deps, { intervalMs: 60_000 });
    try {
      const summary = await loop.runOnce();
      assert.equal(summary?.examined, 0);
    } finally {
      loop.stop();
    }
  });

  it('returns null when not ready', async () => {
    const h = harness();
    const loop = startRequirementsLoop(h.deps, { intervalMs: 60_000, isReady: () => false });
    try {
      assert.equal(await loop.runOnce(), null);
    } finally {
      loop.stop();
    }
  });

  it('returns null after stop', async () => {
    const h = harness();
    const loop = startRequirementsLoop(h.deps, { intervalMs: 60_000 });
    loop.stop();
    assert.equal(await loop.runOnce(), null);
  });
});
