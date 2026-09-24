/**
 * Human PR Merge → Deployment → Post-Deployment Validation — shared result
 * models and failure taxonomy.
 *
 * PR Created → Human Reviews → Human Merges → AISDLC Detects Merge →
 * Deployment Eligibility → Deployment → Post-Deployment Validation.
 *
 * IMPORTANT SAFETY RULE, again: nothing in this module — or anywhere in
 * `deployment/` — merges a pull request. `pr-merge-detection.ts` only ever
 * reads (`GitHubAppClient.getPullRequest`, read-only). The workflow this
 * module drives begins strictly AFTER a human has already merged, and it
 * begins by detecting that fact, never causing it.
 */

import type { ObjectId } from 'mongodb';

/**
 * Every way PR-merge detection or deployment can fail, classified once —
 * the same discipline `ExecutionFailureCategory` and `PublishFailureCategory`
 * already established.
 */
export type DeploymentFailureCategory =
  // Eligibility (unpersisted — see deployment-service.ts's module comment)
  | 'not_eligible'
  | 'configuration_invalid'
  | 'pr_access_failure'
  | 'pr_identity_mismatch'
  | 'conflict'
  // Attempt (persisted)
  | 'deployment_provider_failure'
  | 'deployment_timeout'
  | 'deployment_rejected'
  | 'validation_failed'
  | 'validation_timeout'
  | 'already_deployed'
  | 'unexpected_error';

/** The DEFAULT retryability for a category with no more specific information — every category defaults to non-retryable; the handful backed by a live GitHub/provider call carry their own `retryable` explicitly. */
export function isRetryableDeploymentCategory(_category: DeploymentFailureCategory): boolean {
  return false;
}

export interface DeploymentValidationStepResult {
  readonly ok: boolean;
  /** Safe for logs and audit details: a short outcome summary, never full response bodies. */
  readonly summary: string;
}

export interface PostDeploymentValidationSummary {
  readonly health: DeploymentValidationStepResult;
  readonly readiness: DeploymentValidationStepResult;
}

export function isPostDeploymentValidationSuccessful(validation: PostDeploymentValidationSummary): boolean {
  return validation.health.ok && validation.readiness.ok;
}

export interface DeploymentSuccess {
  readonly ok: true;
  readonly runId: ObjectId;
  readonly deploymentId: ObjectId;
  readonly deploymentIdentifier: string;
  readonly validation: PostDeploymentValidationSummary;
}

export interface DeploymentFailure {
  readonly ok: false;
  readonly runId: ObjectId;
  readonly deploymentId: ObjectId | null;
  readonly category: DeploymentFailureCategory;
  /** Safe for logs and audit details: never a token, key, or credential. */
  readonly message: string;
  readonly retryable: boolean;
}

export type DeploymentResult = DeploymentSuccess | DeploymentFailure;
