/**
 * The orchestrator: queues exactly one run per approved intake item.
 *
 * This is the entire scope of this phase. It does not execute a run, does
 * not invoke a Coding or Testing Agent, and does not touch outboundWrites —
 * all of that is future work that starts by claiming a `queued` run this
 * module created.
 *
 * Read-only against intakeItems: this module never calls a write method on
 * IntakeRepository, the same boundary requirements/worker.ts and
 * approval-transition.ts already hold. A rejected (or any non-approved)
 * intake item is simply never returned by the `approved` query — no
 * separate handling is needed, because there is nothing to do for it.
 *
 * Ordering mirrors enrichment/worker.ts's drainPending: one pass over
 * candidates, one bad item must not stop the rest.
 */

import type { AuditLog } from '../db/audit-log.ts';
import type { IntakeRepository } from '../intake/repository.ts';
import type { Logger } from '../logging/logger.ts';
import type { RunsRepository } from './repository.ts';

/** Recorded as the run-queueing audit entry's actor — never a human or another system component's identity. */
export const ORCHESTRATOR_SYSTEM_ACTOR = 'system:orchestrator';

export interface QueueApprovedRunsDeps {
  readonly intake: IntakeRepository;
  readonly runs: RunsRepository;
  readonly audit: AuditLog;
  readonly logger: Logger;
}

export interface QueueRunsSummary {
  readonly examined: number;
  readonly queued: number;
  readonly alreadyQueued: number;
  readonly failed: number;
}

/** One pass over approved intake items. Scheduling is the caller's concern. */
export async function queueApprovedRuns(deps: QueueApprovedRunsDeps, limit = 25): Promise<QueueRunsSummary> {
  const { intake, runs, audit, logger } = deps;
  const approved = await intake.list({ status: 'approved' }, limit);

  let queued = 0;
  let alreadyQueued = 0;
  let failed = 0;

  for (const item of approved) {
    const intakeItemId = item._id;
    // Defensive only: every item returned by list() was just read from the
    // database, so it always carries an _id.
    if (intakeItemId === undefined) {
      failed += 1;
      logger.error('approved intake item has no _id; skipping', { issueKey: item.issueKey });
      continue;
    }

    try {
      const result = await runs.createIfAbsent({
        intakeItemId,
        issueKey: item.issueKey,
        trigger: 'approval',
      });

      if (!result.created) {
        alreadyQueued += 1;
        continue;
      }

      await audit.append({
        actor: ORCHESTRATOR_SYSTEM_ACTOR,
        action: 'run.queued',
        subjectType: 'run',
        subjectId: result.run._id!,
        detail: { issueKey: item.issueKey, intakeItemId, trigger: 'approval' },
      });
      logger.info('run queued for approved intake item', { issueKey: item.issueKey });
      queued += 1;
    } catch (error) {
      // One bad item must not stop the pass. It stays approved with no run,
      // and is picked up again next pass.
      failed += 1;
      logger.error('failed to queue run for approved intake item', { issueKey: item.issueKey, error });
    }
  }

  if (approved.length > 0) {
    logger.info('orchestrator pass complete', { examined: approved.length, queued, alreadyQueued, failed });
  }
  return { examined: approved.length, queued, alreadyQueued, failed };
}
