/**
 * GET /runs/:runId/deployment — the detailed deployment record for a run,
 * beyond what `GET /runs/:runId`'s compact view already carries (provider,
 * target, timestamps, the full post-deployment validation summary).
 *
 * Read-only, gated behind the operator bearer token for the same
 * consistency reason `run-status.ts` already documents. Follows the exact
 * same runId -> review -> execution -> publication -> deployment lookup
 * chain `run-status.ts` uses — not duplicated logic, just one more hop to
 * expose deployment-specific detail that view intentionally keeps compact.
 */

import type { IncomingMessage } from 'node:http';
import { ObjectId } from 'mongodb';

import type { RunsRepository } from '../orchestrator/repository.ts';
import type { ChangeReviewRepository } from '../change-execution/review-repository.ts';
import type { ChangeExecutionRepository } from '../change-execution/execution-repository.ts';
import type { GithubPublicationRepository } from '../github-publish/publish-repository.ts';
import type { DeploymentRepository } from '../deployment/deployment-repository.ts';
import type { Logger } from '../logging/logger.ts';
import { AUTHORIZATION_HEADER, verifyOperatorToken } from './operator-auth.ts';

export interface DeploymentStatusDeps {
  readonly logger: Logger;
  readonly operatorToken: string | undefined;
  readonly runs: RunsRepository | undefined;
  readonly reviews: ChangeReviewRepository | undefined;
  readonly executions: ChangeExecutionRepository | undefined;
  readonly publications: GithubPublicationRepository | undefined;
  readonly deployments: DeploymentRepository | undefined;
}

export interface DeploymentStatusApiResult {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
}

const UNAUTHORIZED: DeploymentStatusApiResult = { statusCode: 401, body: { error: 'unauthorized' } };
const INVALID: DeploymentStatusApiResult = { statusCode: 400, body: { error: 'invalid_request' } };
const NOT_FOUND: DeploymentStatusApiResult = { statusCode: 404, body: { error: 'not_found' } };
const UNAVAILABLE: DeploymentStatusApiResult = { statusCode: 503, body: { error: 'unavailable' } };

export async function handleGetDeploymentStatus(
  req: IncomingMessage,
  deps: DeploymentStatusDeps,
  runIdParam: string,
): Promise<DeploymentStatusApiResult> {
  const child = deps.logger.child({ route: 'runs.deployment' });

  const auth = verifyOperatorToken({
    token: deps.operatorToken,
    header: req.headers[AUTHORIZATION_HEADER] as string | undefined,
  });
  if (!auth.valid) {
    child.warn('deployment status rejected: unauthorized', { reason: auth.reason });
    return UNAUTHORIZED;
  }

  if (
    deps.runs === undefined ||
    deps.reviews === undefined ||
    deps.executions === undefined ||
    deps.publications === undefined ||
    deps.deployments === undefined
  ) {
    child.error('deployment status rejected: database unavailable');
    return UNAVAILABLE;
  }

  if (!ObjectId.isValid(runIdParam) || !/^[0-9a-fA-F]{24}$/.test(runIdParam)) {
    return INVALID;
  }
  const runId = new ObjectId(runIdParam);

  const run = await deps.runs.findById(runId);
  if (run === null) return NOT_FOUND;

  const review = await deps.reviews.findLatestByRunId(runId);
  const execution = review === null || review._id === undefined ? null : await deps.executions.findByReviewId(review._id);
  const publication = execution === null || execution._id === undefined ? null : await deps.publications.findByExecutionId(execution._id);
  const deployment = publication === null || publication._id === undefined ? null : await deps.deployments.findByPublicationId(publication._id);

  if (deployment === null) return NOT_FOUND;

  return {
    statusCode: 200,
    body: {
      runId: run._id!.toHexString(),
      deploymentId: deployment._id!.toHexString(),
      status: deployment.status,
      owner: deployment.owner,
      repo: deployment.repo,
      pullRequestNumber: deployment.pullRequestNumber,
      mergeCommitSha: deployment.mergeCommitSha,
      provider: deployment.provider,
      target: deployment.target,
      deploymentIdentifier: deployment.deploymentIdentifier,
      validation: deployment.validation,
      failureCategory: deployment.failureCategory,
      failureMessage: deployment.failureMessage,
      createdAt: deployment.createdAt,
      startedAt: deployment.startedAt,
      completedAt: deployment.completedAt,
    },
  };
}
