/**
 * Ties a CONFIRMED repository selection to a GitHub App access token.
 *
 * This is the only place in this phase that connects the two systems
 * described in docs/repository-selection.md and
 * docs/github-app-integration-design.md. It integrates purely through their
 * already-public contracts — `RepositoryRegistryRepository` and a
 * `RepositorySelectionDocument` — and adds no new collection, no new field,
 * and no new state to either. Nothing here can move a selection between
 * statuses; the human-confirmation workflow in
 * repository-selection/repository.ts is untouched and is not re-implemented
 * or bypassed by this module.
 *
 * Order of checks matters, mirroring approval.ts's "authenticate before
 * doing any work" discipline: every OUR-OWN authorization check (§5/§6/§8
 * of the design doc) runs and can refuse BEFORE any GitHubAppClient method
 * is ever called. A disallowed branch or an inactive repository therefore
 * never causes a GitHub API call (or, in this phase, a mock-client call) at
 * all — worth asserting directly in tests, not just trusting by inspection.
 */

import type { Logger } from '../logging/logger.ts';
import { isValidGitHubRepositoryUrl, matchesAllowedBranch, type RepositoryRegistryRepository } from '../repository-registry/repository.ts';
import type { RepositorySelectionDocument } from '../repository-selection/repository.ts';
import {
  isRetryable,
  type GetFileContentsResult,
  type GitHubAccessFailure,
  type GitHubAccessFailureKind,
  type GitHubAppClient,
} from './client.ts';
import { isValidInstallationId } from './config.ts';

export interface RepositoryAccessDeps {
  readonly registry: RepositoryRegistryRepository;
  readonly client: GitHubAppClient;
  readonly logger: Logger;
}

export interface AuthorizedRepositoryAccess {
  readonly ok: true;
  readonly installationId: number;
  /** Never logged as-is by this module — see the secret-safe-logging tests. */
  readonly token: string;
  readonly expiresAt: Date;
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
}

export type AuthorizeRepositoryAccessResult = AuthorizedRepositoryAccess | GitHubAccessFailure;

export interface RepositoryAccessOptions {
  /** Defaults to the confirmed selection's own default branch. */
  readonly branch?: string;
}

const GITHUB_URL_PATTERN = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

/** Only ever called after `isValidGitHubRepositoryUrl` has already accepted `url`. */
function parseOwnerAndRepo(url: string): { owner: string; repo: string } {
  const match = GITHUB_URL_PATTERN.exec(url.trim());
  if (match === null) {
    // Unreachable in practice: the URL was already validated by the same
    // pattern family at registry-creation time. Thrown rather than turned
    // into a Result, because this would be a bug in our own validator, not
    // an expected outcome for a caller to handle — see the design doc's
    // "§5 Registry-controlled repository URL validation".
    throw new Error(`failed to parse owner/repo from an already-validated GitHub URL: '${url}'`);
  }
  const [, owner, repo] = match;
  return { owner: owner!, repo: repo! };
}

function extractInstallationId(accessPolicy: Record<string, unknown> | null): number | null {
  if (accessPolicy === null) return null;
  const value = accessPolicy['installationId'];
  // Shared with config.ts, which validates the same shape for GITHUB_APP_ID-adjacent configuration.
  return isValidInstallationId(value) ? value : null;
}

function failure(kind: GitHubAccessFailureKind, message: string): GitHubAccessFailure {
  return { ok: false, kind, message };
}

/**
 * Authorizes access to the repository a confirmed selection names, and
 * returns a short-lived installation token for it. Every failure is a
 * `GitHubAccessFailure`, never a thrown exception — see client.ts's header
 * comment for why this mirrors `NeutaraClient`'s Result shape.
 */
export async function authorizeRepositoryAccess(
  deps: RepositoryAccessDeps,
  selection: RepositorySelectionDocument,
  options: RepositoryAccessOptions = {},
): Promise<AuthorizeRepositoryAccessResult> {
  const { registry, client, logger } = deps;
  const child = logger.child({ issueKey: selection.issueKey, runId: selection.runId.toHexString() });

  // Decision D2, re-asserted here rather than trusted from the caller: only
  // a human-confirmed selection may ever be used to obtain Git access.
  if (selection.status !== 'selected') {
    const result = failure('selection_not_confirmed', `selection is '${selection.status}', not confirmed`);
    child.warn('github access refused', { ...result });
    return result;
  }

  const repositoryUrl = selection.selectedRepositoryUrl;
  if (repositoryUrl === null || !isValidGitHubRepositoryUrl(repositoryUrl)) {
    const result = failure(
      'unsupported_repository_url',
      `'${repositoryUrl ?? '(none)'}' is not a supported GitHub repository URL`,
    );
    child.warn('github access refused', { ...result });
    return result;
  }
  const { owner, repo } = parseOwnerAndRepo(repositoryUrl);

  const branch = options.branch ?? selection.selectedDefaultBranch;
  if (branch === null || !matchesAllowedBranch(branch, selection.selectedAllowedBranches ?? [])) {
    const result = failure(
      'branch_not_allowed',
      `branch '${branch ?? '(none)'}' is not covered by this run's allowed branches`,
    );
    child.warn('github access refused', { ...result });
    return result;
  }

  // Re-checked against the CURRENT registry, not the confirmation-time
  // snapshot: a mapping deactivated after confirmation must never be used.
  // Identity (owner/repo) and authorized branches still come from the
  // snapshot above, never from this live read — see the module comment.
  const activeEntries = await registry.findActiveByProjectIdentifier(selection.projectIdentifier);
  const entry = activeEntries.find((e) => e.repositoryId === selection.selectedRepositoryId);
  if (entry === undefined) {
    const result = failure(
      'repository_inactive',
      `'${selection.selectedRepositoryId}' is not currently an active mapping for '${selection.projectIdentifier}'`,
    );
    child.warn('github access refused', { ...result });
    return result;
  }

  const installationId = extractInstallationId(entry.accessPolicy);
  if (installationId === null) {
    const result = failure(
      'invalid_installation_configuration',
      `registry entry '${entry.repositoryId}' has no usable installation id in accessPolicy`,
    );
    child.warn('github access refused', { ...result });
    return result;
  }

  const issued = await client.getInstallationToken(installationId);
  if (!issued.ok) {
    child.warn('github installation token request failed', {
      installationId,
      kind: issued.kind,
      retryable: isRetryable(issued.kind),
    });
    return issued;
  }

  child.info('github access authorized', {
    installationId,
    owner,
    repo,
    branch,
    expiresAt: issued.expiresAt,
  });
  return {
    ok: true,
    installationId,
    token: issued.token,
    expiresAt: issued.expiresAt,
    owner,
    repo,
    branch,
  };
}

/** Authorizes access, then reads one file. A thin composition — see authorizeRepositoryAccess for every failure mode. */
export async function readRepositoryFile(
  deps: RepositoryAccessDeps,
  selection: RepositorySelectionDocument,
  path: string,
  options: RepositoryAccessOptions = {},
): Promise<GetFileContentsResult> {
  const authorized = await authorizeRepositoryAccess(deps, selection, options);
  if (!authorized.ok) return authorized;
  return deps.client.getFileContents(authorized.installationId, authorized.owner, authorized.repo, path, authorized.branch);
}
