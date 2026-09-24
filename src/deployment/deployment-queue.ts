/**
 * Batch driver for `DeploymentService.runDeployment` — the "Deployment
 * worker" in the pipeline diagram. Closes the gap between "Deployment
 * Eligibility" (a `deployments` row created by `pr-merge-detection.ts`)
 * and an actual deployment attempt.
 *
 * Eligibility: `DeploymentRepository.findEligible` — rows with
 * `status: 'eligible'`. `runDeployment` itself performs the CAS claim
 * (`eligible -> running`), so a row already claimed by a concurrent worker
 * is simply skipped (`runDeployment` returns `already_deployed`, counted
 * as `alreadyClaimed` here) — no separate idempotency check needed before
 * calling it, unlike `change-execution-queue.ts`/`github-publish-queue.ts`,
 * which check `findByReviewId`/`findByExecutionId` themselves because
 * THEIR underlying services do their own idempotent lookup by a different
 * key. Here, the claim IS the idempotency check.
 */

import type { DeploymentRepository } from './deployment-repository.ts';
import type { DeploymentService } from './deployment-service.ts';
import type { Logger } from '../logging/logger.ts';

export interface DeploymentQueueDeps {
  readonly deployments: DeploymentRepository;
  readonly deploymentService: DeploymentService;
  readonly logger: Logger;
}

export interface DeploymentQueueSummary {
  readonly examined: number;
  readonly deployed: number;
  readonly validationFailed: number;
  readonly alreadyClaimed: number;
  readonly failed: number;
}

/** One pass over eligible deployments. Scheduling is the caller's concern — see pipeline/scheduler.ts. */
export async function runEligibleDeployments(deps: DeploymentQueueDeps, limit = 25): Promise<DeploymentQueueSummary> {
  const { deployments, deploymentService, logger } = deps;
  const eligible = await deployments.findEligible(limit);

  let deployed = 0;
  let validationFailed = 0;
  let alreadyClaimed = 0;
  let failed = 0;

  for (const deployment of eligible) {
    const deploymentId = deployment._id;
    if (deploymentId === undefined) {
      failed += 1;
      logger.error('deployment queue: eligible row has no _id; skipping');
      continue;
    }

    try {
      const result = await deploymentService.runDeployment(deployment);
      if (result.ok) {
        deployed += 1;
      } else if (result.category === 'already_deployed') {
        alreadyClaimed += 1;
      } else if (result.category === 'validation_failed') {
        validationFailed += 1;
      } else {
        failed += 1;
        logger.warn('deployment queue: deployment attempt failed', { deploymentId: deploymentId.toHexString(), category: result.category });
      }
    } catch (error) {
      failed += 1;
      logger.error('deployment queue: item failed unexpectedly', { deploymentId: deploymentId.toHexString(), error });
    }
  }

  if (eligible.length > 0) {
    logger.info('deployment queue pass complete', { examined: eligible.length, deployed, validationFailed, alreadyClaimed, failed });
  }
  return { examined: eligible.length, deployed, validationFailed, alreadyClaimed, failed };
}
