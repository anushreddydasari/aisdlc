/**
 * Installation-token issuance and caching — the one component in this
 * phase that makes a real network call, and only when explicitly given a
 * `fetchFn` pointed somewhere real. Every test in token-issuer.test.ts
 * injects a fake `fetchFn` and never reaches the network, mirroring
 * `NeutaraClientOptions.fetchFn` in src/neutara/client.ts exactly.
 *
 * This does NOT implement the full `GitHubAppClient` interface from
 * client.ts (no `resolveInstallation`/`getRepositoryMetadata`/`getFileContents`)
 * — Stage 2's scope is authentication only, per
 * docs/github-app-integration-design.md's staged plan. A later stage
 * composes this with real implementations of those methods into a
 * complete `GitHubAppClient`.
 *
 * Caching and de-duplication: a token is reused until it is within
 * `refreshMarginMs` of expiring, and concurrent calls for the SAME
 * installation id while a refresh is already in flight share that one
 * request rather than each firing their own — otherwise a burst of calls
 * for one installation would needlessly spend GitHub's rate limit.
 *
 * SECRET HANDLING: the App-level JWT and the installation token are never
 * logged. A failure logs only `{ installationId, timedOut, error }` — the
 * URL and headers containing the JWT are never included in that error
 * (fetch/abort errors describe network/transport failure, not request
 * content), and `error` itself passes through the redacting logger, which
 * also now recognizes a JWT or GitHub token shape in free text as a second
 * layer of defence.
 */

import type { Logger } from '../logging/logger.ts';
import { signAppJwt } from './jwt.ts';
import type { GitHubAccessFailureKind, IssueInstallationTokenResult } from './client.ts';
import {
  classifyRateLimit,
  DEFAULT_GITHUB_API_BASE_URL,
  DEFAULT_REQUEST_TIMEOUT_MS,
  githubRequestHeaders,
  normalizeBaseUrl,
} from './http.ts';

export { DEFAULT_GITHUB_API_BASE_URL, DEFAULT_REQUEST_TIMEOUT_MS };
/** Refresh a cached token once it is within 5 minutes of its 1-hour expiry. */
export const DEFAULT_REFRESH_MARGIN_MS = 5 * 60_000;

export interface TokenIssuerOptions {
  readonly appId: number;
  /** PEM-format RSA private key. Never logged — see the module comment above. */
  readonly privateKey: string;
  readonly logger: Logger;
  /** Origin only, no trailing slash. Defaults to the real GitHub API — tests always override this or, more commonly, inject `fetchFn` instead. */
  readonly baseUrl?: string;
  /** Injectable so tests never reach the network. Defaults to the global `fetch`. */
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
  readonly refreshMarginMs?: number;
  readonly now?: () => Date;
}

export interface TokenIssuer {
  getInstallationToken(installationId: number): Promise<IssueInstallationTokenResult>;
}

interface CachedToken {
  readonly token: string;
  readonly expiresAt: Date;
}

function failure(kind: GitHubAccessFailureKind, message: string, retryAfterMs?: number): IssueInstallationTokenResult {
  return { ok: false, kind, message, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
}

export function createTokenIssuer(options: TokenIssuerOptions): TokenIssuer {
  const { appId, privateKey, logger } = options;
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_GITHUB_API_BASE_URL);
  const doFetch = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const refreshMarginMs = options.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS;
  const now = options.now ?? (() => new Date());

  const cache = new Map<number, CachedToken>();
  const inFlight = new Map<number, Promise<IssueInstallationTokenResult>>();

  async function requestFreshToken(installationId: number): Promise<IssueInstallationTokenResult> {
    const jwt = signAppJwt({ appId, privateKey, now });
    const url = `${baseUrl}/app/installations/${installationId}/access_tokens`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await doFetch(url, {
        method: 'POST',
        // The only place the JWT appears. Never logged, never stored,
        // never included in a failure message.
        headers: githubRequestHeaders(`Bearer ${jwt}`),
        signal: controller.signal,
      });

      if (response.status === 404) {
        return failure('installation_not_found', `installation ${installationId} was not found`);
      }
      if (response.status === 401) {
        return failure('insufficient_permission', 'github rejected the App-level JWT');
      }

      const rateLimit = classifyRateLimit(response.status, response.headers, now());
      if (rateLimit.limited) {
        return failure(
          'rate_limited',
          `github rate limited the request (status ${response.status})`,
          rateLimit.retryAfterMs,
        );
      }
      if (response.status === 403) {
        return failure('insufficient_permission', 'github refused the request (403, not rate-limited)');
      }
      if (response.status >= 500) {
        return failure('transient', `github returned ${response.status}`);
      }
      if (response.status !== 201) {
        return failure('malformed', `github returned unexpected status ${response.status}`);
      }

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        return failure('malformed', 'response was not valid JSON');
      }
      const body = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
      if (typeof body['token'] !== 'string' || typeof body['expires_at'] !== 'string') {
        return failure('malformed', 'response was missing token or expires_at');
      }
      const expiresAt = new Date(body['expires_at']);
      if (Number.isNaN(expiresAt.getTime())) {
        return failure('malformed', 'response expires_at was not a valid date');
      }

      return { ok: true, token: body['token'], expiresAt };
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      logger.warn('github installation token request failed', { installationId, timedOut: aborted, error });
      return failure('transient', aborted ? `request timed out after ${timeoutMs}ms` : 'request failed');
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async getInstallationToken(installationId: number): Promise<IssueInstallationTokenResult> {
      const cached = cache.get(installationId);
      if (cached !== undefined && cached.expiresAt.getTime() - now().getTime() > refreshMarginMs) {
        return { ok: true, token: cached.token, expiresAt: cached.expiresAt };
      }

      const existing = inFlight.get(installationId);
      if (existing !== undefined) return existing;

      const promise = requestFreshToken(installationId).finally(() => inFlight.delete(installationId));
      inFlight.set(installationId, promise);

      const result = await promise;
      if (result.ok) cache.set(installationId, { token: result.token, expiresAt: result.expiresAt });
      return result;
    },
  };
}
