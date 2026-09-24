/**
 * The deployment service — Deployment Eligibility → Deployment →
 * Post-Deployment Validation.
 *
 * IMPORTANT SAFETY RULE. This service only ever runs a deployment for a
 * row `pr-merge-detection.ts` already created from an ACTUALLY MERGED PR
 * (`status: 'eligible'`) — never for a `closed_unmerged` row (terminal,
 * `claim()` only ever matches `status: 'eligible'`), and never for an
 * arbitrary commit supplied any other way. The commit deployed is always
 * `deployment.mergeCommitSha`, read from the persisted row, never accepted
 * as a parameter from an HTTP request.
 *
 * DEPLOYMENT SUCCEEDING AND VALIDATION FAILING ARE RECORDED SEPARATELY
 * (Section 14). If the provider's `deploy()` call itself succeeds, the row
 * is marked `succeeded` regardless of what post-deployment validation
 * finds — a failing health check does not retroactively make the
 * deployment not have happened. `DeploymentResult.ok` reflects the
 * END-TO-END outcome a caller cares about (`false` if validation failed,
 * even though the persisted row's own `status` is `'succeeded'`); no
 * rollback is attempted or invented — see docs/deployment.md's "Current
 * limitations".
 *
 * RECONCILIATION. `deploy()`'s identifier is caller-supplied and
 * deterministic (see deployment-provider.ts's module comment), so an
 * ambiguous `deploy()` failure is reconciled via `getDeploymentStatus`
 * before being declared a genuine failure — the same
 * reconciliation-before-retry discipline `github-publish/publish-service.ts`
 * already established for `createBranch`/`createPullRequest`.
 */

import type { ObjectId } from 'mongodb';

import type { AuditLog } from '../db/audit-log.ts';
import type { Logger } from '../logging/logger.ts';
import type { DeploymentDocument, DeploymentRepository } from './deployment-repository.ts';
import type { DeploymentProvider, DeploymentRequest } from './deployment-provider.ts';
import type { PostDeploymentValidator } from './post-deployment-validator.ts';
import { isPostDeploymentValidationSuccessful, isRetryableDeploymentCategory, type DeploymentFailure, type DeploymentFailureCategory, type DeploymentResult } from './types.ts';

/** Recorded as every audit entry's actor. Never a human or another system component's identity. */
export const DEPLOYMENT_SERVICE_ACTOR = 'system:deployment';

export const DEFAULT_DEPLOYMENT_PROVIDER_NAME = 'mock';
export const DEFAULT_DEPLOYMENT_TARGET = 'mock-environment';

export interface DeploymentServiceDeps {
  readonly deployments: DeploymentRepository;
  readonly provider: DeploymentProvider;
  readonly validator: PostDeploymentValidator;
  readonly audit: AuditLog;
  readonly logger: Logger;
  readonly providerName?: string;
  readonly target?: string;
}

export interface DeploymentService {
  runDeployment(deployment: DeploymentDocument): Promise<DeploymentResult>;
}

function deploymentIdentifierFor(deployment: DeploymentDocument): string {
  return `deployment-${deployment.runId.toHexString()}-${deployment.executionId.toHexString()}`;
}

