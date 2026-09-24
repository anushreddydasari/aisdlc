/**
 * In-memory GitHubAppClient — the only implementation that exists in Stage
 * 1. Makes no network call of any kind. Every "repository" it knows about
 * is declared up front by the caller (a test, or later a local script
 * mirroring src/scripts/mock-neutara.ts); nothing is invented on the fly.
 *
 * Tokens issued here are obviously fake (`mock-token-...`) and are safe to
 * appear in test assertions — they are never mistaken for a real GitHub
 * token because they are never sent anywhere.
 *
 * WRITE STATE. Each declared repository starts with one synthetic "genesis"
 * commit (tree = its declared `files`) that every declared branch points
 * at — the same repo-wide, ref-independent `files` model the read side
 * already used. From there, `createTree`/`createCommit`/`createBranch`
 * behave like the real Git object model: a tree or commit with no ref
 * pointing at it is simply unreachable, and `createBranch` refuses to
 * overwrite an existing ref (`ref_already_exists`), mirroring GitHub's own
 * 422. This is realistic enough to exercise `github-publish/`'s
 * happy-path and idempotency logic; per-call failure injection for write
 * methods is deliberately NOT built in here — `github-publish/`'s own
 * tests fake `GitHubAppClient` directly for that, the same way
 * `github-access/service.test.ts` fakes `GitHubAccessService` directly
 * rather than routing failure scenarios through a shared stateful mock.
 */

import type {
  CreateBranchResult,
  CreateCommitResult,
  CreatePullRequestResult,
  CreateTreeResult,
  FindPullRequestResult,
  GetCommitResult,
  GetTreeResult,
  GetFileContentsResult,
  GetPullRequestResult,
  GetRefResult,
  GetRepositoryMetadataResult,
  GitHubAccessFailureKind,
  GitHubAppClient,
  GitHubPullRequestSummary,
  GitHubRepositoryMetadata,
  IssueInstallationTokenResult,
  ResolveInstallationResult,
  TreeFileEntry,
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
  /**
   * Pull requests that already exist on this mocked remote when the client
   * is constructed — declarative, the same "state of the world as already
   * observed" model `branches`/`files` already use. This is how a test
   * simulates a human having already merged (or closed) a PR: by seeding
   * that outcome as PRE-EXISTING state, never by calling a "merge" method
   * on the client — no such method exists, deliberately (see client.ts's
   * module comment).
   */
  readonly pullRequests?: readonly MockPullRequestSeed[];
}

export interface MockPullRequestSeed {
  readonly number: number;
  readonly head: string;
  readonly base: string;
  readonly state: 'open' | 'closed';
  readonly merged?: boolean;
  readonly mergeCommitSha?: string;
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

interface MockCommit {
  readonly treeSha: string;
  readonly message: string;
  readonly parentShas: readonly string[];
}

interface MockPullRequest extends GitHubPullRequestSummary {
  readonly head: string;
  readonly base: string;
  readonly merged: boolean;
  readonly mergeCommitSha: string | null;
}

interface MockWriteState {
  /** branch name -> current commit sha. */
  readonly refs: Map<string, string>;
  readonly commits: Map<string, MockCommit>;
  /** tree sha -> full path->content snapshot (not a diff). */
  readonly trees: Map<string, Map<string, string>>;
  readonly pullRequests: MockPullRequest[];
  seq: number;
}

/** One genesis commit (tree = the repository's declared `files`) that every declared branch starts pointing at. */
function initialWriteState(repo: MockRepository): MockWriteState {
  const genesisTreeSha = `mock-tree-genesis-${repo.owner}-${repo.repo}`;
  const genesisCommitSha = `mock-commit-genesis-${repo.owner}-${repo.repo}`;
  const trees = new Map<string, Map<string, string>>();
  trees.set(genesisTreeSha, new Map(Object.entries(repo.files ?? {})));
  const commits = new Map<string, MockCommit>();
  commits.set(genesisCommitSha, { treeSha: genesisTreeSha, message: 'genesis', parentShas: [] });
  const refs = new Map<string, string>();
  for (const branch of repo.branches) refs.set(branch, genesisCommitSha);

  const pullRequests: MockPullRequest[] = (repo.pullRequests ?? []).map((seed) => ({
    number: seed.number,
    htmlUrl: `https://github.com/${repo.owner}/${repo.repo}/pull/${seed.number}`,
    state: seed.state,
    head: seed.head,
    base: seed.base,
    merged: seed.merged ?? false,
    mergeCommitSha: seed.mergeCommitSha ?? null,
  }));

  return { refs, commits, trees, pullRequests, seq: 0 };
}

export function createMockGitHubAppClient(config: MockGitHubAppClientConfig = {}): GitHubAppClient {
  const repositories = config.repositories ?? [];
  const tokenFailures = config.tokenFailures ?? {};
  const retryAfterMs = config.retryAfterMs ?? {};
  const now = config.now ?? (() => new Date());
  let tokenSequence = 0;

  // Only ever called after the caller has already confirmed `installationId`
  // resolves to a known repository (the same `findRepository`/`installationId`
  // match every read method below performs first) — the non-null assertion
  // reflects that established invariant, not an assumption made here.
  const writeStates = new Map<number, MockWriteState>();
  function stateFor(installationId: number): MockWriteState {
    let state = writeStates.get(installationId);
    if (state === undefined) {
      state = initialWriteState(findRepositoryByInstallation(repositories, installationId)!);
      writeStates.set(installationId, state);
    }
    return state;
  }

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
      // Reads from the WRITE STATE, not the static declared config — so
      // content published via createTree/createCommit/createBranch is
      // actually visible again through this same read path, on the branch
      // it was published to, without ever touching any other branch's
      // (including the base's) own tree.
      const state = stateFor(installationId);
      const sha = state.refs.get(ref);
      if (sha === undefined) {
        return {
          ok: false,
          kind: 'branch_not_found',
          message: `ref '${ref}' does not exist on ${owner}/${repo}`,
        };
      }
      const commit = state.commits.get(sha);
      const tree = commit === undefined ? undefined : state.trees.get(commit.treeSha);
      const content = tree?.get(path);
      if (content === undefined) {
        return {
          ok: false,
          kind: 'file_not_found',
          message: `'${path}' does not exist on ${owner}/${repo}@${ref}`,
        };
      }
      return { ok: true, content };
    },

