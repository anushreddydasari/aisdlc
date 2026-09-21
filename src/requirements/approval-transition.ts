/**
 * Advances an intake item to `pending_approval` once the Requirements
 * Agent has freshly completed its analysis.
 *
 * Deliberately NOT part of worker.ts: that module's whole contract is that
 * `intakeItems` is read-only input — "the only collection this module
 * writes to is `requirementsAnalyses`... nothing here ever calls a write
 * method on the intake repository" (see worker.ts's docstring, and the
 * "does not modify the intake item it was given" test in worker.test.ts).
 * This module is the caller-side orchestration that sits above both
 * requirements/worker.ts and intake/repository.ts, the same way
 * enrichment/worker.ts sits above webhook-deliveries.ts and
 * intake/repository.ts to create an intake item in the first place.
 *
 * All state-machine enforcement and the audit entry for this transition
 * come from intake/repository.ts's transition() unchanged — this module
 * never touches intakeItems directly and never writes its own audit entry.
 */

import type { IntakeItemDocument, IntakeRepository } from '../intake/repository.ts';
import { IntakeConflictError } from '../intake/repository.ts';
import { InvalidTransitionError } from '../intake/state.ts';
import type { Logger } from '../logging/logger.ts';
import type { RequirementsOutcome } from './worker.ts';

/** Recorded as the transition's actor — never a human's name, so it is never mistaken for an approval. */
export const REQUIREMENTS_AGENT_SYSTEM_ACTOR = 'system:requirements-agent';

export type ApprovalAdvanceOutcome =
  /** Moved received -> pending_approval. */
  | 'transitioned'
  /** requirementsOutcome was not a fresh `completed` — nothing to advance on. */
  | 'skipped_no_fresh_completion'
  /** The item was not in `received` (already advanced, approved, rejected, or failed). */
  | 'skipped_not_received'
  /** Another writer changed the item between its last read and this transition. */
  | 'conflict';

export interface AdvanceToApprovalDeps {
  readonly intake: IntakeRepository;
  readonly logger: Logger;
}

/**
 * Called once, right after runRequirementsAgent() returns.
 *
 * Idempotent by construction, not by any new locking added here: a repeat
 * run against unchanged content makes runRequirementsAgent() itself return
 * `skipped_up_to_date` (see worker.ts), which this function treats as
 * `skipped_no_fresh_completion` and never attempts a transition for — so
 * running the Requirements Agent twice can never produce two transitions.
 * If the content genuinely changed and re-analysis completes again, the
 * item is by then no longer `received` (it moved to `pending_approval` the
 * first time, or further still), so intake.transition() itself refuses the
 * second attempt via InvalidTransitionError, caught below as
 * `skipped_not_received` — never forced, never a crash.
 *
 * Concurrency is intake.transition()'s existing compare-and-set
 * (`findOneAndUpdate({ issueKey, status: from })`): of two racing callers
 * who both read `received`, exactly one's update matches and wins; the
 * other's matches nothing and throws IntakeConflictError, caught here and
 * logged rather than retried — a retry is just running this again, and the
 * caller already controls that cadence.
 */
export async function advanceToPendingApproval(
  intakeItem: IntakeItemDocument,
  requirementsOutcome: RequirementsOutcome,
  deps: AdvanceToApprovalDeps,
): Promise<ApprovalAdvanceOutcome> {
  const { intake, logger } = deps;
  const issueKey = intakeItem.issueKey;

  if (requirementsOutcome !== 'completed') {
    logger.info('requirements agent: intake item not advanced to pending_approval', {
      issueKey,
      requirementsOutcome,
      reason: 'analysis did not freshly complete',
    });
    return 'skipped_no_fresh_completion';
  }

  try {
    await intake.transition(issueKey, 'pending_approval', { actor: REQUIREMENTS_AGENT_SYSTEM_ACTOR });
    logger.info('intake item advanced to pending_approval', {
      issueKey,
      actor: REQUIREMENTS_AGENT_SYSTEM_ACTOR,
    });
    return 'transitioned';
  } catch (error) {
    if (error instanceof InvalidTransitionError) {
      logger.info('requirements agent: intake item not advanced to pending_approval', {
        issueKey,
        currentStatus: error.from,
        reason: 'not in received state',
      });
      return 'skipped_not_received';
    }
    if (error instanceof IntakeConflictError) {
      // Logged, not retried: this function runs once per Requirements
      // Agent completion, and a retry is just being called again.
      logger.warn('requirements agent: could not advance intake item to pending_approval', {
        issueKey,
        reason: 'concurrent modification',
      });
      return 'conflict';
    }
    throw error;
  }
}
