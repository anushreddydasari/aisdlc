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
  /** GitHub: the installation lacks a permission the operation needs. */
  | 'insufficient_permission'
  /** GitHub: rate limited (primary or secondary). Worth retrying after `retryAfterMs`. */
  | 'rate_limited'
  /** GitHub: a transport failure or 5xx. Worth retrying with backoff. */
  | 'transient'
  /** The response was not the shape a caller requires. Retrying will not help — mirrors neutara/client.ts's 'malformed'. */
  | 'malformed'
  /** GitHub responded with a redirect (e.g. a renamed repository). Never followed — see real-client.ts. */
  | 'unexpected_redirect';

/** Whether another attempt could plausibly succeed. Only true for conditions GitHub itself calls transient. */
export function isRetryable(kind: GitHubAccessFailureKind): boolean {
  return kind === 'rate_limited' || kind === 'transient';
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

/**
 * The full surface Stage 1 needs. A real implementation would additionally
 * hold the App id and private key (see token-issuer.ts in the design doc);
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
}