    async getRef(installationId: number, owner: string, repo: string, branch: string): Promise<GetRefResult> {
      const found = findRepository(repositories, owner, repo);
      if (found === undefined || found.installationId !== installationId) {
        return { ok: false, kind: 'installation_not_found', message: `installation ${installationId} does not cover ${owner}/${repo}` };
      }
      const sha = stateFor(installationId).refs.get(branch);
      if (sha === undefined) {
        return { ok: false, kind: 'branch_not_found', message: `ref '${branch}' does not exist on ${owner}/${repo}` };
      }
      return { ok: true, sha };
    },

    async getCommit(installationId: number, owner: string, repo: string, sha: string): Promise<GetCommitResult> {
      const found = findRepository(repositories, owner, repo);
      if (found === undefined || found.installationId !== installationId) {
        return { ok: false, kind: 'installation_not_found', message: `installation ${installationId} does not cover ${owner}/${repo}` };
      }
      const commit = stateFor(installationId).commits.get(sha);
      if (commit === undefined) {
        return { ok: false, kind: 'malformed', message: `commit '${sha}' does not exist on ${owner}/${repo}` };
      }
      return { ok: true, treeSha: commit.treeSha };
    },

    async getTree(installationId: number, owner: string, repo: string, treeSha: string): Promise<GetTreeResult> {
      const found = findRepository(repositories, owner, repo);
      if (found === undefined || found.installationId !== installationId) {
        return { ok: false, kind: 'installation_not_found', message: `installation ${installationId} does not cover ${owner}/${repo}` };
      }
      const tree = stateFor(installationId).trees.get(treeSha);
      if (tree === undefined) {
        return { ok: false, kind: 'malformed', message: `tree '${treeSha}' does not exist on ${owner}/${repo}` };
      }
      const files = [...tree.entries()]
        .map(([path, content]) => ({ path, size: Buffer.byteLength(content, 'utf8') }))
        .sort((a, b) => a.path.localeCompare(b.path));
      return { ok: true, files, truncated: false };
    },

    async createTree(
      installationId: number,
      owner: string,
      repo: string,
      baseTreeSha: string,
      files: readonly TreeFileEntry[],
    ): Promise<CreateTreeResult> {
      const found = findRepository(repositories, owner, repo);
      if (found === undefined || found.installationId !== installationId) {
        return { ok: false, kind: 'installation_not_found', message: `installation ${installationId} does not cover ${owner}/${repo}` };
      }
      const state = stateFor(installationId);
      const baseTree = state.trees.get(baseTreeSha);
      if (baseTree === undefined) {
        return { ok: false, kind: 'malformed', message: `base tree '${baseTreeSha}' does not exist on ${owner}/${repo}` };
      }
      const newTree = new Map(baseTree);
      for (const file of files) newTree.set(file.path, file.content);
      state.seq += 1;
      const sha = `mock-tree-${owner}-${repo}-${state.seq}`;
      state.trees.set(sha, newTree);
      return { ok: true, sha };
    },

