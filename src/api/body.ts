/**
 * Raw request-body reader with a hard size ceiling.
 *
 * A pure utility, not yet wired to any route.
 *
 * Returns the exact bytes rather than a parsed object, because HMAC
 * verification has to run over what was actually received. Parsing happens
 * afterwards, and only once the signature has been checked — parsing
 * attacker-controlled JSON before authenticating it is work done on behalf of
 * an unauthenticated caller.
 *
 * The ceiling is enforced while reading, not after. Buffering an unbounded
 * body and then measuring it is the whole vulnerability: a single large POST
 * would be enough to exhaust memory on a small instance.
 */

import type { IncomingMessage } from 'node:http';

/** 256 KB. A ticket payload is a few KB; this is generous with room to spare. */
export const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

export type BodyFailure =
  /** Exceeded the ceiling; reading was abandoned part-way. */
  | 'too_large'
  /** Client disconnected, or the stream errored. */
  | 'aborted';

export type ReadBodyResult =
  | { readonly ok: true; readonly body: Buffer }
  | { readonly ok: false; readonly reason: BodyFailure };

export interface ReadBodyOptions {
  readonly maxBytes?: number;
}

/**
 * Reads the whole body, or gives up as soon as it is too large.
 *
 * Never rejects: a transport failure is an expected outcome for a network
 * handler, not an exception. On `too_large` the request is destroyed so the
 * remaining bytes are not read into memory.
 */
export function readRawBody(
  req: IncomingMessage,
  options: ReadBodyOptions = {},
): Promise<ReadBodyResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BODY_BYTES;

  return new Promise<ReadBodyResult>((resolve) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;

    const settle = (result: ReadBodyResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    // A declared length over the ceiling is refused before a byte is read.
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      req.destroy();
      settle({ ok: false, reason: 'too_large' });
      return;
    }

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      received += chunk.length;
      if (received > maxBytes) {
        // Stop reading immediately; do not keep what has arrived.
        chunks.length = 0;
        req.destroy();
        settle({ ok: false, reason: 'too_large' });
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => settle({ ok: true, body: Buffer.concat(chunks) }));
    req.on('error', () => settle({ ok: false, reason: 'aborted' }));
    req.on('aborted', () => settle({ ok: false, reason: 'aborted' }));
  });
}
