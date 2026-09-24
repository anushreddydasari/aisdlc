/**
 * Runs the requirements queue on an interval, inside the service process.
 *
 * Same shape as orchestrator/scheduler.ts, repository-selection/scheduler.ts,
 * and enrichment/scheduler.ts, mirrored deliberately rather than
 * reinvented — see orchestrator/scheduler.ts's module comment for why this
 * codebase copies this shape per domain instead of sharing one generic
 * loop utility.
 *
 * Running several instances is safe: `runRequirementsAgent`'s
 * `createPending` is idempotent on `intakeItemId`, and
 * `advanceToPendingApproval`'s transition is a compare-and-set — a race
 * between two passes costs a caught, logged conflict, never a duplicate
 * analysis or a double transition.
 */

import type { Logger } from '../logging/logger.ts';
import { processReceivedIntakeItems, type RequirementsQueueDeps, type RequirementsQueueSummary } from './queue.ts';

export const DEFAULT_INTERVAL_MS = 30_000;
export const DEFAULT_BATCH_LIMIT = 25;

export interface RequirementsLoopOptions {
  readonly intervalMs?: number;
  readonly limit?: number;
  readonly isReady?: () => boolean;
}

export interface RequirementsLoop {
  runOnce(): Promise<RequirementsQueueSummary | null>;
  stop(): void;
}

export function startRequirementsLoop(
  deps: RequirementsQueueDeps,
  options: RequirementsLoopOptions = {},
): RequirementsLoop {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const limit = options.limit ?? DEFAULT_BATCH_LIMIT;
  const isReady = options.isReady ?? ((): boolean => true);
  const logger: Logger = deps.logger;

  let stopped = false;
  let inFlight = false;
  let timer: NodeJS.Timeout | undefined;

  async function runOnce(): Promise<RequirementsQueueSummary | null> {
    if (stopped || inFlight) return null;
    if (!isReady()) return null;

    inFlight = true;
    try {
      return await processReceivedIntakeItems(deps, limit);
    } catch (error) {
      logger.error('requirements queue pass failed', { error });
      return null;
    } finally {
      inFlight = false;
    }
  }

  timer = setInterval(() => {
    void runOnce();
  }, intervalMs);
  timer.unref?.();

  logger.info('requirements loop started', { intervalMs, limit });

  return {
    runOnce,
    stop(): void {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      logger.info('requirements loop stopped');
    },
  };
}
