/**
 * GitHub App client — interfaces and shared types only.
 *
 * Stage 1 of docs/github-app-integration-design.md: no real implementation
 * exists here, and none is added by this module. `mock-client.ts` is the
 * only implementation in this phase. A real, fetch-based implementation
 * (JWT signing, the actual `api.github.com` calls) is a later stage, gated
 * behind explicit configuration exactly like the Neutara and OpenAI
 * integrations already are — see the design doc's staged plan.
 *
 * Every method returns a Result rather than throwing, mirroring
 * neutara/client.ts's `FetchIssueResult`/`isRetryable` shape: a GitHub call
 * failing in an expected way (not found, rate limited, insufficient
 * permission) is a normal outcome for a network client to report, not an
 * exceptional one for it to throw.
 *
 * WRITE OPERATIONS (docs/change-execution.md's next phase: GitHub Write +
 * Pull Request Workflow). Six methods below (`getRef` through
 * `findPullRequestForBranch`) are the ONLY write-capable additions to this
 * interface — deliberately the minimal set the Git Data API needs for "one
 * branch, one commit, one PR" per approved execution: `getRef`/`getCommit`
 * read the base branch's current state; `createTree`/`createCommit` build
 * a single new commit off of it (git objects with no ref pointing at them
 * are simply unreachable garbage if abandoned — safe to retry blindly,
 * unlike the next two); `createBranch` is the one call that actually
 * publishes anything (equivalent to `git push` for a brand-new branch —
 * there is no separate "push" primitive in the REST API); `createPullRequest`
 * and its `findPullRequestForBranch` reconciliation counterpart open the
 * PR. No method here can modify or delete an EXISTING branch, and nothing
 * in this codebase ever calls one with a protected/base branch name — see
 * `github-publish/publish-service.ts`.
 *
 * PR MERGE DETECTION (deployment/pr-merge-detection.ts). `getPullRequest`
 * is the one further addition, and it is READ-ONLY — it reports whether a
 * PR has been merged (and by what commit), it never merges one. There is
 * no `mergePullRequest`, `approvePullRequest`, or `autoMerge` method
 * anywhere in this interface, deliberately: a human merges through
 * GitHub's own UI, and this client can only ever observe that afterwards.
 */

/**
 * Every way a GitHub App operation can fail, classified once so callers
 * never have to re-derive "should I retry this?" from an HTTP status code.
 *
 * The first five are OUR OWN authorization checks — they never reach a
 * GitHub API call at all, which is exactly the point: an unsupported URL,
 * an inactive registry entry, a disallowed branch, or a malformed
 * installation configuration is refused before any network request is
 * made, the same "verify before doing unauthorized work" discipline
 * operator-auth.ts already applies to the HTTP layer.
 *
 * The rest are what GitHub itself reports.
 */
export type GitHubAccessFailureKind =
  /** The selection has not been human-confirmed yet — decision D2 is never bypassed here. */
  | 'selection_not_confirmed'
  /** The snapshotted repositoryUrl is not a well-formed https://github.com/<org>/<repo> URL. */
  | 'unsupported_repository_url'
  /** The registry entry backing this selection is not (or is no longer) `active`. */
  | 'repository_inactive'
  /** The registry entry's `accessPolicy` has no usable installation id. */
  | 'invalid_installation_configuration'
  /** The requested branch is not covered by the confirmed selection's allowed branches. */
  | 'branch_not_allowed'
  /** GitHub: the App is not installed on this repository, or the installation id is unknown to it. */
  | 'installation_not_found'
  /** GitHub: the ref does not exist on the remote repository. */
  | 'branch_not_found'
  /** GitHub: the path does not exist at the given ref. */
  | 'file_not_found'
  /** GitHub: the credential itself (App JWT or installation token) was rejected (401) — distinct from `insufficient_permission`, which means the credential is valid but lacks a specific permission. */
  | 'authentication_failed'
  /** GitHub: the credential is valid but the installation lacks a permission the operation needs (403, no rate-limit evidence). */
  | 'insufficient_permission'
  /** GitHub: rate limited (primary or secondary). Worth retrying after `retryAfterMs`. */
  | 'rate_limited'
  /** The request did not complete within the configured timeout. Worth retrying — distinct from `transient` so a caller can tell "GitHub was slow" from "GitHub was unreachable/errored". */
  | 'timeout'
  /** GitHub: a transport failure (not a timeout) or a 5xx. Worth retrying with backoff. */
  | 'transient'
  /** The response was not the shape a caller requires. Retrying will not help — mirrors neutara/client.ts's 'malformed'. */
  | 'malformed'
  /** GitHub responded with a redirect (e.g. a renamed repository). Never followed — see real-client.ts. */
  | 'unexpected_redirect'
  /** GitHub: a ref with this exact name already exists (422) — `createBranch` never overwrites an existing ref. */
  | 'ref_already_exists'
  /** GitHub: a pull request already exists for this exact head/base pair (422). */
  | 'pull_request_already_exists';

