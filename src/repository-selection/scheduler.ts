/**
 * Runs repository selection matching on an interval, inside the service
 * process.
 *
 * Mirrors orchestrator/scheduler.ts deliberately: an in-process loop reuses
 * the connection manager that already reconnects on its own, and matching is
 * NOT triggered synchronously from any request handler.
 *
 * Running several instances is safe: createInitial() is idempotent on runId
 * (a unique index backs it) and recordMatchResult()'s filter only ever
 * touches a row still in `failed`/`ambiguous`, so a race between two passes
 * costs a duplicate-key error caught internally or a harmless no-op update,
 * never a corrupted selection.
 */

import type { Logger } from '../logging/logger.ts';
import {
  matchRepositorySelections,
  type MatchRepositorySelectionsDeps,
  type MatchSelectionsSummary,
} from './worker.ts';

/** Same order of magnitude as the orchestrator's poll interval. */
export const DEFAULT_INTERVAL_MS = 30_000;
export const DEFAULT_BATCH_LIMIT = 25;

export interface RepositorySelectionLoopOptions {
  readonly intervalMs?: number;
  readonly limit?: number;
  /**
   * Whether a pass should run at all — typically "is the database
   * connected?". A pass while disconnected would only produce errors.
   */
  readonly isReady?: () => boolean;
}

export interface RepositorySelectionLoop {
  /** Runs one pass immediately. Exposed for tests and manual triggering. */
  runOnce(): Promise<MatchSelectionsSummary | null>;
  stop(): void;
}

export function startRepositorySelectionLoop(
  deps: MatchRepositorySelectionsDeps,
  options: RepositorySelectionLoopOptions = {},
): RepositorySelectionLoop {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const limit = options.limit ?? DEFAULT_BATCH_LIMIT;
  const isReady = options.isReady ?? ((): boolean => true);
  const logger: Logger = deps.logger;

  let stopped = false;
  // Guards against a slow pass stacking on the next tick.
  let inFlight = false;
  let timer: NodeJS.Timeout | undefined;

  async function runOnce(): Promise<MatchSelectionsSummary | null> {
    if (stopped || inFlight) return null;
    if (!isReady()) return null;

    inFlight = true;
    try {
      return await matchRepositorySelections(deps, limit);
    } catch (error) {
      // A pass must never take the process down. Unresolved runs stay
      // unresolved and the next tick retries them.
      logger.error('repository selection matching pass failed', { error });
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

  logger.info('repository selection loop started', { intervalMs, limit });

  return {
    runOnce,
    stop(): void {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      logger.info('repository selection loop stopped');
    },
  };
}
