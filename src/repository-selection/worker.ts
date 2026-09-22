/**
 * Repository selection matching.
 *
 * Turns a queued run into a repository selection row: `pending` when
 * exactly one active `repositoryRegistry` entry matches the run's project,
 * `ambiguous` for more than one, `failed` for none. This module NEVER sets
 * a selection to `selected` — decision D2 requires a human confirmation for
 * every run, even a single-candidate match, and that transition lives
 * solely in repository-selection/repository.ts's `confirm()`.
 *
 * Two passes in one worker, run together because they share the same
 * matching logic:
 *
 *   1. Queued runs with no selection row yet -> create one (first attempt).
 *   2. Existing `failed`/`ambiguous` rows due for retry -> re-match against
 *      the registry's current state (decision D6: "retry automatically").
 *      A `pending` row is never revisited: once a single candidate exists,
 *      the outstanding step is a human confirmation, not another match
 *      attempt. This is a stated limitation, not an oversight — see
 *      docs/repository-selection.md.
 *
 * Notification (decision D6's "notify an authorized person") is a plain
 * audit entry, not a new mechanism, matching how the rest of this codebase
 * treats state changes worth surfacing. `lastNotifiedStatus` gates it: a
 * repeated retry that lands on the same unresolved outcome does not
 * re-notify, only a genuine transition into (or between) `failed` and
 * `ambiguous` does.
 */

import type { ObjectId } from 'mongodb';

import type { AuditLog } from '../db/audit-log.ts';
import type { IntakeRepository } from '../intake/repository.ts';
import type { Logger } from '../logging/logger.ts';
import type { RunsRepository } from '../orchestrator/repository.ts';
import type { RepositoryRegistryRepository } from '../repository-registry/repository.ts';
import {
  type MatchOutcomeStatus,
  type RepositorySelectionRepository,
} from './repository.ts';

/** Recorded as the matching-pass audit entry's actor — never a human or another system component's identity. */
export const REPOSITORY_SELECTION_SYSTEM_ACTOR = 'system:repository-selection';

/** First retry after a minute, doubling, capped so recovery stays timely. Same shape as enrichment's backoff. */
export const RETRY_BASE_MS = 60_000;
export const RETRY_MAX_MS = 60 * 60_000;

export function backoffMs(attempts: number): number {
  const exponent = Math.max(0, attempts);
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** exponent);
}

export interface MatchRepositorySelectionsDeps {
  readonly intake: IntakeRepository;
  readonly runs: RunsRepository;
  readonly registry: RepositoryRegistryRepository;
  readonly selections: RepositorySelectionRepository;
  readonly audit: AuditLog;
  readonly logger: Logger;
  readonly now?: () => Date;
}

export interface MatchSelectionsSummary {
  readonly newlyExamined: number;
  readonly retriesExamined: number;
  readonly pending: number;
  readonly ambiguous: number;
  readonly failed: number;
  readonly skipped: number;
}

/** No candidate -> failed; exactly one -> pending (still needs a human); more than one -> ambiguous. */
export function classifyCandidates(candidateRepositoryIds: readonly string[]): MatchOutcomeStatus {
  if (candidateRepositoryIds.length === 0) return 'failed';
  if (candidateRepositoryIds.length === 1) return 'pending';
  return 'ambiguous';
}

async function notify(
  audit: AuditLog,
  logger: Logger,
  selectionId: ObjectId,
  detail: { issueKey: string; projectIdentifier: string; status: MatchOutcomeStatus; failureReason: string | null },
): Promise<void> {
  await audit.append({
    actor: REPOSITORY_SELECTION_SYSTEM_ACTOR,
    action: 'repository-selection.notification',
    subjectType: 'repositorySelection',
    subjectId: selectionId,
    detail,
  });
  logger.warn('repository selection needs attention', detail);
}

