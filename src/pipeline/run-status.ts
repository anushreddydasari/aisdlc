/**
 * Derives a run's end-to-end pipeline stage from the state already
 * recorded across `runs`, `repositorySelections`, `changeReviews`,
 * `changeExecutions`, and `githubPublications` — NOT a new stored field.
 *
 * Deliberately not persisted on `runs.status`. Every stage this function
 * reports is already the responsibility of an existing collection's own
 * status field; storing a second, redundant "pipeline stage" on `runs`
 * would create exactly the second, competing source of truth this
 * codebase has refused to introduce at every previous phase (see
 * github-access/service.ts's and change-execution/execution-service.ts's
 * own module comments on this same point). This function is a VIEW, pure
 * and side-effect-free, over rows the pipeline queues already maintain.
 *
 * SAFE TO EXPOSE. Every field read here is already non-secret (statuses,
 * ids, branch/repo names, a PR url, a failure category and message) —
 * nothing in this function's input or output can carry a GitHub token,
 * JWT, private key, or `Authorization` header, because none of the
 * documents it reads carry one either (see each collection's own
 * validator comment in db/collections.ts for why).
 */

import type { RunDocument } from '../orchestrator/repository.ts';
import type { RepositorySelectionDocument } from '../repository-selection/repository.ts';
import type { ChangeReviewDocument } from '../change-execution/review-repository.ts';
import type { ChangeExecutionDocument } from '../change-execution/execution-repository.ts';
import type { GithubPublicationDocument } from '../github-publish/publish-repository.ts';
import type { DeploymentDocument } from '../deployment/deployment-repository.ts';
import { isPostDeploymentValidationSuccessful } from '../deployment/types.ts';

/**
 * Conceptually mirrors the pipeline diagram from `queued` onward — the
 * portion of the lifecycle that only exists once a run row does. Earlier
 * stages (`received`, `pending_approval`) describe the INTAKE ITEM, not a
 * run, and are read directly off `IntakeItemDocument.status` — no
 * derivation needed there.
 *
 * `deployment_eligible` implies "merged": `deployment/pr-merge-detection.ts`
 * only ever creates a `deployments` row with `status: 'eligible'` the
 * moment a merge is confirmed — there is no separate `merged` stage
 * because nothing distinct happens between those two facts in this
 * design; see that module's own comment.
 */
export type RunStage =
  | 'queued'
  | 'repository_selection'
  | 'repository_selection_failed'
  | 'repository_confirmed'
  | 'change_review'
  | 'change_rejected'
  | 'executing'
  | 'execution_failed'
  | 'publishing'
  | 'publish_failed'
  | 'awaiting_human_merge'
  | 'pr_closed_unmerged'
  | 'deployment_eligible'
  | 'deploying'
  | 'deployed'
  | 'deployment_validation_failed'
  | 'deployment_failed'
  | 'failed'
  | 'cancelled';

export interface RunStatusInputs {
  readonly run: RunDocument;
  readonly selection: RepositorySelectionDocument | null;
  /** The latest review for the run, if any — see ChangeReviewRepository.findLatestByRunId. */
  readonly review: ChangeReviewDocument | null;
  readonly execution: ChangeExecutionDocument | null;
  readonly publication: GithubPublicationDocument | null;
  readonly deployment: DeploymentDocument | null;
}

export interface RunStatusView {
  readonly runId: string;
  readonly intakeItemId: string;
  readonly issueKey: string;
  readonly runStatus: RunDocument['status'];
  readonly stage: RunStage;
  readonly humanActionRequired: boolean;
  readonly humanActionDescription: string | null;
  readonly repository: { readonly owner: string; readonly repo: string } | null;
  readonly branch: string | null;
  readonly reviewId: string | null;
  readonly reviewStatus: ChangeReviewDocument['status'] | null;
  readonly executionId: string | null;
  readonly executionStatus: ChangeExecutionDocument['status'] | null;
  readonly validationSummary: { readonly tests: boolean; readonly typecheck: boolean; readonly build: boolean } | null;
  readonly pullRequestNumber: number | null;
  readonly pullRequestUrl: string | null;
  readonly mergeCommitSha: string | null;
  readonly deploymentId: string | null;
  readonly deploymentStatus: DeploymentDocument['status'] | null;
  readonly deploymentValidation: { readonly health: boolean; readonly readiness: boolean } | null;
  readonly failureCategory: string | null;
  readonly failureMessage: string | null;
}

