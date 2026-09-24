/**
 * Post-deployment validation — reuses this service's OWN existing health
 * model (`api/health.ts`'s liveness/readiness contract), rather than
 * inventing a new one.
 *
 * This service already defines exactly what "is a deployed instance
 * healthy" means: `GET /health` (liveness — the process is up) and
 * `GET /health/ready` (readiness — it can actually serve, reflecting live
 * dependency state) — see `api/health.ts`. A real implementation of this
 * validator would issue those same two GET requests against the newly
 * deployed target's base URL and interpret the EXACT `HealthResponse`/
 * `ReadinessResponse` shapes that module already defines — no new
 * health-check contract to invent. `createMockPostDeploymentValidator` is
 * the only implementation this phase ships (see deployment-provider.ts's
 * module comment for why real deployment, and therefore a real target to
 * probe, does not exist yet).
 */

import type { PostDeploymentValidationSummary } from './types.ts';
import type { DeploymentRequest } from './deployment-provider.ts';

export interface PostDeploymentValidator {
  validate(request: DeploymentRequest, deploymentIdentifier: string): Promise<PostDeploymentValidationSummary>;
}

export interface MockPostDeploymentValidatorConfig {
  readonly health?: boolean;
  readonly readiness?: boolean;
}

function step(ok: boolean, name: string): { ok: boolean; summary: string } {
  return { ok, summary: ok ? `mock: ${name} passed` : `mock: ${name} failed` };
}

/** Deterministic and offline. Defaults to both checks passing; a test overrides exactly the one it needs to fail. */
export function createMockPostDeploymentValidator(config: MockPostDeploymentValidatorConfig = {}): PostDeploymentValidator {
  return {
    async validate(): Promise<PostDeploymentValidationSummary> {
      return {
        health: step(config.health ?? true, 'health'),
        readiness: step(config.readiness ?? true, 'readiness'),
      };
    },
  };
}
