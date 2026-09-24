/**
 * Batch driver for `GithubPublishService.publishApprovedChanges` — closes
 * the gap between "Local Validation" succeeding and "GitHub Branch /
 * Commit / Push / Pull Request".
 *
 * Eligibility: every currently-`succeeded` execution
 * (`ChangeExecutionRepository.findSucceeded`), filtered down to the ones
 * with no publication recorded yet (`GithubPublicationRepository.findByExecutionId`)
 * — the same "list broadly, check per-item" shape
 * `change-execution-queue.ts` and `repository-selection/worker.ts` already
 * use. `publishApprovedChanges` is idempotent, and its own eligibility
 * phase re-derives everything this pass would otherwise need to check
 * twice (review still approved/current, repository/branch still
 * authorized) — see github-publish/publish-service.ts's module comment.
 */

import type { ChangeExecutionRepository } from '../change-execution/execution-repository.ts';
import type { GithubPublicationRepository } from '../github-publish/publish-repository.ts';
import type { GithubPublishService } from '../github-publish/publish-service.ts';
import type { Logger } from '../logging/logger.ts';

export interface GithubPublishQueueDeps {
  readonly executions: ChangeExecutionRepository;
  readonly publications: GithubPublicationRepository;
  readonly publishService: GithubPublishService;
  readonly logger: Logger;
}

export interface GithubPublishQueueSummary {
  readonly examined: number;
  readonly published: number;
  readonly alreadyPublished: number;
  readonly failed: number;
}

/** One pass over succeeded-but-not-yet-published executions. Scheduling is the caller's concern — see scheduler.ts. */
export async function publishSucceededExecutions(deps: GithubPublishQueueDeps, limit = 25): Promise<GithubPublishQueueSummary> {
  const { executions, publications, publishService, logger } = deps;
  const succeeded = await executions.findSucceeded(limit);

  let published = 0;
  let alreadyPublished = 0;
  let failed = 0;

  for (const execution of succeeded) {
    const executionId = execution._id;
    if (executionId === undefined) {
      failed += 1;
      logger.error('github-publish queue: succeeded execution has no _id; skipping');
      continue;
    }

    const existing = await publications.findByExecutionId(executionId);
    if (existing !== null) {
      alreadyPublished += 1;
      continue;
    }

    try {
      const result = await publishService.publishApprovedChanges(execution.runId, executionId);
      if (result.ok) {
        published += 1;
      } else {
        failed += 1;
        logger.warn('github-publish queue: publish attempt failed', {
          executionId: executionId.toHexString(),
          category: result.category,
        });
      }
    } catch (error) {
      failed += 1;
      logger.error('github-publish queue: item failed unexpectedly', { executionId: executionId.toHexString(), error });
    }
  }

  if (succeeded.length > 0) {
    logger.info('github-publish queue pass complete', { examined: succeeded.length, published, alreadyPublished, failed });
  }
  return { examined: succeeded.length, published, alreadyPublished, failed };
}