export function createDeploymentService(deps: DeploymentServiceDeps): DeploymentService {
  const { deployments, provider, validator, audit, logger } = deps;
  const providerName = deps.providerName ?? DEFAULT_DEPLOYMENT_PROVIDER_NAME;
  const target = deps.target ?? DEFAULT_DEPLOYMENT_TARGET;

  async function eligibilityFailure(
    runId: ObjectId,
    deploymentId: ObjectId,
    category: DeploymentFailureCategory,
    message: string,
  ): Promise<DeploymentFailure> {
    logger.child({ runId: runId.toHexString() }).warn('deployment refused before attempting', { deploymentId: deploymentId.toHexString(), category, message });
    await audit.append({
      actor: DEPLOYMENT_SERVICE_ACTOR,
      action: 'deployment.failed',
      subjectType: 'run',
      subjectId: runId,
      detail: { deploymentId: deploymentId.toHexString(), category },
    });
    return { ok: false, runId, deploymentId, category, message, retryable: isRetryableDeploymentCategory(category) };
  }

  return {
    async runDeployment(deployment: DeploymentDocument): Promise<DeploymentResult> {
      const deploymentId = deployment._id!;
      const claimed = await deployments.claim(deploymentId);
      if (claimed === null) {
        return eligibilityFailure(deployment.runId, deploymentId, 'already_deployed', 'deployment is no longer eligible — already claimed, running, or completed');
      }

      await audit.append({
        actor: DEPLOYMENT_SERVICE_ACTOR,
        action: 'deployment.started',
        subjectType: 'deployment',
        subjectId: deploymentId,
        detail: { runId: claimed.runId.toHexString(), publicationId: claimed.publicationId.toHexString() },
      });

      // Structurally always set for an 'eligible' row (only merge detection
      // ever creates one, always with a merge commit sha) — re-checked
      // rather than asserted, matching this module's "never guess" posture.
      if (claimed.mergeCommitSha === null) {
        await deployments.markFailed(deploymentId, { category: 'configuration_invalid', message: 'deployment has no merge commit sha' });
        return { ok: false, runId: claimed.runId, deploymentId, category: 'configuration_invalid', message: 'deployment has no merge commit sha', retryable: false };
      }

      const deploymentIdentifier = deploymentIdentifierFor(claimed);
      const request: DeploymentRequest = {
        runId: claimed.runId.toHexString(),
        executionId: claimed.executionId.toHexString(),
        publicationId: claimed.publicationId.toHexString(),
        owner: claimed.owner,
        repo: claimed.repo,
        mergeCommitSha: claimed.mergeCommitSha,
        target: { name: target },
        deploymentIdentifier,
      };

      const validated = await provider.validateDeployment(request);
      if (!validated.ok) {
        await deployments.markFailed(deploymentId, { category: 'configuration_invalid', message: validated.message });
        return { ok: false, runId: claimed.runId, deploymentId, category: 'configuration_invalid', message: validated.message, retryable: false };
      }

      const deployed = await provider.deploy(request);
      if (!deployed.ok) {
        // Ambiguous failure: reconcile before declaring it genuine — the
        // deploy may have actually landed despite a lost/failed response.
        const status = await provider.getDeploymentStatus(deploymentIdentifier);
        if (status.status !== 'succeeded') {
          const category: DeploymentFailureCategory = deployed.retryable ? 'deployment_timeout' : 'deployment_provider_failure';
          await deployments.markFailed(deploymentId, { category, message: deployed.message });
          return { ok: false, runId: claimed.runId, deploymentId, category, message: deployed.message, retryable: deployed.retryable };
        }
        logger.info('deployment: reconciled an ambiguous deploy() failure as an actual success', { deploymentId: deploymentId.toHexString() });
      }

      await audit.append({
        actor: DEPLOYMENT_SERVICE_ACTOR,
        action: 'deployment.validation.started',
        subjectType: 'deployment',
        subjectId: deploymentId,
        detail: { runId: claimed.runId.toHexString() },
      });

      const validation = await validator.validate(request, deploymentIdentifier);
      const validationOk = isPostDeploymentValidationSuccessful(validation);

      await audit.append({
        actor: DEPLOYMENT_SERVICE_ACTOR,
        action: validationOk ? 'deployment.validation.completed' : 'deployment.validation.failed',
        subjectType: 'deployment',
        subjectId: deploymentId,
        detail: { runId: claimed.runId.toHexString(), healthOk: validation.health.ok, readinessOk: validation.readiness.ok },
      });

      // The deployment itself succeeded regardless of validation outcome —
      // recorded as `succeeded` either way (Section 14). No rollback.
      await deployments.markSucceeded(deploymentId, { provider: providerName, target, deploymentIdentifier, validation });

      if (!validationOk) {
        return {
          ok: false,
          runId: claimed.runId,
          deploymentId,
          category: 'validation_failed',
          message: 'deployment succeeded but post-deployment validation failed',
          retryable: false,
        };
      }

      return { ok: true, runId: claimed.runId, deploymentId, deploymentIdentifier, validation };
    },
  };
}
