/**
 * GET /operator/tickets — every recent ticket and where it is, for the
 * console's Tickets tab (api/console-ui.ts).
 *
 * Read-only and derived, never stored: before a run exists the position is
 * the intake item's own status (received / pending_approval / approved /
 * rejected); once a run exists it is `computeRunStatus`'s stage, loaded
 * through the same `loadRunStatusView` GET /runs/:runId uses — so this list
 * and the per-run view can never disagree about where a ticket is.
 *
 * Gated behind the operator token, like every other /operator route.
 */

import type { IncomingMessage } from 'node:http';

import type { IntakeRepository } from '../intake/repository.ts';
import type { Logger } from '../logging/logger.ts';
import type { RunsRepository } from '../orchestrator/repository.ts';
import type { RequirementsRepository } from '../requirements/repository.ts';
import { AUTHORIZATION_HEADER, verifyOperatorToken } from './operator-auth.ts';
import { computeRunStatus } from '../pipeline/run-status.ts';
import { loadRunStatusView, type RunStatusSources } from './run-status.ts';

export const TICKETS_LIMIT = 50;

export interface OperatorTicketsDeps {
  readonly logger: Logger;
  /** OPERATOR_TOKEN. Absent means every request is refused. */
  readonly operatorToken: string | undefined;
  /** Absent while the database is unreachable. */
  readonly intake: Pick<IntakeRepository, 'list'> | undefined;
  readonly requirements: Pick<RequirementsRepository, 'findByIntakeItemId'> | undefined;
  readonly runs: Pick<RunsRepository, 'findByIntakeItemId'> | undefined;
  readonly sources: RunStatusSources | undefined;
}

export interface OperatorTicketsResult {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
}

export async function handleGetOperatorTickets(req: IncomingMessage, deps: OperatorTicketsDeps): Promise<OperatorTicketsResult> {
  const child = deps.logger.child({ route: 'operator.tickets' });

  const auth = verifyOperatorToken({
    token: deps.operatorToken,
    header: req.headers[AUTHORIZATION_HEADER] as string | undefined,
  });
  if (!auth.valid) {
    child.warn('operator tickets rejected: unauthorized', { reason: auth.reason });
    return { statusCode: 401, body: { error: 'unauthorized' } };
  }

  const { intake, requirements, runs, sources } = deps;
  if (intake === undefined || requirements === undefined || runs === undefined || sources === undefined) {
    child.error('operator tickets rejected: database unavailable');
    return { statusCode: 503, body: { error: 'unavailable' } };
  }

  const warnings = new Set<string>();
  const items = await intake.list({}, TICKETS_LIMIT);
  const tickets = await Promise.all(
    items.map(async (item) => {
      const id = item._id!;
      const [analysis, run] = await Promise.all([requirements.findByIntakeItemId(id), runs.findByIntakeItemId(id)]);
      const selection = run === null ? null : await sources.selections.findByRunId(run._id!);
      let view = null;
      if (run !== null) {
        try {
          view = await loadRunStatusView(run, sources);
        } catch (error) {
          // A database role that cannot read a later-stage collection (e.g.
          // changeReviews on an environment whose grants predate it) must not
          // take the whole list down: report the stage from what IS readable
          // and say so, rather than a bare 500. Anything else still throws.
          if (!isAuthorizationError(error)) throw error;
          warnings.add((error as Error).message);
          view = computeRunStatus({ run, selection, review: null, execution: null, publication: null, deployment: null });
        }
      }
      return {
        issueKey: item.issueKey,
        title: item.snapshot.title,
        project: item.snapshot.project ?? null,
        issueType: item.snapshot.issueType,
        priority: item.snapshot.priority ?? null,
        intakeStatus: item.status,
        statusReason: item.statusReason,
        receivedAt: item.receivedAt,
        approvedBy: item.approvedBy,
        approvedAt: item.approvedAt,
        analysis: analysis === null ? null : { status: analysis.status, agentVersion: analysis.agentVersion, completedAt: analysis.completedAt },
        repository:
          selection === null
            ? null
            : {
                selectionStatus: selection.status,
                candidates: selection.candidateRepositoryIds,
                selectedRepositoryId: selection.selectedRepositoryId,
                selectedRepositoryUrl: selection.selectedRepositoryUrl,
                selectedDefaultBranch: selection.selectedDefaultBranch,
                confirmedBy: selection.confirmedBy,
                confirmedAt: selection.confirmedAt,
              },
        run: view,
      };
    }),
  );

  if (warnings.size > 0) child.warn('operator tickets: later pipeline stages unreadable', { detail: [...warnings] });
  return { statusCode: 200, body: { tickets, warnings: [...warnings] } };
}

/**
 * The connected user's role lacks the action. MongoDB reports this as
 * `Unauthorized` (code 13); Atlas reports it as a generic `AtlasError`
 * (code 8000) whose message says "not allowed to do action" — 8000 alone
 * covers unrelated Atlas failures too, so it only counts with that message.
 */
export function isAuthorizationError(error: unknown): boolean {
  const e = error as { code?: unknown; codeName?: unknown; message?: unknown } | null;
  if (e === null || typeof e !== 'object') return false;
  if (e.code === 13 || e.codeName === 'Unauthorized') return true;
  return e.code === 8000 && typeof e.message === 'string' && /not allowed to do action/.test(e.message);
}