export function computeRunStatus(inputs: RunStatusInputs): RunStatusView {
  const { run, selection, review, execution, publication, deployment } = inputs;

  let stage: RunStage;
  let humanActionRequired = false;
  let humanActionDescription: string | null = null;
  let failureCategory: string | null = null;
  let failureMessage: string | null = null;

  if (run.status === 'cancelled') {
    stage = 'cancelled';
  } else if (run.status === 'failed') {
    stage = 'failed';
  } else if (publication !== null && publication.status === 'published' && deployment !== null) {
    if (deployment.status === 'closed_unmerged') {
      stage = 'pr_closed_unmerged';
    } else if (deployment.status === 'eligible') {
      stage = 'deployment_eligible';
    } else if (deployment.status === 'queued' || deployment.status === 'running') {
      stage = 'deploying';
    } else if (deployment.status === 'failed') {
      stage = 'deployment_failed';
      failureCategory = deployment.failureCategory;
      failureMessage = deployment.failureMessage;
    } else if (deployment.validation !== null && !isPostDeploymentValidationSuccessful(deployment.validation)) {
      stage = 'deployment_validation_failed';
    } else {
      stage = 'deployed';
    }
  } else if (publication !== null && publication.status === 'published') {
    stage = 'awaiting_human_merge';
    humanActionRequired = true;
    humanActionDescription = 'Review and merge (or close) the pull request. Merge is never automatic.';
  } else if (publication !== null && publication.status === 'failed') {
    stage = 'publish_failed';
    failureCategory = publication.failureCategory;
    failureMessage = publication.failureMessage;
  } else if (execution !== null && execution.status === 'succeeded') {
    stage = 'publishing';
  } else if (execution !== null && execution.status === 'failed') {
    stage = 'execution_failed';
    failureCategory = execution.failureCategory;
    failureMessage = execution.failureMessage;
  } else if (review !== null && review.status === 'approved') {
    stage = 'executing';
  } else if (review !== null && review.status === 'rejected') {
    stage = 'change_rejected';
  } else if (review !== null && review.status === 'pending') {
    stage = 'change_review';
    humanActionRequired = true;
    humanActionDescription = 'Approve or reject the proposed changes.';
  } else if (selection !== null && selection.status === 'selected') {
    stage = 'repository_confirmed';
  } else if (selection !== null && (selection.status === 'pending' || selection.status === 'ambiguous')) {
    stage = 'repository_selection';
    humanActionRequired = true;
    humanActionDescription = 'Confirm which repository this run should target.';
  } else if (selection !== null && selection.status === 'failed') {
    stage = 'repository_selection_failed';
    failureMessage = selection.failureReason;
  } else {
    stage = 'queued';
  }

  const validationSummary =
    execution?.validation === null || execution?.validation === undefined
      ? null
      : {
          tests: execution.validation.tests.ok,
          typecheck: execution.validation.typecheck.ok,
          build: execution.validation.build.ok,
        };

  const deploymentValidation =
    deployment?.validation === null || deployment?.validation === undefined
      ? null
      : { health: deployment.validation.health.ok, readiness: deployment.validation.readiness.ok };

  return {
    runId: run._id!.toHexString(),
    intakeItemId: run.intakeItemId.toHexString(),
    issueKey: run.issueKey,
    runStatus: run.status,
    stage,
    humanActionRequired,
    humanActionDescription,
    repository: review === null ? null : { owner: review.owner, repo: review.repo },
    branch: publication?.branch ?? review?.branch ?? null,
    reviewId: review === null ? null : review._id!.toHexString(),
    reviewStatus: review?.status ?? null,
    executionId: execution === null ? null : execution._id!.toHexString(),
    executionStatus: execution?.status ?? null,
    validationSummary,
    pullRequestNumber: publication?.pullRequestNumber ?? null,
    pullRequestUrl: publication?.pullRequestUrl ?? null,
    mergeCommitSha: deployment?.mergeCommitSha ?? null,
    deploymentId: deployment === null ? null : deployment._id!.toHexString(),
    deploymentStatus: deployment?.status ?? null,
    deploymentValidation,
    failureCategory,
    failureMessage,
  };
}