/** Whether another attempt could plausibly succeed. Only true for conditions GitHub itself calls transient. */
export function isRetryable(kind: GitHubAccessFailureKind): boolean {
  return kind === 'rate_limited' || kind === 'transient' || kind === 'timeout';
}

export interface GitHubAccessFailure {
  readonly ok: false;
  readonly kind: GitHubAccessFailureKind;
  /** Safe for logs: never carries a token, a private key, or any other secret. */
  readonly message: string;
  /** Only meaningful when `kind === 'rate_limited'`. */
  readonly retryAfterMs?: number;
}

export type ResolveInstallationResult =
  | { readonly ok: true; readonly installationId: number }
  | GitHubAccessFailure;

export interface GitHubInstallationToken {
  /** Never logged, never persisted — see the module comment above. */
  readonly token: string;
  readonly expiresAt: Date;
}

export type IssueInstallationTokenResult = ({ readonly ok: true } & GitHubInstallationToken) | GitHubAccessFailure;

export interface GitHubRepositoryMetadata {
  readonly owner: string;
  readonly repo: string;
  readonly defaultBranch: string;
  readonly visibility: 'public' | 'private' | 'internal';
}

export type GetRepositoryMetadataResult =
  | { readonly ok: true; readonly metadata: GitHubRepositoryMetadata }
  | GitHubAccessFailure;

export type GetFileContentsResult = { readonly ok: true; readonly content: string } | GitHubAccessFailure;

/** The current commit SHA a branch (ref) points at. */
export type GetRefResult = { readonly ok: true; readonly sha: string } | GitHubAccessFailure;

/** A commit's tree SHA — the base a new tree is built on top of. */
export type GetCommitResult = { readonly ok: true; readonly treeSha: string } | GitHubAccessFailure;

/** One file's full new content, to be written into a new tree. Never a diff/patch — the complete file, matching `ProposedChange.proposedContent`. */
export interface TreeFileEntry {
  readonly path: string;
  readonly content: string;
}

export type CreateTreeResult = { readonly ok: true; readonly sha: string } | GitHubAccessFailure;

export type CreateCommitResult = { readonly ok: true; readonly sha: string } | GitHubAccessFailure;

export type CreateBranchResult = { readonly ok: true } | GitHubAccessFailure;

export interface GitHubPullRequestSummary {
  readonly number: number;
  readonly htmlUrl: string;
  readonly state: string;
}

export type CreatePullRequestResult = ({ readonly ok: true } & GitHubPullRequestSummary) | GitHubAccessFailure;

/** Null when no open pull request exists for this exact head/base pair — not a failure. */
export type FindPullRequestResult =
  | { readonly ok: true; readonly pullRequest: GitHubPullRequestSummary | null }
  | GitHubAccessFailure;

/**
 * Everything PR-merge detection needs to know, and nothing else. `merged`
 * is GitHub's own boolean, never inferred from `state` alone — a `closed`
 * PR is not necessarily a merged one, and this client never guesses.
 * `mergeCommitSha` is null until `merged` is true.
 */
export interface GitHubPullRequestDetails {
  readonly number: number;
  readonly htmlUrl: string;
  /** 'open' | 'closed' — exactly what GitHub reports. */
  readonly state: string;
  readonly merged: boolean;
  readonly mergeCommitSha: string | null;
  readonly headRef: string;
  readonly baseRef: string;
}

export type GetPullRequestResult = ({ readonly ok: true } & GitHubPullRequestDetails) | GitHubAccessFailure;

