/**
 * GET /operator/queue — what is waiting on a human, for the AISDLC
 * Console's Approvals tab (api/console-ui.ts).
 *
 * Read-only. Every decision the console offers is made through the routes
 * that already existed before it — POST /intake/:issueKey/approve|reject
 * (Gate 1) and POST /repository-selections/:runId/confirm (Gate 2) — so
 * the state-machine and `operator:` enforcement stay exactly where they
 * were. This module only answers "what can a human act on right now".
 *
 * Gated behind the operator token like GET /runs/:runId, for the same
 * reason: ticket content and requirements analyses are not public.
 */

import type { IncomingMessage } from 'node:http';

import type { IntakeRepository } from '../intake/repository.ts';
import type { Logger } from '../logging/logger.ts';
import type { RepositoryRegistryRepository } from '../repository-registry/repository.ts';
import type { RepositorySelectionDocument, SelectionQueueQueries } from '../repository-selection/repository.ts';
import type { RequirementsRepository } from '../requirements/repository.ts';
import type { ChangeReviewQueueQueries } from '../change-execution/review-repository.ts';
import { AUTHORIZATION_HEADER, verifyOperatorToken } from './operator-auth.ts';

export const QUEUE_LIMIT = 50;
const RECENT_LIMIT = 10;

export interface OperatorQueueDeps {
  readonly logger: Logger;
  /** OPERATOR_TOKEN. Absent means every request is refused. */
  readonly operatorToken: string | undefined;
  /** Absent while the database is unreachable. */
  readonly intake: Pick<IntakeRepository, 'list'> | undefined;
  readonly requirements: Pick<RequirementsRepository, 'findByIntakeItemId'> | undefined;
  readonly selections: SelectionQueueQueries | undefined;
  readonly registry: Pick<RepositoryRegistryRepository, 'findActiveByProjectIdentifier'> | undefined;
  /** Gate 3. Absent (e.g. GitHub App not configured, so no review can exist) means an empty list. */
  readonly reviews?: ChangeReviewQueueQueries | undefined;
}

export interface OperatorQueueResult {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
}

async function describeSelection(
  selection: RepositorySelectionDocument,
  registry: Pick<RepositoryRegistryRepository, 'findActiveByProjectIdentifier'>,
  activeByProject: Map<string, Awaited<ReturnType<RepositoryRegistryRepository['findActiveByProjectIdentifier']>>>,
): Promise<Record<string, unknown>> {
  const project = selection.projectIdentifier;
  let active = activeByProject.get(project);
  if (active === undefined) {
    active = project === '' ? [] : await registry.findActiveByProjectIdentifier(project);
    activeByProject.set(project, active);
  }
  return {
    runId: selection.runId.toHexString(),
    issueKey: selection.issueKey,
    projectIdentifier: project,
    status: selection.status,
    failureReason: selection.failureReason,
    // What the matcher found, annotated with the registry's CURRENT state:
    // confirm() re-checks against the current registry, so a candidate
    // deactivated since matching can no longer be chosen.
    candidates: selection.candidateRepositoryIds.map((repositoryId) => {
      const entry = active.find((e) => e.repositoryId === repositoryId);
      return {
        repositoryId,
        active: entry !== undefined,
        repositoryUrl: entry?.repositoryUrl ?? null,
        defaultBranch: entry?.defaultBranch ?? null,
      };
    }),
    updatedAt: selection.updatedAt,
  };
}

export async function handleGetOperatorQueue(req: IncomingMessage, deps: OperatorQueueDeps): Promise<OperatorQueueResult> {
  const child = deps.logger.child({ route: 'operator.queue' });

  const auth = verifyOperatorToken({
    token: deps.operatorToken,
    header: req.headers[AUTHORIZATION_HEADER] as string | undefined,
  });
  if (!auth.valid) {
    child.warn('operator queue rejected: unauthorized', { reason: auth.reason });
    return { statusCode: 401, body: { error: 'unauthorized' } };
  }

  const { intake, requirements, selections, registry } = deps;
  if (intake === undefined || requirements === undefined || selections === undefined || registry === undefined) {
    child.error('operator queue rejected: database unavailable');
    return { statusCode: 503, body: { error: 'unavailable' } };
  }

  const pending = await intake.list({ status: 'pending_approval' }, QUEUE_LIMIT);
  const pendingApproval = await Promise.all(
    pending.map(async (item) => {
      const analysis = item._id === undefined ? null : await requirements.findByIntakeItemId(item._id);
      return {
        issueKey: item.issueKey,
        title: item.snapshot.title,
        description: item.snapshot.description,
        issueType: item.snapshot.issueType,
        priority: item.snapshot.priority ?? null,
        project: item.snapshot.project ?? null,
        labels: item.snapshot.labels ?? [],
        receivedAt: item.receivedAt,
        analysis:
          analysis === null
            ? null
            : { status: analysis.status, agentVersion: analysis.agentVersion, result: analysis.result, completedAt: analysis.completedAt },
      };
    }),
  );

  const activeByProject = new Map<string, Awaited<ReturnType<RepositoryRegistryRepository['findActiveByProjectIdentifier']>>>();
  const awaiting = await selections.awaitingConfirmation(QUEUE_LIMIT);
  const awaitingRepository = [];
  for (const selection of awaiting) awaitingRepository.push(await describeSelection(selection, registry, activeByProject));

  const recent = await selections.recentlyConfirmed(RECENT_LIMIT);
  const recentlyConfirmed = recent.map((s) => ({
    runId: s.runId.toHexString(),
    issueKey: s.issueKey,
    projectIdentifier: s.projectIdentifier,
    selectedRepositoryId: s.selectedRepositoryId,
    selectedRepositoryUrl: s.selectedRepositoryUrl,
    selectedDefaultBranch: s.selectedDefaultBranch,
    confirmedBy: s.confirmedBy,
    confirmedAt: s.confirmedAt,
  }));

  // Gate 3: everything a reviewer needs to decide, straight from the review
  // row — the plan and the exact proposed file contents that would be
  // committed. Nothing is re-derived; the proposal hash pins what is shown.
  const pendingReviews = deps.reviews === undefined ? [] : await deps.reviews.pending(QUEUE_LIMIT);
  const pendingChangeReviews = pendingReviews.map((r) => ({
    reviewId: r._id!.toHexString(),
    runId: r.runId.toHexString(),
    repositoryId: r.repositoryId,
    repository: `${r.owner}/${r.repo}`,
    branch: r.branch,
    proposalHash: r.proposalHash,
    plan: r.plan,
    proposedChanges: r.proposedChanges.map((c) => ({
      filePath: c.filePath,
      operation: c.operation,
      reason: c.reason,
      proposedContent: c.proposedContent,
    })),
    createdAt: r.createdAt,
  }));

  return { statusCode: 200, body: { pendingApproval, awaitingRepository, recentlyConfirmed, pendingChangeReviews } };
}
