/**
 * The deployment provider abstraction — the same "interface, mock, real"
 * split this codebase has used at every external boundary
 * (`GitHubAppClient`/`mock-client.ts`/`real-client.ts`,
 * `CodingAgentProvider`, `ChangeValidationRunner`).
 *
 * MOCK ONLY, THIS PHASE, DELIBERATELY. This repository has no established
 * production deployment mechanism — no Dockerfile, no CI/CD workflow, no
 * cloud-platform configuration anywhere in it (verified before writing
 * this module). Inventing one now would mean guessing at infrastructure
 * this project has never adopted, exactly what this phase was told not to
 * do. `createMockDeploymentProvider` is the only implementation; real
 * deployment stays disabled until a real mechanism is established AND
 * explicitly configured — see docs/deployment.md's "Current limitations".
 *
 * NEVER RECEIVES UNNECESSARY SECRETS. `DeploymentRequest` carries
 * identifiers only (run/execution/publication ids, the merge commit sha,
 * owner/repo, a target name) — no GitHub token, no database credential, no
 * API key of any kind. A real provider would need its OWN deployment
 * credential, supplied to its constructor exactly the way
 * `RealGitHubAppClientOptions` supplies a private key — never threaded
 * through a `DeploymentRequest`.
 */

export interface DeploymentTarget {
  /** A human-readable environment name, e.g. 'staging', 'production'. Never a URL or credential. */
  readonly name: string;
}

export interface DeploymentRequest {
  readonly runId: string;
  readonly executionId: string;
  readonly publicationId: string;
  readonly owner: string;
  readonly repo: string;
  readonly mergeCommitSha: string;
  readonly target: DeploymentTarget;
  /**
   * Deterministic, CALLER-supplied — `deployment-service.ts` derives it
   * from the deployment row's own id, never from the provider. This is
   * what makes `getDeploymentStatus` usable for reconciliation after an
   * ambiguous `deploy()` failure (a timeout, say): the caller already
   * knows the identifier to ask about, even though the `deploy()` response
   * that would have told it directly never arrived — the same reason
   * `github-publish/`'s branch name is deterministic rather than
   * provider-assigned.
   */
  readonly deploymentIdentifier: string;
}

export type ValidateDeploymentResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

export type DeployOutcome = { readonly ok: true } | { readonly ok: false; readonly message: string; readonly retryable: boolean };

export type DeploymentProviderStatus = 'running' | 'succeeded' | 'failed' | 'unknown';

export interface GetDeploymentStatusResult {
  readonly status: DeploymentProviderStatus;
  readonly message?: string;
}

/**
 * A provider never merges anything, never touches GitHub, and never
 * receives a GitHub or database credential — see the module comment.
 */
export interface DeploymentProvider {
  /** Checked before `deploy()` — configuration/target validity, never a network deployment attempt. */
  validateDeployment(request: DeploymentRequest): Promise<ValidateDeploymentResult>;
  deploy(request: DeploymentRequest): Promise<DeployOutcome>;
  /** Reconciliation: "did this deployment actually complete?" — used after an ambiguous (timed-out) `deploy()` call, the same reconciliation-before-retry discipline `github-publish/publish-service.ts` already established for `createBranch`/`createPullRequest`. */
  getDeploymentStatus(deploymentIdentifier: string): Promise<GetDeploymentStatusResult>;
}

export interface MockDeploymentProviderConfig {
  readonly validateResult?: ValidateDeploymentResult;
  readonly deployResult?: DeployOutcome;
  readonly statusResult?: GetDeploymentStatusResult;
}

/**
 * Deterministic, in-memory, offline — the only implementation any test (or,
 * currently, any running instance) uses. Tracks which identifiers it has
 * actually "deployed" internally, so `getDeploymentStatus` can genuinely
 * reconcile an ambiguous `deploy()` failure in a test (`config.deployResult`
 * simulates a lost response; the deployment still lands in this internal
 * set) rather than always answering from a fixed override.
 */
export function createMockDeploymentProvider(config: MockDeploymentProviderConfig = {}): DeploymentProvider {
  const deployed = new Set<string>();
  return {
    async validateDeployment(): Promise<ValidateDeploymentResult> {
      return config.validateResult ?? { ok: true };
    },
    async deploy(request: DeploymentRequest): Promise<DeployOutcome> {
      deployed.add(request.deploymentIdentifier);
      if (config.deployResult !== undefined) return config.deployResult;
      return { ok: true };
    },
    async getDeploymentStatus(deploymentIdentifier: string): Promise<GetDeploymentStatusResult> {
      if (config.statusResult !== undefined) return config.statusResult;
      return { status: deployed.has(deploymentIdentifier) ? 'succeeded' : 'unknown' };
    },
  };
}
