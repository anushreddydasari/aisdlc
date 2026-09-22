/**
 * In-memory GitHubAppClient — the only implementation that exists in Stage
 * 1. Makes no network call of any kind. Every "repository" it knows about
 * is declared up front by the caller (a test, or later a local script
 * mirroring src/scripts/mock-neutara.ts); nothing is invented on the fly.
 *
 * Tokens issued here are obviously fake (`mock-token-...`) and are safe to
 * appear in test assertions — they are never mistaken for a real GitHub
 * token because they are never sent anywhere.
 */

import type {
  GetFileContentsResult,
  GetRepositoryMetadataResult,
  GitHubAccessFailureKind,
  GitHubAppClient,
  GitHubRepositoryMetadata,
  IssueInstallationTokenResult,
  ResolveInstallationResult,
} from './client.ts';

export interface MockRepository {
  readonly owner: string;
  readonly repo: string;
  readonly installationId: number;
  readonly defaultBranch: string;
  /** Branches that "exist" on this mocked remote. Must include `defaultBranch`. */
  readonly branches: readonly string[];
  readonly visibility?: 'public' | 'private' | 'internal';
  /** `false` models an installation with no `contents:read` permission on this repo. */
  readonly readable?: boolean;
  /** path -> content. A path absent here is reported as `file_not_found`. */
  readonly files?: Readonly<Record<string, string>>;
}

export interface MockGitHubAppClientConfig {
  readonly repositories?: readonly MockRepository[];
  /** Forces `getInstallationToken(installationId)` to fail with this kind instead of succeeding. */
  readonly tokenFailures?: Readonly<Record<number, GitHubAccessFailureKind>>;
  /** Only meaningful for a `rate_limited` entry in `tokenFailures`. */
  readonly retryAfterMs?: Readonly<Record<number, number>>;
  readonly now?: () => Date;
}

function findRepository(
  repositories: readonly MockRepository[],
  owner: string,
  repo: string,
): MockRepository | undefined {
  return repositories.find((r) => r.owner === owner && r.repo === repo);
}

function findRepositoryByInstallation(
  repositories: readonly MockRepository[],
  installationId: number,
): MockRepository | undefined {
  return repositories.find((r) => r.installationId === installationId);
}

export function createMockGitHubAppClient(config: MockGitHubAppClientConfig = {}): GitHubAppClient {
  const repositories = config.repositories ?? [];
  const tokenFailures = config.tokenFailures ?? {};
  const retryAfterMs = config.retryAfterMs ?? {};
  const now = config.now ?? (() => new Date());
  let tokenSequence = 0;

  return {
    async resolveInstallation(owner: string, repo: string): Promise<ResolveInstallationResult> {
      const found = findRepository(repositories, owner, repo);
      if (found === undefined) {
        return {
          ok: false,
          kind: 'installation_not_found',
          message: `no installation covers ${owner}/${repo}`,
        };
      }
      return { ok: true, installationId: found.installationId };
    },

    async getInstallationToken(installationId: number): Promise<IssueInstallationTokenResult> {
      const forcedFailure = tokenFailures[installationId];
      if (forcedFailure !== undefined) {
        return {
          ok: false,
          kind: forcedFailure,
          message: `mocked failure: ${forcedFailure}`,
          ...(forcedFailure === 'rate_limited' && retryAfterMs[installationId] !== undefined
            ? { retryAfterMs: retryAfterMs[installationId] }
            : {}),
        };
      }
      if (findRepositoryByInstallation(repositories, installationId) === undefined) {
        return {
          ok: false,
          kind: 'installation_not_found',
          message: `installation ${installationId} is not known`,
        };
      }

      tokenSequence += 1;
      const issuedAt = now();
      return {
        ok: true,
        // Obviously fake, never a real token shape — see the module comment.
        token: `mock-token-${installationId}-${tokenSequence}`,
        expiresAt: new Date(issuedAt.getTime() + 60 * 60_000),
      };
    },

    async getRepositoryMetadata(
      installationId: number,
      owner: string,
      repo: string,
    ): Promise<GetRepositoryMetadataResult> {
      const found = findRepository(repositories, owner, repo);
      if (found === undefined || found.installationId !== installationId) {
        return {
          ok: false,
          kind: 'installation_not_found',
          message: `installation ${installationId} does not cover ${owner}/${repo}`,
        };
      }
      const metadata: GitHubRepositoryMetadata = {
        owner: found.owner,
        repo: found.repo,
        defaultBranch: found.defaultBranch,
        visibility: found.visibility ?? 'private',
      };
      return { ok: true, metadata };
    },

    async getFileContents(
      installationId: number,
      owner: string,
      repo: string,
      path: string,
      ref: string,
    ): Promise<GetFileContentsResult> {
      const found = findRepository(repositories, owner, repo);
      if (found === undefined || found.installationId !== installationId) {
        return {
          ok: false,
          kind: 'installation_not_found',
          message: `installation ${installationId} does not cover ${owner}/${repo}`,
        };
      }
      if (found.readable === false) {
        return {
          ok: false,
          kind: 'insufficient_permission',
          message: `installation ${installationId} does not have contents:read on ${owner}/${repo}`,
        };
      }
      if (!found.branches.includes(ref)) {
        return {
          ok: false,
          kind: 'branch_not_found',
          message: `ref '${ref}' does not exist on ${owner}/${repo}`,
        };
      }
      const content = found.files?.[path];
      if (content === undefined) {
        return {
          ok: false,
          kind: 'file_not_found',
          message: `'${path}' does not exist on ${owner}/${repo}@${ref}`,
        };
      }
      return { ok: true, content };
    },
  };
}
