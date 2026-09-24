/**
 * Batch driver for `ChangeExecutionService.executeApprovedChanges` — closes
 * the gap between "Human Change Review" (an operator calling
 * `ChangeReviewRepository.approve()`) and "Approved Change Execution".
 *
 * Eligibility: every currently-`approved` review (`ChangeReviewRepository.findApproved`),
 * filtered down to the ones with no execution recorded yet
 * (`ChangeExecutionRepository.findByReviewId`) — the same "list broadly,
 * then check per-item via the idempotency lookup" shape
 * `repository-selection/worker.ts` already uses for its own "new" pass.
 * This is deliberately NOT "list approved reviews with no execution" as a
 * single query, because no such compound index/query exists and adding one
 * would duplicate what `executeApprovedChanges`'s own fast idempotency
 * path already guarantees — the per-item check here is a cheap
 * short-circuit, not the safety mechanism itself.
 *
 * `executeApprovedChanges` is idempotent, atomic, and already fully
 * audited (see change-execution/execution-service.ts) — this module adds
 * no new state and no new audit events of its own. One bad item never
 * stops the pass.
 */

import type { ChangeExecutionRepository } from '../change-execution/execution-repository.ts';
import type { ChangeReviewRepository } from '../change-execution/review-repository.ts';
import type { ChangeExecutionService } from '../change-execution/execution-service.ts';
import type { Logger } from '../logging/logger.ts';

export interface ChangeExecutionQueueDeps {
  readonly reviews: ChangeReviewRepository;
  readonly executions: ChangeExecutionRepository;
  readonly executionService: ChangeExecutionService;
  readonly logger: Logger;
}

export interface ChangeExecutionQueueSummary {
  readonly examined: number;
  readonly executed: number;
  readonly alreadyExecuted: number;
  readonly failed: number;
}

/** One pass over approved-but-not-yet-executed reviews. Scheduling is the caller's concern — see scheduler.ts. */
export async function executeApprovedReviews(deps: ChangeExecutionQueueDeps, limit = 25): Promise<ChangeExecutionQueueSummary> {
  const { reviews, executions, executionService, logger } = deps;
  const approved = await reviews.findApproved(limit);

  let executed = 0;
  let alreadyExecuted = 0;
  let failed = 0;

  for (const review of approved) {
    const reviewId = review._id;
    if (reviewId === undefined) {
      failed += 1;
      logger.error('change-execution queue: approved review has no _id; skipping');
      continue;
    }

    const existing = await executions.findByReviewId(reviewId);
    if (existing !== null) {
      alreadyExecuted += 1;
      continue;
    }

    try {
      const result = await executionService.executeApprovedChanges(review.runId, reviewId);
      if (result.ok) {
        executed += 1;
      } else {
        // A recorded (persisted) failure is not re-attempted by this pass —
        // executeApprovedChanges is itself idempotent and will simply
        // return the same recorded failure again next pass. Retrying here
        // would add nothing.
        failed += 1;
        logger.warn('change-execution queue: execution attempt failed', {
          reviewId: reviewId.toHexString(),
          category: result.category,
        });
      }
    } catch (error) {
      failed += 1;
      logger.error('change-execution queue: item failed unexpectedly', { reviewId: reviewId.toHexString(), error });
    }
  }

  if (approved.length > 0) {
    logger.info('change-execution queue pass complete', { examined: approved.length, executed, alreadyExecuted, failed });
  }
  return { examined: approved.length, executed, alreadyExecuted, failed };
}