/** One file (a git blob) in a repository tree. Directories are not listed — only the files in them. */
export interface GitHubTreeFile {
  readonly path: string;
  /** Bytes, as GitHub reports it. */
  readonly size: number;
}

/**
 * `truncated` is GitHub's own flag: a very large repository's recursive
 * tree is cut off by GitHub, and the caller must know the list is partial
 * rather than assume it is complete.
 */
export type GetTreeResult =
  | { readonly ok: true; readonly files: readonly GitHubTreeFile[]; readonly truncated: boolean }
  | GitHubAccessFailure;

/**
 * The full surface Stage 1 needs, plus the minimal Git Data API write
 * surface added for the GitHub Write + Pull Request Workflow phase — see
 * the module comment above. A real implementation would additionally hold
 * the App id and private key (see token-issuer.ts in the design doc);
 * neither belongs on this interface, which describes only what a caller —
 * the future run-execution worker — needs to be able to do.
 */
export interface GitHubAppClient {
  /** Resolves which installation, if any, covers `owner/repo`. */
  resolveInstallation(owner: string, repo: string): Promise<ResolveInstallationResult>;
  /** Exchanges an installation id for a short-lived, scoped access token. */
  getInstallationToken(installationId: number): Promise<IssueInstallationTokenResult>;
  /** Repository-level metadata, e.g. to confirm the default branch matches what the registry recorded. */
  getRepositoryMetadata(
    installationId: number,
    owner: string,
    repo: string,
  ): Promise<GetRepositoryMetadataResult>;
  /** Reads one file's content at `ref`. */
  getFileContents(
    installationId: number,
    owner: string,
    repo: string,
    path: string,
    ref: string,
  ): Promise<GetFileContentsResult>;

  /** The current commit SHA `branch` points at. Also how a caller checks whether a branch exists at all. */
  getRef(installationId: number, owner: string, repo: string, branch: string): Promise<GetRefResult>;
  /** A commit's tree SHA — needed as `createTree`'s base. */
  getCommit(installationId: number, owner: string, repo: string, sha: string): Promise<GetCommitResult>;
  /** Every file under `treeSha`, recursively — names and sizes only, never content. Read-only. */
  getTree(installationId: number, owner: string, repo: string, treeSha: string): Promise<GetTreeResult>;
  /** Builds a new tree on top of `baseTreeSha`, replacing/adding exactly `files`. Creates no ref — the resulting tree is unreachable until a commit and a ref both point at it. */
  createTree(
    installationId: number,
    owner: string,
    repo: string,
    baseTreeSha: string,
    files: readonly TreeFileEntry[],
  ): Promise<CreateTreeResult>;
  /** Creates a commit object. Creates no ref — see `createTree`'s comment; the same applies here. */
  createCommit(
    installationId: number,
    owner: string,
    repo: string,
    message: string,
    treeSha: string,
    parentShas: readonly string[],
  ): Promise<CreateCommitResult>;
  /**
   * Creates a NEW branch (`refs/heads/<branch>`) pointing at `sha` — the
   * one call in this interface with an externally visible, non-idempotent
   * side effect (the git-push equivalent). Fails with `ref_already_exists`
   * rather than overwriting an existing ref of the same name.
   */
  createBranch(installationId: number, owner: string, repo: string, branch: string, sha: string): Promise<CreateBranchResult>;
  /** Opens a pull request from `head` into `base`. Fails with `pull_request_already_exists` if one is already open for this exact pair — see `findPullRequestForBranch` for recovering it instead of retrying. */
  createPullRequest(
    installationId: number,
    owner: string,
    repo: string,
    input: { readonly title: string; readonly body: string; readonly head: string; readonly base: string },
  ): Promise<CreatePullRequestResult>;
  /** Reconciliation lookup: does an open pull request already exist for this exact head/base pair? Used to recover from an ambiguous (timed-out) `createPullRequest` call rather than blindly retrying it. */
  findPullRequestForBranch(
    installationId: number,
    owner: string,
    repo: string,
    head: string,
    base: string,
  ): Promise<FindPullRequestResult>;
  /** Full PR details, by number — the one merge-detection needs `merged`/`mergeCommitSha` for. Read-only; see the module comment above. */
  getPullRequest(installationId: number, owner: string, repo: string, number: number): Promise<GetPullRequestResult>;
}
