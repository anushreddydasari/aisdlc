/**
 * GET /runs/:runId — a composed, end-to-end view of one run.
 *
 * Read-only, but gated behind the operator bearer token anyway, for the
 * same reason `repository-registry.ts`'s GET routes are: consistency with
 * every other operator-facing route in this codebase, one shared
 * authorization convention rather than a per-route exception.
 *
 * All the derivation logic lives in pipeline/run-status.ts's
 * `computeRunStatus` — this handler's only job is auth, fetching the rows
 * that function needs, and translating "not found" into a 404. See that
 * module's comment for why the view is computed fresh from existing
 * collections rather than a new stored field.
 */

import type { IncomingMessage } from 'node:http';
import { ObjectId } from 'mongodb';

import type { RunDocument, RunsRepository } from '../orchestrator/repository.ts';
import type { RepositorySelectionRepository } from '../repository-selection/repository.ts';
import type { ChangeReviewRepository } from '../change-execution/review-repository.ts';
import type { ChangeExecutionRepository } from '../change-execution/execution-repository.ts';
import type { GithubPublicationRepository } from '../github-publish/publish-repository.ts';
import type { DeploymentRepository } from '../deployment/deployment-repository.ts';
import type { Logger } from '../logging/logger.ts';
import { computeRunStatus, type RunStatusView } from '../pipeline/run-status.ts';
import { AUTHORIZATION_HEADER, verifyOperatorToken } from './operator-auth.ts';

export interface RunStatusDeps {
  readonly logger: Logger;
  /** OPERATOR_TOKEN. Absent means every request is refused. */
  readonly operatorToken: string | undefined;
  /** Absent while the database is unreachable. */
  readonly runs: RunsRepository | undefined;
  readonly selections: RepositorySelectionRepository | undefined;
  readonly reviews: ChangeReviewRepository | undefined;
  readonly executions: ChangeExecutionRepository | undefined;
  readonly publications: GithubPublicationRepository | undefined;
  readonly deployments: DeploymentRepository | undefined;
}

export interface RunStatusApiResult {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
}

const UNAUTHORIZED: RunStatusApiResult = { statusCode: 401, body: { error: 'unauthorized' } };
const INVALID: RunStatusApiResult = { statusCode: 400, body: { error: 'invalid_request' } };
const NOT_FOUND: RunStatusApiResult = { statusCode: 404, body: { error: 'not_found' } };
const UNAVAILABLE: RunStatusApiResult = { statusCode: 503, body: { error: 'unavailable' } };

export async function handleGetRunStatus(
  req: IncomingMessage,
  deps: RunStatusDeps,
  runIdParam: string,
): Promise<RunStatusApiResult> {
  const child = deps.logger.child({ route: 'runs.status' });

  const auth = verifyOperatorToken({
    token: deps.operatorToken,
    header: req.headers[AUTHORIZATION_HEADER] as string | undefined,
  });
  if (!auth.valid) {
    child.warn('run status rejected: unauthorized', { reason: auth.reason });
    return UNAUTHORIZED;
  }

  if (
    deps.runs === undefined ||
    deps.selections === undefined ||
    deps.reviews === undefined ||
    deps.executions === undefined ||
    deps.publications === undefined ||
    deps.deployments === undefined
  ) {
    child.error('run status rejected: database unavailable');
    return UNAVAILABLE;
  }

  if (!ObjectId.isValid(runIdParam) || !/^[0-9a-fA-F]{24}$/.test(runIdParam)) {
    return INVALID;
  }
  const runId = new ObjectId(runIdParam);

  const run = await deps.runs.findById(runId);
  if (run === null) return NOT_FOUND;

  const view = await loadRunStatusView(run, deps as RunStatusSources);
  return { statusCode: 200, body: view as unknown as Record<string, unknown> };
}

/** The repositories `loadRunStatusView` reads — RunStatusDeps' database half, all present. */
export interface RunStatusSources {
  readonly selections: RepositorySelectionRepository;
  readonly reviews: ChangeReviewRepository;
  readonly executions: ChangeExecutionRepository;
  readonly publications: GithubPublicationRepository;
  readonly deployments: DeploymentRepository;
}

/**
 * Fetches every row `computeRunStatus` needs for one run, following the
 * run → selection / latest review → execution → publication → deployment
 * chain. Shared by GET /runs/:runId and the console's ticket list
 * (api/operator-tickets.ts), so both report the same stage.
 */
export async function loadRunStatusView(run: RunDocument, sources: RunStatusSources): Promise<RunStatusView> {
  const runId = run._id!;
  const selection = await sources.selections.findByRunId(runId);
  const review = await sources.reviews.findLatestByRunId(runId);
  const execution = review === null || review._id === undefined ? null : await sources.executions.findByReviewId(review._id);
  const publication = execution === null || execution._id === undefined ? null : await sources.publications.findByExecutionId(execution._id);
  const deployment = publication === null || publication._id === undefined ? null : await sources.deployments.findByPublicationId(publication._id);
  return computeRunStatus({ run, selection, review, execution, publication, deployment });
}
