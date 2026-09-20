/**
 * HMAC-SHA256 verification for inbound Neutara webhooks.
 *
 * A pure utility. It is deliberately not wired to any route yet — the webhook
 * payload contract is still being confirmed, but the signature scheme is not:
 * it is pinned by the sender implementation in the Neutara ticketing service
 * (`src/lib/connector-service.ts`, `fireWebhook`), which does
 *
 *     const body = JSON.stringify(payload);
 *     const sig  = crypto.createHmac('sha256', secret).update(body).digest('hex');
 *     headers['X-Neutara-Signature'] = `sha256=${sig}`;
 *
 * Two consequences for this module:
 *
 *   1. The MAC covers the exact bytes on the wire. Verification must run
 *      against the raw body before JSON.parse — re-serialising a parsed
 *      object reorders nothing in practice but is not guaranteed to, and any
 *      difference in whitespace or escaping breaks the MAC.
 *   2. `digest('hex')` is lowercase, but the comparison here is
 *      case-insensitive so a proxy that upper-cases the header cannot cause a
 *      spurious rejection.
 *
 * The sender only attaches a signature when its connector has a secret
 * configured, so unsigned requests are a real possibility. They are rejected:
 * an unsigned request is indistinguishable from a forged one.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-neutara-signature';
export const SIGNATURE_PREFIX = 'sha256=';

/** Length of a hex-encoded SHA-256 digest. */
const DIGEST_HEX_LENGTH = 64;

export type SignatureFailure =
  /** No secret configured: refuse everything rather than accept unsigned. */
  | 'no_secret_configured'
  | 'missing_header'
  | 'malformed_header'
  | 'mismatch';

export type VerifyResult = { readonly valid: true } | { readonly valid: false; readonly reason: SignatureFailure };

export interface VerifyInput {
  /** NEUTARA_WEBHOOK_SECRET, or undefined when unconfigured. */
  readonly secret: string | undefined;
  /** The exact bytes received, before parsing. */
  readonly body: Buffer;
  /** Raw header value, e.g. `sha256=<hex>`. */
  readonly header: string | undefined;
}

/** Hex-encoded HMAC-SHA256 of `body` under `secret`. Lowercase, unprefixed. */
export function computeSignature(secret: string, body: Buffer): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/** The full header value the sender would produce. */
export function buildSignatureHeader(secret: string, body: Buffer): string {
  return `${SIGNATURE_PREFIX}${computeSignature(secret, body)}`;
}

function parseHeader(header: string): string | null {
  const trimmed = header.trim();
  if (!trimmed.toLowerCase().startsWith(SIGNATURE_PREFIX)) return null;

  const hex = trimmed.slice(SIGNATURE_PREFIX.length).toLowerCase();
  // Validated before comparison so a malformed header is a distinct outcome
  // rather than an expensive comparison against garbage.
  if (hex.length !== DIGEST_HEX_LENGTH) return null;
  if (!/^[0-9a-f]+$/.test(hex)) return null;
  return hex;
}

/**
 * Verifies a signature in constant time with respect to the digest.
 *
 * Failure reasons are for logging only. They must never reach the client:
 * telling a caller whether the header was missing, malformed or merely wrong
 * hands them a free oracle. The endpoint should answer 401 to all of them.
 */
export function verifySignature(input: VerifyInput): VerifyResult {
  const { secret, body, header } = input;

  if (secret === undefined || secret.trim() === '') {
    return { valid: false, reason: 'no_secret_configured' };
  }
  if (header === undefined || header.trim() === '') {
    return { valid: false, reason: 'missing_header' };
  }

  const provided = parseHeader(header);
  if (provided === null) return { valid: false, reason: 'malformed_header' };

  const expected = computeSignature(secret.trim(), body);

  // Both are validated 64-char hex, so the lengths always match and
  // timingSafeEqual cannot throw.
  const equal = timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
  return equal ? { valid: true } : { valid: false, reason: 'mismatch' };
}
