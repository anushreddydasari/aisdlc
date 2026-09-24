/**
 * Real, HTTP-based `GitHubAppClient` — Stage 3.
 *
 * Composes two already-tested pieces rather than re-implementing them:
 * `signAppJwt` (jwt.ts) for the one App-level call (`resolveInstallation`,
 * which GitHub requires JWT auth for), and the injected `TokenIssuer`
 * (token-issuer.ts) for every repository-scoped call, which needs a
 * short-lived installation token, not the App JWT. Rate-limit
 * classification and the standard GitHub headers come from `http.ts`, the
 * same shared logic `token-issuer.ts` uses — see that module's header
 * comment for why duplicating this logic is exactly the mistake to avoid.
 *
 * This is a `GitHubAppClient` implementation — the same interface
 * `mock-client.ts` implements — so `access.ts` and anything built on top of
 * it works unchanged with either. Nothing in this file is wired into
 * `src/index.ts`; there is still no consumer that constructs a real
 * `TokenIssuer`+`createRealGitHubAppClient` pair, by design (Phase 6 of the
 * Stage 3 task explicitly excludes that).
 *
 * SECURITY, beyond what token-issuer.ts already established:
 *
 *   - Every request sets `redirect: 'error'`. GitHub's contents/metadata
 *     endpoints redirect on a renamed repository, and silently following
 *     that would mean acting on a DIFFERENT repository than the one the
 *     registry authorized. A redirect is refused, not followed.
 *   - `getRepositoryMetadata` verifies the response's own `owner.login`
 *     and `name` match what was REQUESTED, case-insensitively — the same
 *     "response identity must match request identity" defence
 *     `matchesRequestedIdentifier` already applies in neutara/client.ts.
 *   - Base64 file content is strictly validated before decoding (see
 *     `decodeBase64Content`), not passed through `Buffer.from` blindly,
 *     which silently drops invalid characters rather than reporting them.
 *   - Every failure is a `GitHubAccessFailure` Result, never a thrown
 *     exception, matching every other client in this codebase.
 */

import type { Logger } from '../logging/logger.ts';
import { signAppJwt } from './jwt.ts';
import type { TokenIssuer } from './token-issuer.ts';
import {
  classifyRateLimit,
  DEFAULT_GITHUB_API_BASE_URL,
  DEFAULT_REQUEST_TIMEOUT_MS,
  githubRequestHeaders,
  normalizeBaseUrl,
} from './http.ts';
import type {
  CreateBranchResult,
  CreateCommitResult,
  CreatePullRequestResult,
  CreateTreeResult,
  FindPullRequestResult,
  GetCommitResult,
  GetFileContentsResult,
  GetPullRequestResult,
  GetRefResult,
  GetRepositoryMetadataResult,
  GitHubAccessFailure,
  GitHubAccessFailureKind,
  GitHubAppClient,
  ResolveInstallationResult,
  TreeFileEntry,
} from './client.ts';

