import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createLogger } from '../logging/logger.ts';
import type { ChangeExecutionQueueDeps } from './change-execution-queue.ts';
import type { GithubPublishQueueDeps } from './github-publish-queue.ts';
import type { PrMergeDetectionDeps } from '../deployment/pr-merge-detection.ts';
import type { DeploymentQueueDeps } from '../deployment/deployment-queue.ts';
import { DEFAULT_BATCH_LIMIT, DEFAULT_INTERVAL_MS, startPipelineLoop, type PipelineLoopDeps } from './scheduler.ts';

function harness(options: { changeExecutionThrows?: boolean; hangs?: boolean } = {}): { deps: PipelineLoopDeps; logs: string[]; findApprovedCalls: number; findSucceededCalls: number } {
  const logs: string[] = [];
  const state = { findApprovedCalls: 0, findSucceededCalls: 0 };

  const changeExecution: ChangeExecutionQueueDeps = {
    reviews: {
      async findApproved() {
        state.findApprovedCalls += 1;
        if (options.changeExecutionThrows) throw new Error('mongo exploded');
        if (options.hangs) await new Promise(() => {});
        return [];
      },
    } as unknown as ChangeExecutionQueueDeps['reviews'],
    executions: {} as ChangeExecutionQueueDeps['executions'],
    executionService: {} as ChangeExecutionQueueDeps['executionService'],
    logger: createLogger({ write: (line) => logs.push(line) }),
  };

  const githubPublish: GithubPublishQueueDeps = {
    executions: {
      async findSucceeded() {
        state.findSucceededCalls += 1;
        return [];
      },
    } as unknown as GithubPublishQueueDeps['executions'],
    publications: {} as GithubPublishQueueDeps['publications'],
    publishService: {} as GithubPublishQueueDeps['publishService'],
    logger: createLogger({ write: (line) => logs.push(line) }),
  };

  const prMergeDetection: PrMergeDetectionDeps = {
    publications: { async findPublished() { return []; } } as unknown as PrMergeDetectionDeps['publications'],
    deployments: {} as PrMergeDetectionDeps['deployments'],
    selections: {} as PrMergeDetectionDeps['selections'],
    registry: {} as PrMergeDetectionDeps['registry'],
    client: {} as PrMergeDetectionDeps['client'],
    audit: {} as PrMergeDetectionDeps['audit'],
    logger: createLogger({ write: (line) => logs.push(line) }),
  };

  const deployment: DeploymentQueueDeps = {
    deployments: { async findEligible() { return []; } } as unknown as DeploymentQueueDeps['deployments'],
    deploymentService: {} as DeploymentQueueDeps['deploymentService'],
    logger: createLogger({ write: (line) => logs.push(line) }),
  };

  return {
    deps: { changeExecution, githubPublish, prMergeDetection, deployment, logger: createLogger({ write: (line) => logs.push(line) }) },
    logs,
    get findApprovedCalls() {
      return state.findApprovedCalls;
    },
    get findSucceededCalls() {
      return state.findSucceededCalls;
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
  it('runs both the change-execution and github-publish passes on each tick', async () => {
    const h = harness();
    const loop = startPipelineLoop(h.deps, { intervalMs: 5 });
    try {
      await waitFor(() => h.findApprovedCalls >= 1 && h.findSucceededCalls >= 1);
    } finally {
      loop.stop();
    }
  });

  it('stops ticking once stopped', async () => {
    const h = harness();
    const loop = startPipelineLoop(h.deps, { intervalMs: 5 });
    await waitFor(() => h.findApprovedCalls >= 2);
    loop.stop();

    const settled = h.findApprovedCalls;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(h.findApprovedCalls, settled);
  });

  it('does not stack passes when one is slow', async () => {
    const h = harness({ hangs: true });
    const loop = startPipelineLoop(h.deps, { intervalMs: 5 });
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(h.findApprovedCalls, 1);
    } finally {
      loop.stop();
    }
  });

  it('survives a pass that throws', async () => {
    const h = harness({ changeExecutionThrows: true });
    const loop = startPipelineLoop(h.deps, { intervalMs: 5 });
    try {
      await waitFor(() => h.findApprovedCalls >= 2);
      assert.ok(h.logs.join('\n').includes('pipeline pass failed'));
    } finally {
      loop.stop();
    }
  });

  it('skips a pass when not ready', async () => {
    const h = harness();
    const loop = startPipelineLoop(h.deps, { intervalMs: 5, isReady: () => false });
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(h.findApprovedCalls, 0);
    } finally {
      loop.stop();
    }
  });
});

describe('runOnce', () => {
  it('runs immediately and reports both sub-summaries', async () => {
    const h = harness();
    const loop = startPipelineLoop(h.deps, { intervalMs: 60_000 });
    try {
      const summary = await loop.runOnce();
      assert.equal(summary?.changeExecution.examined, 0);
      assert.equal(summary?.githubPublish.examined, 0);
    } finally {
      loop.stop();
    }
  });

  it('returns null after stop', async () => {
    const h = harness();
    const loop = startPipelineLoop(h.deps, { intervalMs: 60_000 });
    loop.stop();
    assert.equal(await loop.runOnce(), null);
  });
});
