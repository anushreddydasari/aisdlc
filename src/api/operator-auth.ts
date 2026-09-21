/**
 * Bearer-token verification for the human approval gate.
 *
 * A pure utility, mirroring signature.ts's shape: constant-time comparison,
 * and failure reasons that are for logging only — they must never reach the
 * client, since telling a caller whether the header was missing, malformed
 * or merely wrong hands them a free oracle. The endpoint answers 401 to all
 * of them uniformly.
 *
 * Unlike the webhook's HMAC (which proves the BODY came from Neutara), this
 * is a simple shared-secret bearer check: OPERATOR_TOKEN proves the CALLER
 * is authorized to act as an operator. Which specific operator is a
 * separate, non-secret field in the request body — see approval.ts.
 */

import { timingSafeEqual } from 'node:crypto';

export const AUTHORIZATION_HEADER = 'authorization';
export const BEARER_PREFIX = 'Bearer ';

export type OperatorAuthFailure =
  /** No token configured: refuse everything rather than accept anything. */
  | 'no_token_configured'
  | 'missing_header'
  | 'malformed_header'
  | 'mismatch';

export type VerifyOperatorResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: OperatorAuthFailure };

export interface VerifyOperatorInput {
  /** OPERATOR_TOKEN, or undefined when unconfigured. */
  readonly token: string | undefined;
  /** Raw Authorization header value, e.g. `Bearer <token>`. */
  readonly header: string | undefined;
}

/** Verifies the bearer token in constant time with respect to its value. */
export function verifyOperatorToken(input: VerifyOperatorInput): VerifyOperatorResult {
  const { token, header } = input;

  if (token === undefined || token.trim() === '') {
    return { valid: false, reason: 'no_token_configured' };
  }
  if (header === undefined || header.trim() === '') {
    return { valid: false, reason: 'missing_header' };
  }
  if (!header.startsWith(BEARER_PREFIX)) {
    return { valid: false, reason: 'malformed_header' };
  }

  const provided = Buffer.from(header.slice(BEARER_PREFIX.length), 'utf8');
  const expected = Buffer.from(token.trim(), 'utf8');

  // timingSafeEqual throws on a length mismatch rather than returning false,
  // so unequal length is checked first — itself not a timing leak, since an
  // attacker can already learn the expected length from OPERATOR_TOKEN's
  // documentation, not from this comparison.
  if (provided.length !== expected.length) {
    return { valid: false, reason: 'mismatch' };
  }
  return timingSafeEqual(provided, expected) ? { valid: true } : { valid: false, reason: 'mismatch' };
}
