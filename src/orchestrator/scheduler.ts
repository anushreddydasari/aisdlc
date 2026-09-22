/**
 * Runs the orchestrator's approved-run queueing on an interval, inside the
 * service process.
 *
 * Same rationale as enrichment/scheduler.ts, mirrored deliberately rather
 * than reinvented: an in-process loop reuses the connection manager that
 * already reconnects on its own, and it is NOT triggered synchronously from
 * POST /intake/:issueKey/approve — that response must not depend on run
 * creation succeeding, the same reason enrichment is not triggered from
 * /ingest.
 *
 * Running several instances is safe: runs.createIfAbsent() is idempotent on
 * intakeItemId (a unique index backs it), so a race between two orchestrator
 * passes costs a duplicate-key error caught internally, never a duplicate run.
 */

import type { Logger } from '../logging/logger.ts';
import { queueApprovedRuns, type QueueApprovedRunsDeps, type QueueRunsSummary } from './worker.ts';

/** No external event marks an approval as "ready" the way a webhook delivery is; a plain poll interval, same order of magnitude as enrichment's. */
export const DEFAULT_INTERVAL_MS = 30_000;
export const DEFAULT_BATCH_LIMIT = 25;

export interface OrchestratorLoopOptions {
  readonly intervalMs?: number;
  readonly limit?: number;
  /**
   * Whether a pass should run at all — typically "is the database
   * connected?". A pass while disconnected would only produce errors.
   */
  readonly isReady?: () => boolean;
}

export interface OrchestratorLoop {
  /** Runs one pass immediately. Exposed for tests and manual triggering. */
  runOnce(): Promise<QueueRunsSummary | null>;
  stop(): void;
}

export function startOrchestratorLoop(
  deps: QueueApprovedRunsDeps,
  options: OrchestratorLoopOptions = {},
): OrchestratorLoop {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const limit = options.limit ?? DEFAULT_BATCH_LIMIT;
  const isReady = options.isReady ?? ((): boolean => true);
  const logger: Logger = deps.logger;

  let stopped = false;
  // Guards against a slow pass stacking on the next tick.
  let inFlight = false;
  let timer: NodeJS.Timeout | undefined;

  async function runOnce(): Promise<QueueRunsSummary | null> {
    if (stopped || inFlight) return null;
    if (!isReady()) return null;

    inFlight = true;
    try {
      return await queueApprovedRuns(deps, limit);
    } catch (error) {
      // A pass must never take the process down. Approved items stay
      // approved and the next tick retries them.
      logger.error('orchestrator pass failed', { error });
      return null;
    } finally {
      inFlight = false;
    }
  }

  timer = setInterval(() => {
    void runOnce();
  }, intervalMs);
  // Unref'd so a pending tick never holds the process open during shutdown.
  timer.unref?.();

  logger.info('orchestrator loop started', { intervalMs, limit });

  return {
    runOnce,
    stop(): void {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      logger.info('orchestrator loop stopped');
    },
  };
}