    async createCommit(
      installationId: number,
      owner: string,
      repo: string,
      message: string,
      treeSha: string,
      parentShas: readonly string[],
    ): Promise<CreateCommitResult> {
      const found = findRepository(repositories, owner, repo);
      if (found === undefined || found.installationId !== installationId) {
        return { ok: false, kind: 'installation_not_found', message: `installation ${installationId} does not cover ${owner}/${repo}` };
      }
      const state = stateFor(installationId);
      if (!state.trees.has(treeSha)) {
        return { ok: false, kind: 'malformed', message: `tree '${treeSha}' does not exist on ${owner}/${repo}` };
      }
      state.seq += 1;
      const sha = `mock-commit-${owner}-${repo}-${state.seq}`;
      state.commits.set(sha, { treeSha, message, parentShas: [...parentShas] });
      return { ok: true, sha };
    },

    async createBranch(installationId: number, owner: string, repo: string, branch: string, sha: string): Promise<CreateBranchResult> {
      const found = findRepository(repositories, owner, repo);
      if (found === undefined || found.installationId !== installationId) {
        return { ok: false, kind: 'installation_not_found', message: `installation ${installationId} does not cover ${owner}/${repo}` };
      }
      const state = stateFor(installationId);
      if (state.refs.has(branch)) {
        return { ok: false, kind: 'ref_already_exists', message: `branch '${branch}' already exists on ${owner}/${repo}` };
      }
      if (!state.commits.has(sha)) {
        return { ok: false, kind: 'malformed', message: `commit '${sha}' does not exist on ${owner}/${repo}` };
      }
      state.refs.set(branch, sha);
      return { ok: true };
    },

    async createPullRequest(
      installationId: number,
      owner: string,
      repo: string,
      input: { readonly title: string; readonly body: string; readonly head: string; readonly base: string },
    ): Promise<CreatePullRequestResult> {
      const found = findRepository(repositories, owner, repo);
      if (found === undefined || found.installationId !== installationId) {
        return { ok: false, kind: 'installation_not_found', message: `installation ${installationId} does not cover ${owner}/${repo}` };
      }
      const state = stateFor(installationId);
      const existing = state.pullRequests.find((pr) => pr.head === input.head && pr.base === input.base && pr.state === 'open');
      if (existing !== undefined) {
        return {
          ok: false,
          kind: 'pull_request_already_exists',
          message: `a pull request already exists for ${input.head} -> ${input.base} on ${owner}/${repo}`,
        };
      }
      state.seq += 1;
      const pullRequest: MockPullRequest = {
        number: state.seq,
        htmlUrl: `https://github.com/${owner}/${repo}/pull/${state.seq}`,
        state: 'open',
        head: input.head,
        base: input.base,
        merged: false,
        mergeCommitSha: null,
      };
      state.pullRequests.push(pullRequest);
      return { ok: true, number: pullRequest.number, htmlUrl: pullRequest.htmlUrl, state: pullRequest.state };
    },

    async findPullRequestForBranch(
      installationId: number,
      owner: string,
      repo: string,
      head: string,
      base: string,
    ): Promise<FindPullRequestResult> {
      const found = findRepository(repositories, owner, repo);
      if (found === undefined || found.installationId !== installationId) {
        return { ok: false, kind: 'installation_not_found', message: `installation ${installationId} does not cover ${owner}/${repo}` };
      }
      const state = stateFor(installationId);
      const existing = state.pullRequests.find((pr) => pr.head === head && pr.base === base && pr.state === 'open');
      if (existing === undefined) return { ok: true, pullRequest: null };
      return { ok: true, pullRequest: { number: existing.number, htmlUrl: existing.htmlUrl, state: existing.state } };
    },

    async getPullRequest(installationId: number, owner: string, repo: string, number: number): Promise<GetPullRequestResult> {
      const found = findRepository(repositories, owner, repo);
      if (found === undefined || found.installationId !== installationId) {
        return { ok: false, kind: 'installation_not_found', message: `installation ${installationId} does not cover ${owner}/${repo}` };
      }
      const state = stateFor(installationId);
      const pr = state.pullRequests.find((p) => p.number === number);
      if (pr === undefined) {
        return { ok: false, kind: 'file_not_found', message: `no pull request #${number} on ${owner}/${repo}` };
      }
      return {
        ok: true,
        number: pr.number,
        htmlUrl: pr.htmlUrl,
        state: pr.state,
        merged: pr.merged,
        mergeCommitSha: pr.mergeCommitSha,
        headRef: pr.head,
        baseRef: pr.base,
      };
    },
  };
}
