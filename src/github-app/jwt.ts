/**
 * GitHub App-level JWT signing — pure local cryptography, no network.
 *
 * This proves "this caller is the App" (see docs/github-app-integration-design.md
 * §1). It is never itself used to act on a repository; it is only ever
 * exchanged for a short-lived, repository-scoped installation token (see
 * token-issuer.ts), the same two-layer split GitHub's own docs describe.
 *
 * SECRET HANDLING: the private key is read, used once to sign, and never
 * returned, logged, or stored anywhere by this module. The JWT this
 * function returns IS itself sensitive (it authenticates as the App for up
 * to 10 minutes) — callers must not log it either. `logging/logger.ts`'s
 * redaction now also catches a JWT-shaped string in free text as defence
 * in depth, but the primary control is simply: never pass it to a logger.
 */

import { createSign } from 'node:crypto';

/** GitHub rejects a JWT whose `exp - iat` exceeds this. */
export const APP_JWT_TTL_SECONDS = 600;
/**
 * Back-dates `iat` by this much, per GitHub's own guidance, so a JWT is not
 * rejected as "issued in the future" when the signing machine's clock runs
 * slightly ahead of GitHub's.
 */
export const APP_JWT_CLOCK_DRIFT_SECONDS = 60;

export interface SignAppJwtOptions {
  readonly appId: number;
  /** PEM-format RSA private key. Already shape-validated by config.ts before this is called. */
  readonly privateKey: string;
  readonly now?: () => Date;
}

function base64UrlEncodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/**
 * Signs a fresh RS256 JWT for GitHub App-level authentication.
 *
 * Deliberately mints a new JWT on every call rather than caching one: a
 * JWT is cheap to produce (one signing operation, no network), so there is
 * no benefit to reuse that would offset the complexity of tracking its
 * remaining validity — unlike an installation token (token-issuer.ts),
 * which costs a network round trip per issuance and is worth caching.
 */
export function signAppJwt(options: SignAppJwtOptions): string {
  const now = options.now ?? (() => new Date());
  const nowSeconds = Math.floor(now().getTime() / 1000);
  const iat = nowSeconds - APP_JWT_CLOCK_DRIFT_SECONDS;
  const exp = iat + APP_JWT_TTL_SECONDS;

  const encodedHeader = base64UrlEncodeJson({ alg: 'RS256', typ: 'JWT' });
  const encodedPayload = base64UrlEncodeJson({ iat, exp, iss: options.appId });
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signature = createSign('RSA-SHA256').update(signingInput).end().sign(options.privateKey, 'base64url');

  return `${signingInput}.${signature}`;
}
