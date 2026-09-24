/**
 * Batch driver for `runRequirementsAgent` — the piece that was missing
 * between it and a scheduler. Every previous phase's requirements work
 * (worker.ts, approval-transition.ts) operates on ONE already-known intake
 * item; this module is the first thing in the codebase that decides WHICH
 * intake items are eligible.
 *
 * Eligibility: `intakeItems.status === 'received'` — the state an item
 * sits in before it has requirements to show a human (see
 * `intake/state.ts`'s `received → pending_approval → approved`). An item
 * moves out of `received` via `approval-transition.ts`'s
 * `advanceToPendingApproval`, called here immediately after
 * `runRequirementsAgent` — the exact sequence that module's own docstring
 * describes ("Called once, right after runRequirementsAgent() returns").
 *
 * This module never writes to `intakeItems` itself — `runRequirementsAgent`
 * only ever writes `requirementsAnalyses`, and `advanceToPendingApproval`
 * is the one and only write path to `intakeItems.status` here, exactly as
 * designed. Ordering mirrors every other queue worker in this codebase
 * (orchestrator/worker.ts, repository-selection/worker.ts,
 * enrichment/worker.ts): one pass over candidates, one bad item never
 * stops the rest.
 */

import type { AuditLog } from '../db/audit-log.ts';
import type { IntakeRepository } from '../intake/repository.ts';
import type { Logger } from '../logging/logger.ts';
import type { IntakeSnapshot } from '../intake/repository.ts';
import type { RequirementsResult } from './analyzer.ts';
import { advanceToPendingApproval } from './approval-transition.ts';
import { runRequirementsAgent } from './worker.ts';
import type { RequirementsRepository } from './repository.ts';

export interface RequirementsQueueDeps {
  readonly intake: IntakeRepository;
  readonly repository: RequirementsRepository;
  readonly audit: AuditLog;
  readonly logger: Logger;
  readonly now?: () => Date;
  /** Same injection point `RequirementsAgentDeps.analyze` offers — passed through unchanged. */
  readonly analyze?: (snapshot: IntakeSnapshot) => RequirementsResult | Promise<RequirementsResult>;
  readonly agentVersion?: string;
}

export interface RequirementsQueueSummary {
  readonly examined: number;
  readonly completed: number;
  readonly advancedToApproval: number;
  readonly skipped: number;
  readonly failed: number;
}

/** One pass over `received` intake items. Scheduling is the caller's concern — see scheduler.ts. */
export async function processReceivedIntakeItems(deps: RequirementsQueueDeps, limit = 25): Promise<RequirementsQueueSummary> {
  const { intake, logger } = deps;
  const received = await intake.list({ status: 'received' }, limit);

  let completed = 0;
  let advancedToApproval = 0;
  let skipped = 0;
  let failed = 0;

  for (const item of received) {
    try {
      const agentResult = await runRequirementsAgent(item, {
        repository: deps.repository,
        audit: deps.audit,
        logger: deps.logger,
        ...(deps.now === undefined ? {} : { now: deps.now }),
        ...(deps.analyze === undefined ? {} : { analyze: deps.analyze }),
        ...(deps.agentVersion === undefined ? {} : { agentVersion: deps.agentVersion }),
      });

      if (agentResult.outcome === 'completed') {
        completed += 1;
        const advanceOutcome = await advanceToPendingApproval(item, agentResult.outcome, { intake, logger });
        if (advanceOutcome === 'transitioned') advancedToApproval += 1;
      } else if (agentResult.outcome === 'skipped_up_to_date') {
        skipped += 1;
        // A completed analysis already exists for this exact content, yet
        // the item is still `received` — it was analyzed outside this queue
        // (e.g. `npm run requirements:run`) or a previous pass crashed
        // between analysis and transition. Without advancing here it would
        // sit in `received` forever: this queue is its only way out. Safe to
        // repeat — intake.transition() refuses anything no longer `received`.
        const advanceOutcome = await advanceToPendingApproval(item, 'completed', { intake, logger });
        if (advanceOutcome === 'transitioned') advancedToApproval += 1;
      } else {
        // 'failed_validation' / 'failed_analysis': the item stays `received`
        // with a `failed` requirementsAnalyses row — never advanced to
        // pending_approval with nothing for a human to review. It is picked
        // up again next pass; a genuinely permanent failure (bad snapshot
        // shape) will simply fail the same way every time, visible via
        // requirementsAnalyses.status and its own audit trail.
        failed += 1;
      }
    } catch (error) {
      failed += 1;
      logger.error('requirements queue: item failed unexpectedly', { issueKey: item.issueKey, error });
    }
  }

  if (received.length > 0) {
    logger.info('requirements queue pass complete', { examined: received.length, completed, advancedToApproval, skipped, failed });
  }
  return { examined: received.length, completed, advancedToApproval, skipped, failed };
}
