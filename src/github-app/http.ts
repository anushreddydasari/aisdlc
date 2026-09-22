/**
 * Shared conventions for every real GitHub API call: the base URL, the
 * pinned API version, the default timeout, and rate-limit classification.
 *
 * Extracted out of token-issuer.ts (Stage 2's only real HTTP call) so the
 * real API client (Stage 3, in real-client.ts) reuses the EXACT SAME
 * rate-limit logic rather than re-deriving it at a second call site.
 * `token-issuer.test.ts` already caught one real bug in this logic — a
 * `403` with no rate-limit evidence being misclassified as `rate_limited` —
 * before it shipped; duplicating the logic risks reintroducing that exact
 * mistake somewhere it would not be caught a second time.
 */

export const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com';
export const GITHUB_API_VERSION = '2022-11-28';
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** The headers every authenticated GitHub API call sends, given a fully-formed `Authorization` value. */
export function githubRequestHeaders(authorization: string): Record<string, string> {
  return {
    // The only place a JWT or installation token appears. Callers must
    // never log this object or the `authorization` value themselves.
    authorization,
    accept: 'application/vnd.github+json',
    'x-github-api-version': GITHUB_API_VERSION,
    'user-agent': 'aisdlc-service',
  };
}

/**
 * `Retry-After` (seconds) takes priority when present. Otherwise, a
 * primary-rate-limit response typically carries `X-RateLimit-Remaining: 0`
 * and `X-RateLimit-Reset` (an epoch-seconds timestamp) instead.
 */
export function parseRetryAfterMs(headers: Headers, now: Date): number | undefined {
  const retryAfter = headers.get('retry-after');
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  }
  if (headers.get('x-ratelimit-remaining') === '0') {
    const reset = headers.get('x-ratelimit-reset');
    const resetEpochSeconds = reset === null ? NaN : Number(reset);
    if (Number.isFinite(resetEpochSeconds)) {
      return Math.max(0, resetEpochSeconds * 1000 - now.getTime());
    }
  }
  return undefined;
}

export type RateLimitDecision =
  | { readonly limited: true; readonly retryAfterMs: number | undefined }
  | { readonly limited: false };

/**
 * 429 is unambiguous: GitHub only ever sends it for rate limiting, so it is
 * treated as a rate limit even when no header lets us compute a delay.
 * 403 is ambiguous — GitHub also uses it for plain permission failures —
 * so a 403 counts as a rate limit ONLY when a rate-limit header actually
 * says so; otherwise it is a plain permission failure, never a guess.
 */
export function classifyRateLimit(status: number, headers: Headers, now: Date): RateLimitDecision {
  if (status === 429) return { limited: true, retryAfterMs: parseRetryAfterMs(headers, now) };
  if (status === 403) {
    const retryAfterMs = parseRetryAfterMs(headers, now);
    return retryAfterMs === undefined ? { limited: false } : { limited: true, retryAfterMs };
  }
  return { limited: false };
}

/** Strips a trailing slash so callers can safely append a path with a leading one. */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}