/** One pass: new queued runs, then retryable failed/ambiguous rows. Scheduling is the caller's concern. */
export async function matchRepositorySelections(
  deps: MatchRepositorySelectionsDeps,
  limit = 25,
): Promise<MatchSelectionsSummary> {
  const { intake, runs, registry, selections, audit, logger } = deps;
  const now = deps.now ?? (() => new Date());

  let pending = 0;
  let ambiguous = 0;
  let failed = 0;
  let skipped = 0;

  const queuedRuns = await runs.list({ status: 'queued' }, limit);
  let newlyExamined = 0;

  for (const run of queuedRuns) {
    if (run._id === undefined) continue;

    const existing = await selections.findByRunId(run._id);
    if (existing !== null) continue; // Already has a selection row; nothing new to do.

    newlyExamined += 1;
    try {
      const item = await intake.findByIssueKey(run.issueKey);
      if (item === null) {
        skipped += 1;
        logger.error('queued run has no matching intake item; skipping', { issueKey: run.issueKey });
        continue;
      }

      const projectIdentifier = item.snapshot.project ?? null;
      const candidateRepositoryIds =
        projectIdentifier === null || projectIdentifier === ''
          ? []
          : (await registry.findActiveByProjectIdentifier(projectIdentifier)).map((e) => e.repositoryId);
      const status = classifyCandidates(candidateRepositoryIds);
      const failureReason =
        status === 'failed'
          ? projectIdentifier === null || projectIdentifier === ''
            ? 'intake item has no project identifier'
            : `no active repository is mapped to project '${projectIdentifier}'`
          : null;
      const at = now();

      const result = await selections.createInitial({
        runId: run._id,
        intakeItemId: run.intakeItemId,
        issueKey: run.issueKey,
        projectIdentifier: projectIdentifier ?? '',
        candidateRepositoryIds,
        status,
        failureReason,
        nextAttemptAt: status === 'pending' ? at : new Date(at.getTime() + backoffMs(0)),
        lastNotifiedStatus: status === 'pending' ? null : status,
      });

      if (result.created && status !== 'pending') {
        await notify(audit, logger, result.selection._id!, {
          issueKey: run.issueKey,
          projectIdentifier: projectIdentifier ?? '',
          status,
          failureReason,
        });
      }

      if (status === 'pending') pending += 1;
      else if (status === 'ambiguous') ambiguous += 1;
      else failed += 1;
    } catch (error) {
      skipped += 1;
      logger.error('failed to match repository for queued run', { issueKey: run.issueKey, error });
    }
  }

  const dueForRetry = await selections.findDueForRetry(now(), limit);
  for (const selection of dueForRetry) {
    try {
      const candidateRepositoryIds = (
        await registry.findActiveByProjectIdentifier(selection.projectIdentifier)
      ).map((e) => e.repositoryId);
      const status = classifyCandidates(candidateRepositoryIds);
      const failureReason =
        status === 'failed' ? `no active repository is mapped to project '${selection.projectIdentifier}'` : null;
      const at = now();
      const shouldNotify = status !== 'pending' && selection.lastNotifiedStatus !== status;

      const updated = await selections.recordMatchResult(selection.runId, {
        candidateRepositoryIds,
        status,
        failureReason,
        nextAttemptAt: status === 'pending' ? at : new Date(at.getTime() + backoffMs(selection.attempts)),
        ...(status === 'pending' ? {} : shouldNotify ? { lastNotifiedStatus: status } : {}),
      });

      if (updated === null) {
        skipped += 1;
        continue; // Confirmed or otherwise resolved concurrently; nothing to do.
      }

      if (shouldNotify) {
        await notify(audit, logger, updated._id!, {
          issueKey: updated.issueKey,
          projectIdentifier: updated.projectIdentifier,
          status,
          failureReason,
        });
      }

      if (status === 'pending') pending += 1;
      else if (status === 'ambiguous') ambiguous += 1;
      else failed += 1;
    } catch (error) {
      skipped += 1;
      logger.error('failed to retry repository selection match', {
        issueKey: selection.issueKey,
        error,
      });
    }
  }

  const summary: MatchSelectionsSummary = {
    newlyExamined,
    retriesExamined: dueForRetry.length,
    pending,
    ambiguous,
    failed,
    skipped,
  };
  if (newlyExamined > 0 || dueForRetry.length > 0) {
    logger.info('repository selection matching pass complete', { ...summary });
  }
  return summary;
}