export interface RealGitHubAppClientOptions {
  readonly appId: number;
  /** PEM-format RSA private key. Never logged — see jwt.ts's module comment. */
  readonly privateKey: string;
  /** Issues and caches installation tokens for every repository-scoped call. */
  readonly tokenIssuer: TokenIssuer;
  readonly logger: Logger;
  readonly baseUrl?: string;
  /** Injectable so tests never reach the network. Defaults to the global `fetch`. */
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

function failure(kind: GitHubAccessFailureKind, message: string, retryAfterMs?: number): GitHubAccessFailure {
  return { ok: false, kind, message, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
}

/**
 * Strict base64: `Buffer.from(x, 'base64')` silently ignores characters
 * outside the alphabet rather than rejecting them, which would turn
 * "GitHub sent us garbage" into "we quietly returned partial garbage."
 * Empty string is valid (an empty file).
 */
const STRICT_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function decodeBase64Content(raw: string): string | null {
  const stripped = raw.replace(/[\r\n\s]/g, '');
  if (stripped !== '' && !STRICT_BASE64_PATTERN.test(stripped)) return null;
  return Buffer.from(stripped, 'base64').toString('utf8');
}

/** Encodes each path segment individually so `/` keeps separating them. Drops empty segments from a leading/trailing/doubled slash. */
function encodeContentsPath(path: string): string {
  return path
    .split('/')
    .filter((segment) => segment !== '')
    .map(encodeURIComponent)
    .join('/');
}

interface RawResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
}

export function createRealGitHubAppClient(options: RealGitHubAppClientOptions): GitHubAppClient {
  const { appId, privateKey, tokenIssuer, logger } = options;
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_GITHUB_API_BASE_URL);
  const doFetch = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());

  async function request(
    url: string,
    authorization: string,
    init: { readonly method?: string; readonly body?: unknown } = {},
  ): Promise<RawResponse | GitHubAccessFailure> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let response: Response;
      try {
        const headers = githubRequestHeaders(authorization);
        response = await doFetch(url, {
          method: init.method ?? 'GET',
          // The only place the JWT or installation token appears. Never
          // logged, never stored, never included in a failure message.
          headers: init.body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
          redirect: 'error',
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof TypeError && /redirect/i.test(error.message)) {
          return failure('unexpected_redirect', 'github responded with a redirect, which is never followed');
        }
        throw error;
      }

      const text = await response.text();
      let body: unknown;
      if (text !== '') {
        try {
          body = JSON.parse(text);
        } catch {
          return failure('malformed', 'response was not valid JSON');
        }
      }
      return { status: response.status, headers: response.headers, body };
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      logger.warn('github api request failed', { timedOut: aborted, error });
      return aborted
        ? failure('timeout', `request timed out after ${timeoutMs}ms`)
        : failure('transient', 'request failed');
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The 401/rate-limit/403/5xx/unexpected-status handling every method
   * shares. Deliberately excludes 404 — every caller needs its own 404
   * kind and message (and getFileContents needs to inspect the body to
   * pick between two different kinds), so each handles that status itself
   * before calling this. Also excludes 422 for the two write methods that
   * need it to mean something specific (`ref_already_exists`,
   * `pull_request_already_exists`) rather than a generic `malformed` —
   * every other caller falls through to the generic 422-is-malformed
   * handling here, since GitHub uses 422 for validation errors it has no
   * more specific kind for. Returns null when the caller must interpret a
   * success status itself; `okStatuses` defaults to `[200]` (every GET),
   * overridden by write methods that expect `201`.
   */
  function commonStatusFailure(result: RawResponse, okStatuses: readonly number[] = [200]): GitHubAccessFailure | null {
    if (result.status === 401) return failure('authentication_failed', 'github rejected the credential');

    const rateLimit = classifyRateLimit(result.status, result.headers, now());
    if (rateLimit.limited) {
      return failure('rate_limited', `github rate limited the request (status ${result.status})`, rateLimit.retryAfterMs);
    }
    if (result.status === 403) {
      return failure('insufficient_permission', 'github refused the request (403, not rate-limited)');
    }
    if (result.status >= 500) return failure('transient', `github returned ${result.status}`);
    if (okStatuses.includes(result.status)) return null;
    return failure('malformed', `github returned unexpected status ${result.status}`);
  }

  /** The `message` GitHub embeds in an error-response body, when present. */
  function responseErrorMessage(result: RawResponse): string | undefined {
    const body = typeof result.body === 'object' && result.body !== null ? (result.body as Record<string, unknown>) : null;
    const message = body?.['message'];
    return typeof message === 'string' ? message : undefined;
  }

  return {
    async resolveInstallation(owner: string, repo: string): Promise<ResolveInstallationResult> {
      const jwt = signAppJwt({ appId, privateKey, now });
      const url = `${baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`;
      const result = await request(url, `Bearer ${jwt}`);
      if (!('status' in result)) return result;

      if (result.status === 404) {
        return failure('installation_not_found', `no installation covers ${owner}/${repo}`);
      }
      const commonFailure = commonStatusFailure(result);
      if (commonFailure !== null) return commonFailure;

      const body = typeof result.body === 'object' && result.body !== null ? (result.body as Record<string, unknown>) : null;
      if (body === null || typeof body['id'] !== 'number') {
        return failure('malformed', 'response was missing an installation id');
      }
      return { ok: true, installationId: body['id'] };
    },

    async getInstallationToken(installationId: number) {
      return tokenIssuer.getInstallationToken(installationId);
    },

    async getRepositoryMetadata(installationId: number, owner: string, repo: string): Promise<GetRepositoryMetadataResult> {
      const issued = await tokenIssuer.getInstallationToken(installationId);
      if (!issued.ok) return issued;

      const url = `${baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
      const result = await request(url, `Bearer ${issued.token}`);
      if (!('status' in result)) return result;

      if (result.status === 404) {
        return failure('installation_not_found', `installation ${installationId} does not cover ${owner}/${repo}`);
      }
      const commonFailure = commonStatusFailure(result);
      if (commonFailure !== null) return commonFailure;

      const body = typeof result.body === 'object' && result.body !== null ? (result.body as Record<string, unknown>) : null;
      const ownerObject = body?.['owner'];
      const ownerLogin =
        typeof ownerObject === 'object' && ownerObject !== null
          ? (ownerObject as Record<string, unknown>)['login']
          : undefined;
      const name = body?.['name'];
      const defaultBranch = body?.['default_branch'];
      if (typeof ownerLogin !== 'string' || typeof name !== 'string' || typeof defaultBranch !== 'string') {
        return failure('malformed', 'response was missing owner.login, name, or default_branch');
      }

      // Defence in depth: the response must describe the repository that
      // was actually requested, the same "response identity must match
      // request identity" check neutara/client.ts's matchesRequestedIdentifier
      // applies to an issue fetch.
      if (ownerLogin.toLowerCase() !== owner.toLowerCase() || name.toLowerCase() !== repo.toLowerCase()) {
        return failure('malformed', `response described a different repository ('${ownerLogin}/${name}')`);
      }

      const rawVisibility = body?.['visibility'];
      const visibility: 'public' | 'private' | 'internal' =
        rawVisibility === 'public' || rawVisibility === 'private' || rawVisibility === 'internal'
          ? rawVisibility
          : body?.['private'] === true
            ? 'private'
            : 'public';

      return { ok: true, metadata: { owner: ownerLogin, repo: name, defaultBranch, visibility } };
    },

    async getFileContents(
      installationId: number,
      owner: string,
      repo: string,
      path: string,
      ref: string,
    ): Promise<GetFileContentsResult> {
      const issued = await tokenIssuer.getInstallationToken(installationId);
      if (!issued.ok) return issued;

      const url = `${baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeContentsPath(path)}?ref=${encodeURIComponent(ref)}`;
      const result = await request(url, `Bearer ${issued.token}`);
      if (!('status' in result)) return result;

      if (result.status === 404) {
        // GitHub's Contents API returns 404 for both a missing path and a
        // missing ref, with no distinguishing status code. It does
        // distinguish them in the error message ("No commit found for the
        // ref ...") — best-effort sniffing of that message, not guaranteed
        // to hold forever; a wrong classification here only changes the
        // REPORTED reason, never whether the request is refused.
        const message =
          typeof result.body === 'object' && result.body !== null
            ? (result.body as Record<string, unknown>)['message']
            : undefined;
        if (typeof message === 'string' && /no commit found for the ref/i.test(message)) {
          return failure('branch_not_found', `ref '${ref}' does not exist on ${owner}/${repo}`);
        }
        return failure('file_not_found', `'${path}' does not exist on ${owner}/${repo}@${ref}`);
      }

      const commonFailure = commonStatusFailure(result);
      if (commonFailure !== null) return commonFailure;

      if (Array.isArray(result.body)) {
        return failure('malformed', `'${path}' is a directory, not a file`);
      }
      const body = typeof result.body === 'object' && result.body !== null ? (result.body as Record<string, unknown>) : null;
      if (body === null) return failure('malformed', 'response was not an object');
      if (body['type'] !== 'file') {
        return failure('malformed', `'${path}' is not a regular file (type: ${String(body['type'])})`);
      }
      if (body['encoding'] !== 'base64') {
        return failure('malformed', `unexpected content encoding '${String(body['encoding'])}'`);
      }
      if (typeof body['content'] !== 'string') {
        return failure(
          'malformed',
          `'${path}' has no content in the response (it may exceed the Contents API's size limit)`,
        );
      }

      const decoded = decodeBase64Content(body['content']);
      if (decoded === null) return failure('malformed', 'response content was not valid base64');

      return { ok: true, content: decoded };
    },

    async getRef(installationId: number, owner: string, repo: string, branch: string): Promise<GetRefResult> {
      const issued = await tokenIssuer.getInstallationToken(installationId);
      if (!issued.ok) return issued;

      const url = `${baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/${encodeContentsPath(`heads/${branch}`)}`;
      const result = await request(url, `Bearer ${issued.token}`);
      if (!('status' in result)) return result;

      if (result.status === 404) {
        return failure('branch_not_found', `ref '${branch}' does not exist on ${owner}/${repo}`);
      }
      const commonFailure = commonStatusFailure(result);
      if (commonFailure !== null) return commonFailure;

      const body = typeof result.body === 'object' && result.body !== null ? (result.body as Record<string, unknown>) : null;
      const object = typeof body?.['object'] === 'object' && body['object'] !== null ? (body['object'] as Record<string, unknown>) : null;
      const sha = object?.['sha'];
      if (typeof sha !== 'string') return failure('malformed', 'response was missing object.sha');

      return { ok: true, sha };
    },

    async getCommit(installationId: number, owner: string, repo: string, sha: string): Promise<GetCommitResult> {
      const issued = await tokenIssuer.getInstallationToken(installationId);
      if (!issued.ok) return issued;

      const url = `${baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${encodeURIComponent(sha)}`;
      const result = await request(url, `Bearer ${issued.token}`);
      if (!('status' in result)) return result;

      if (result.status === 404) return failure('malformed', `commit '${sha}' does not exist on ${owner}/${repo}`);
      const commonFailure = commonStatusFailure(result);
      if (commonFailure !== null) return commonFailure;

      const body = typeof result.body === 'object' && result.body !== null ? (result.body as Record<string, unknown>) : null;
      const tree = typeof body?.['tree'] === 'object' && body['tree'] !== null ? (body['tree'] as Record<string, unknown>) : null;
      const treeSha = tree?.['sha'];
      if (typeof treeSha !== 'string') return failure('malformed', 'response was missing tree.sha');

      return { ok: true, treeSha };
    },

    async createTree(
      installationId: number,
      owner: string,
      repo: string,
      baseTreeSha: string,
      files: readonly TreeFileEntry[],
    ): Promise<CreateTreeResult> {
      const issued = await tokenIssuer.getInstallationToken(installationId);
      if (!issued.ok) return issued;

      const url = `${baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees`;
      const payload = {
        base_tree: baseTreeSha,
        tree: files.map((file) => ({ path: file.path, mode: '100644', type: 'blob', content: file.content })),
      };
      const result = await request(url, `Bearer ${issued.token}`, { method: 'POST', body: payload });
      if (!('status' in result)) return result;

      const commonFailure = commonStatusFailure(result, [201]);
      if (commonFailure !== null) return commonFailure;

      const body = typeof result.body === 'object' && result.body !== null ? (result.body as Record<string, unknown>) : null;
      const sha = body?.['sha'];
      if (typeof sha !== 'string') return failure('malformed', 'response was missing sha');

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
      const issued = await tokenIssuer.getInstallationToken(installationId);
      if (!issued.ok) return issued;

      const url = `${baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits`;
      const payload = { message, tree: treeSha, parents: [...parentShas] };
      const result = await request(url, `Bearer ${issued.token}`, { method: 'POST', body: payload });
      if (!('status' in result)) return result;

      const commonFailure = commonStatusFailure(result, [201]);
      if (commonFailure !== null) return commonFailure;

      const body = typeof result.body === 'object' && result.body !== null ? (result.body as Record<string, unknown>) : null;
      const sha = body?.['sha'];
      if (typeof sha !== 'string') return failure('malformed', 'response was missing sha');

      return { ok: true, sha };
    },

    async createBranch(installationId: number, owner: string, repo: string, branch: string, sha: string): Promise<CreateBranchResult> {
      const issued = await tokenIssuer.getInstallationToken(installationId);
      if (!issued.ok) return issued;

      const url = `${baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`;
      const payload = { ref: `refs/heads/${branch}`, sha };
      const result = await request(url, `Bearer ${issued.token}`, { method: 'POST', body: payload });
      if (!('status' in result)) return result;

      if (result.status === 422) {
        return failure('ref_already_exists', responseErrorMessage(result) ?? `branch '${branch}' already exists on ${owner}/${repo}`);
      }
      const commonFailure = commonStatusFailure(result, [201]);
      if (commonFailure !== null) return commonFailure;

      return { ok: true };
    },

    async createPullRequest(
      installationId: number,
      owner: string,
      repo: string,
      input: { readonly title: string; readonly body: string; readonly head: string; readonly base: string },
    ): Promise<CreatePullRequestResult> {
      const issued = await tokenIssuer.getInstallationToken(installationId);
      if (!issued.ok) return issued;

      const url = `${baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`;
      const payload = { title: input.title, body: input.body, head: input.head, base: input.base };
      const result = await request(url, `Bearer ${issued.token}`, { method: 'POST', body: payload });
      if (!('status' in result)) return result;

      if (result.status === 422) {
        return failure(
          'pull_request_already_exists',
          responseErrorMessage(result) ?? `a pull request already exists for ${input.head} -> ${input.base} on ${owner}/${repo}`,
        );
      }
      const commonFailure = commonStatusFailure(result, [201]);
      if (commonFailure !== null) return commonFailure;

      const responseBody = typeof result.body === 'object' && result.body !== null ? (result.body as Record<string, unknown>) : null;
      const number = responseBody?.['number'];
      const htmlUrl = responseBody?.['html_url'];
      const state = responseBody?.['state'];
      if (typeof number !== 'number' || typeof htmlUrl !== 'string' || typeof state !== 'string') {
        return failure('malformed', 'response was missing number, html_url, or state');
      }

      return { ok: true, number, htmlUrl, state };
    },

    async findPullRequestForBranch(
      installationId: number,
      owner: string,
      repo: string,
      head: string,
      base: string,
    ): Promise<FindPullRequestResult> {
      const issued = await tokenIssuer.getInstallationToken(installationId);
      if (!issued.ok) return issued;

      const url = `${baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?head=${encodeURIComponent(`${owner}:${head}`)}&base=${encodeURIComponent(base)}&state=open`;
      const result = await request(url, `Bearer ${issued.token}`);
      if (!('status' in result)) return result;

      const commonFailure = commonStatusFailure(result);
      if (commonFailure !== null) return commonFailure;

      if (!Array.isArray(result.body)) return failure('malformed', 'response was not an array');
      if (result.body.length === 0) return { ok: true, pullRequest: null };

      const first = result.body[0] as Record<string, unknown>;
      const number = first['number'];
      const htmlUrl = first['html_url'];
      const state = first['state'];
      if (typeof number !== 'number' || typeof htmlUrl !== 'string' || typeof state !== 'string') {
        return failure('malformed', 'response entry was missing number, html_url, or state');
      }

      return { ok: true, pullRequest: { number, htmlUrl, state } };
    },

    async getPullRequest(installationId: number, owner: string, repo: string, number: number): Promise<GetPullRequestResult> {
      const issued = await tokenIssuer.getInstallationToken(installationId);
      if (!issued.ok) return issued;

      const url = `${baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(String(number))}`;
      const result = await request(url, `Bearer ${issued.token}`);
      if (!('status' in result)) return result;

      if (result.status === 404) {
        return failure('file_not_found', `no pull request #${number} on ${owner}/${repo}`);
      }
      const commonFailure = commonStatusFailure(result);
      if (commonFailure !== null) return commonFailure;

      const body = typeof result.body === 'object' && result.body !== null ? (result.body as Record<string, unknown>) : null;
      const prNumber = body?.['number'];
      const htmlUrl = body?.['html_url'];
      const state = body?.['state'];
      const merged = body?.['merged'];
      const mergeCommitSha = body?.['merge_commit_sha'];
      const head = typeof body?.['head'] === 'object' && body['head'] !== null ? (body['head'] as Record<string, unknown>) : null;
      const base = typeof body?.['base'] === 'object' && body['base'] !== null ? (body['base'] as Record<string, unknown>) : null;
      const headRef = head?.['ref'];
      const baseRef = base?.['ref'];

      if (
        typeof prNumber !== 'number' ||
        typeof htmlUrl !== 'string' ||
        typeof state !== 'string' ||
        typeof merged !== 'boolean' ||
        typeof headRef !== 'string' ||
        typeof baseRef !== 'string'
      ) {
        return failure('malformed', 'response was missing number, html_url, state, merged, head.ref, or base.ref');
      }

      return {
        ok: true,
        number: prNumber,
        htmlUrl,
        state,
        merged,
        mergeCommitSha: typeof mergeCommitSha === 'string' ? mergeCommitSha : null,
        headRef,
        baseRef,
      };
    },
  };
}
