/**
 * Runs the pipeline's automatic post-approval stages — change execution,
 * GitHub publish, PR-merge detection, and deployment — on an interval,
 * inside the service process.
 *
 * ONE loop for all four passes, deliberately, rather than separate
 * schedulers: each stage is strictly sequential in the pipeline (an
 * execution must succeed before anything is publishable; a publication
 * must exist before its PR can be merge-checked; a merge must be detected
 * before anything is deployment-eligible), so running them back-to-back in
 * the same tick means a row can advance through several stages in ONE
 * pass rather than waiting a full extra interval per stage. The loop shape
 * itself (setInterval + inFlight guard + isReady + unref) is unchanged
 * from every other scheduler in this codebase — see
 * orchestrator/scheduler.ts's module comment for why that shape is copied
 * per domain rather than shared.
 *
 * Deliberately excludes the Coding Agent trigger — see
 * coding-agent-trigger.ts's module comment for why that step has no
 * automatic eligibility query to poll. PR-merge detection and deployment
 * are the opposite case: fully automatic, since "has a human merged yet"
 * and "is this the latest succeeded execution" are both things this
 * service can always determine for itself from persisted state.
 */

import type { Logger } from '../logging/logger.ts';
import { executeApprovedReviews, type ChangeExecutionQueueDeps, type ChangeExecutionQueueSummary } from './change-execution-queue.ts';
import { publishSucceededExecutions, type GithubPublishQueueDeps, type GithubPublishQueueSummary } from './github-publish-queue.ts';
import { detectMergedPullRequests, type PrMergeDetectionDeps, type PrMergeDetectionSummary } from '../deployment/pr-merge-detection.ts';
import { runEligibleDeployments, type DeploymentQueueDeps, type DeploymentQueueSummary } from '../deployment/deployment-queue.ts';

export const DEFAULT_INTERVAL_MS = 30_000;
export const DEFAULT_BATCH_LIMIT = 25;

export interface PipelineLoopDeps {
  readonly changeExecution: ChangeExecutionQueueDeps;
  readonly githubPublish: GithubPublishQueueDeps;
  readonly prMergeDetection: PrMergeDetectionDeps;
  readonly deployment: DeploymentQueueDeps;
  readonly logger: Logger;
}

export interface PipelineLoopOptions {
  readonly intervalMs?: number;
  readonly limit?: number;
  readonly isReady?: () => boolean;
}

export interface PipelinePassSummary {
  readonly changeExecution: ChangeExecutionQueueSummary;
  readonly githubPublish: GithubPublishQueueSummary;
  readonly prMergeDetection: PrMergeDetectionSummary;
  readonly deployment: DeploymentQueueSummary;
}

export interface PipelineLoop {
  runOnce(): Promise<PipelinePassSummary | null>;
  stop(): void;
}

export function startPipelineLoop(deps: PipelineLoopDeps, options: PipelineLoopOptions = {}): PipelineLoop {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const limit = options.limit ?? DEFAULT_BATCH_LIMIT;
  const isReady = options.isReady ?? ((): boolean => true);
  const logger: Logger = deps.logger;

  let stopped = false;
  let inFlight = false;
  let timer: NodeJS.Timeout | undefined;

  async function runOnce(): Promise<PipelinePassSummary | null> {
    if (stopped || inFlight) return null;
    if (!isReady()) return null;

    inFlight = true;
    try {
      const changeExecution = await executeApprovedReviews(deps.changeExecution, limit);
      const githubPublish = await publishSucceededExecutions(deps.githubPublish, limit);
      const prMergeDetection = await detectMergedPullRequests(deps.prMergeDetection, limit);
      const deployment = await runEligibleDeployments(deps.deployment, limit);
      return { changeExecution, githubPublish, prMergeDetection, deployment };
    } catch (error) {
      logger.error('pipeline pass failed', { error });
      return null;
    } finally {
      inFlight = false;
    }
  }

  timer = setInterval(() => {
    void runOnce();
  }, intervalMs);
  timer.unref?.();

  logger.info('pipeline loop started', { intervalMs, limit });

  return {
    runOnce,
    stop(): void {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      logger.info('pipeline loop stopped');
    },
  };
}
