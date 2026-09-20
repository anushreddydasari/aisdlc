/**
 * Runs the enrichment drain on an interval, inside the service process.
 *
 * Why in-process rather than cron or a separate worker: this deploys as a
 * single service against a single cluster. An in-process loop reuses the
 * connection manager that already reconnects on its own, starts and stops
 * with the service, and reports through the same logger — where cron or a
 * second process would each need their own connection lifecycle and
 * supervision to poll a queue that is usually empty.
 *
 * It is deliberately NOT triggered from /ingest. Draining inline would make
 * the webhook response depend on Neutara's API being reachable, and Neutara
 * drops an event permanently on any non-2xx. The queue exists to decouple
 * those two failure domains.
 *
 * Running several instances is safe, not just tolerated: every settle path
 * is guarded on `status: 'pending'` and `create()` is idempotent on
 * `issueKey`, so a race costs a duplicate fetch, never a duplicate item.
 */

import type { Logger } from '../logging/logger.ts';
import { drainPending, type DrainSummary, type EnrichmentDeps } from './worker.ts';

/**
 * Deliveries are eligible the moment they are recorded, so this is the
 * latency floor for enrichment. Thirty seconds keeps it responsive without
 * hammering an idle queue; the retry backoff starts at a minute, so a faster
 * poll would buy nothing for failures.
 */
export const DEFAULT_INTERVAL_MS = 30_000;
export const DEFAULT_BATCH_LIMIT = 25;

export interface EnrichmentLoopOptions {
  readonly intervalMs?: number;
  readonly limit?: number;
  /**
   * Whether a pass should run at all — typically "is the database
   * connected?". A pass while disconnected would only produce errors.
   */
  readonly isReady?: () => boolean;
}

export interface EnrichmentLoop {
  /** Runs one pass immediately. Exposed for tests and manual triggering. */
  runOnce(): Promise<DrainSummary | null>;
  stop(): void;
}

export function startEnrichmentLoop(
  deps: EnrichmentDeps,
  options: EnrichmentLoopOptions = {},
): EnrichmentLoop {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const limit = options.limit ?? DEFAULT_BATCH_LIMIT;
  const isReady = options.isReady ?? ((): boolean => true);
  const logger: Logger = deps.logger;

  let stopped = false;
  // Guards against a slow pass stacking on the next tick. Without it, a
  // Neutara outage would pile up concurrent passes over the same rows.
  let inFlight = false;
  let timer: NodeJS.Timeout | undefined;

  async function runOnce(): Promise<DrainSummary | null> {
    if (stopped || inFlight) return null;
    if (!isReady()) return null;

    inFlight = true;
    try {
      return await drainPending(deps, limit);
    } catch (error) {
      // A pass must never take the process down. Deliveries stay pending and
      // the next tick retries them.
      logger.error('enrichment pass failed', { error });
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

  logger.info('enrichment loop started', { intervalMs, limit });

  return {
    runOnce,
    stop(): void {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      logger.info('enrichment loop stopped');
    },
  };
}
