import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId } from 'mongodb';

import type { WebhookDeliveryDocument, WebhookDeliveryRepository } from '../db/webhook-deliveries.ts';
import type { IntakeRepository } from '../intake/repository.ts';
import { createLogger } from '../logging/logger.ts';
import type { NeutaraClient } from '../neutara/client.ts';
import {
  DEFAULT_BATCH_LIMIT,
  DEFAULT_INTERVAL_MS,
  startEnrichmentLoop,
} from './scheduler.ts';
import type { EnrichmentDeps } from './worker.ts';

const NOW = new Date('2026-09-20T12:00:00.000Z');

function pendingDelivery(): WebhookDeliveryDocument {
  return {
    _id: new ObjectId(),
    deliveryId: 'a'.repeat(64),
    event: 'issue.created',
    issueKey: 'AIS-1',
    eventTimestamp: NOW,
    payload: {},
    status: 'pending',
    invalidReason: null,
    attempts: 0,
    maxAttempts: 5,
    nextAttemptAt: NOW,
    lastError: null,
    intakeItemId: null,
    receivedAt: NOW,
    updatedAt: NOW,
  };
}

interface Harness {
  readonly deps: EnrichmentDeps;
  readonly logs: string[];
  findPendingCalls: number;
  createCalls: number;
}

function harness(
  options: { pending?: WebhookDeliveryDocument[]; findPendingHangs?: boolean; drainThrows?: boolean } = {},
): Harness {
  const logs: string[] = [];
  const state = { findPendingCalls: 0, createCalls: 0 };

  const deliveries: WebhookDeliveryRepository = {
    async record() {
      throw new Error('not used');
    },
    async findByDeliveryId() {
      return null;
    },
    async findPending() {
      state.findPendingCalls += 1;
      if (options.drainThrows) throw new Error('mongo exploded');
      if (options.findPendingHangs) await new Promise(() => {});
      return options.pending ?? [];
    },
    async markEnriched() {},
    async scheduleRetry() {},
    async markFailed() {},
  };

  const intake = {
    async create() {
      state.createCalls += 1;
      return { id: new ObjectId(), created: true, item: {} as never };
    },
  } as unknown as IntakeRepository;

  const client: NeutaraClient = {
    async getIssue() {
      return { ok: true, issue: { key: 'AIS-1', summary: 'x' } };
    },
  };

  return {
    deps: {
      deliveries,
      intake,
      client,
      logger: createLogger({ write: (line) => logs.push(line) }),
      now: () => NOW,
    },
    logs,
    get findPendingCalls() {
      return state.findPendingCalls;
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
  it('polls often enough to keep enrichment responsive', () => {
    // Deliveries are eligible immediately, so this is the latency floor.
    assert.equal(DEFAULT_INTERVAL_MS, 30_000);
    assert.equal(DEFAULT_BATCH_LIMIT, 25);
  });
});

describe('the loop', () => {
  it('drains on each tick', async () => {
    const h = harness();
    const loop = startEnrichmentLoop(h.deps, { intervalMs: 5 });
    try {
      await waitFor(() => h.findPendingCalls >= 3);
      assert.ok(h.findPendingCalls >= 3);
    } finally {
      loop.stop();
    }
  });

  it('enriches a pending delivery', async () => {
    const h = harness({ pending: [pendingDelivery()] });
    const loop = startEnrichmentLoop(h.deps, { intervalMs: 5 });
    try {
      await waitFor(() => h.createCalls >= 1);
    } finally {
      loop.stop();
    }
  });

  it('stops ticking once stopped', async () => {
    const h = harness();
    const loop = startEnrichmentLoop(h.deps, { intervalMs: 5 });
    await waitFor(() => h.findPendingCalls >= 2);
    loop.stop();

    const settled = h.findPendingCalls;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(h.findPendingCalls, settled, 'the loop kept running after stop()');
  });

  it('does not stack passes when one is slow', async () => {
    // Without the in-flight guard, a Neutara outage would pile up concurrent
    // passes over the same rows.
    const h = harness({ findPendingHangs: true });
    const loop = startEnrichmentLoop(h.deps, { intervalMs: 5 });
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(h.findPendingCalls, 1, 'a second pass started while the first was in flight');
    } finally {
      loop.stop();
    }
  });

  it('survives a pass that throws', async () => {
    const h = harness({ drainThrows: true });
    const loop = startEnrichmentLoop(h.deps, { intervalMs: 5 });
    try {
      await waitFor(() => h.findPendingCalls >= 2);
      assert.ok(h.logs.join('\n').includes('enrichment pass failed'));
    } finally {
      loop.stop();
    }
  });

  it('skips a pass when not ready', async () => {
    // A pass while the database is disconnected would only produce errors.
    const h = harness();
    const loop = startEnrichmentLoop(h.deps, { intervalMs: 5, isReady: () => false });
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(h.findPendingCalls, 0);
    } finally {
      loop.stop();
    }
  });

  it('resumes once readiness returns', async () => {
    const h = harness();
    let ready = false;
    const loop = startEnrichmentLoop(h.deps, { intervalMs: 5, isReady: () => ready });
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(h.findPendingCalls, 0);
      ready = true;
      await waitFor(() => h.findPendingCalls >= 1);
    } finally {
      loop.stop();
    }
  });
});

describe('runOnce', () => {
  it('drains immediately without waiting for a tick', async () => {
    const h = harness({ pending: [pendingDelivery()] });
    const loop = startEnrichmentLoop(h.deps, { intervalMs: 60_000 });
    try {
      const summary = await loop.runOnce();
      assert.equal(summary?.examined, 1);
      assert.equal(summary?.enriched, 1);
    } finally {
      loop.stop();
    }
  });

  it('returns null when not ready', async () => {
    const h = harness();
    const loop = startEnrichmentLoop(h.deps, { intervalMs: 60_000, isReady: () => false });
    try {
      assert.equal(await loop.runOnce(), null);
    } finally {
      loop.stop();
    }
  });

  it('returns null after stop', async () => {
    const h = harness();
    const loop = startEnrichmentLoop(h.deps, { intervalMs: 60_000 });
    loop.stop();
    assert.equal(await loop.runOnce(), null);
  });
});
