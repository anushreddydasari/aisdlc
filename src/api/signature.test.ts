import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  SIGNATURE_HEADER,
  SIGNATURE_PREFIX,
  buildSignatureHeader,
  computeSignature,
  verifySignature,
} from './signature.ts';

const SECRET = 'whsec_test_secret_value_not_real'; // pragma: fixture
const BODY = Buffer.from(JSON.stringify({ event: 'issue.created', issue: { key: 'AIS-1' } }));

/** Exactly what the Neutara sender does, reproduced independently. */
function senderSignature(secret: string, body: Buffer): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('compatibility with the Neutara sender', () => {
  it('matches the sender implementation byte for byte', () => {
    // Mirrors fireWebhook() in the ticketing service: HMAC-SHA256 over the
    // serialised body, hex digest, `sha256=` prefix.
    assert.equal(buildSignatureHeader(SECRET, BODY), senderSignature(SECRET, BODY));
  });

  it('uses the header name the sender sets', () => {
    assert.equal(SIGNATURE_HEADER, 'x-neutara-signature');
    assert.equal(SIGNATURE_PREFIX, 'sha256=');
  });

  it('produces a lowercase 64-character hex digest', () => {
    assert.match(computeSignature(SECRET, BODY), /^[0-9a-f]{64}$/);
  });

  it('accepts a signature the sender would produce', () => {
    const result = verifySignature({
      secret: SECRET,
      body: BODY,
      header: senderSignature(SECRET, BODY),
    });
    assert.ok(result.valid);
  });
});

describe('rejection', () => {
  const header = buildSignatureHeader(SECRET, BODY);

  it('refuses everything when no secret is configured', () => {
    // .env.example: "If this is unset the /ingest endpoint refuses every
    // request rather than accepting unsigned ones."
    for (const secret of [undefined, '', '   ']) {
      const result = verifySignature({ secret, body: BODY, header });
      assert.ok(!result.valid);
      assert.equal(result.reason, 'no_secret_configured');
    }
  });

  it('refuses a missing header', () => {
    for (const h of [undefined, '', '  ']) {
      const result = verifySignature({ secret: SECRET, body: BODY, header: h });
      assert.ok(!result.valid);
      assert.equal(result.reason, 'missing_header');
    }
  });

  it('refuses a malformed header', () => {
    const digest = computeSignature(SECRET, BODY);
    const malformed = [
      digest, // no prefix
      `sha1=${digest}`, // wrong algorithm
      `${SIGNATURE_PREFIX}${digest.slice(0, 63)}`, // too short
      `${SIGNATURE_PREFIX}${digest}0`, // too long
      `${SIGNATURE_PREFIX}${'z'.repeat(64)}`, // not hex
      `${SIGNATURE_PREFIX}`, // empty digest
    ];
    for (const header of malformed) {
      const result = verifySignature({ secret: SECRET, body: BODY, header });
      assert.ok(!result.valid, `accepted malformed header: ${header.slice(0, 20)}`);
      assert.equal(result.reason, 'malformed_header');
    }
  });

  it('refuses a signature for different content', () => {
    const tampered = Buffer.from(JSON.stringify({ event: 'issue.created', issue: { key: 'AIS-2' } }));
    const result = verifySignature({ secret: SECRET, body: tampered, header });
    assert.ok(!result.valid);
    assert.equal(result.reason, 'mismatch');
  });

  it('refuses a signature made with a different secret', () => {
    const result = verifySignature({
      secret: SECRET,
      body: BODY,
      header: buildSignatureHeader('a-different-secret', BODY),
    });
    assert.ok(!result.valid);
    assert.equal(result.reason, 'mismatch');
  });

  it('refuses when a single byte of the body changed', () => {
    const almost = Buffer.from(BODY);
    almost[almost.length - 2] = almost[almost.length - 2]! ^ 0x01;
    const result = verifySignature({ secret: SECRET, body: almost, header });
    assert.ok(!result.valid);
    assert.equal(result.reason, 'mismatch');
  });
});

describe('tolerances', () => {
  it('accepts an upper-cased digest, in case a proxy rewrites it', () => {
    const upper = buildSignatureHeader(SECRET, BODY).toUpperCase();
    assert.ok(verifySignature({ secret: SECRET, body: BODY, header: upper }).valid);
  });

  it('accepts surrounding whitespace', () => {
    const padded = `  ${buildSignatureHeader(SECRET, BODY)}  `;
    assert.ok(verifySignature({ secret: SECRET, body: BODY, header: padded }).valid);
  });

  it('trims the configured secret', () => {
    const result = verifySignature({
      secret: `  ${SECRET}  `,
      body: BODY,
      header: buildSignatureHeader(SECRET, BODY),
    });
    assert.ok(result.valid);
  });

  it('handles an empty body', () => {
    const empty = Buffer.alloc(0);
    assert.ok(verifySignature({ secret: SECRET, body: empty, header: buildSignatureHeader(SECRET, empty) }).valid);
  });

  it('handles a body with non-ASCII content', () => {
    // Ticket summaries carry arbitrary text; the MAC is over bytes, not chars.
    const utf8 = Buffer.from(JSON.stringify({ summary: 'café — naïve 日本語' }));
    assert.ok(verifySignature({ secret: SECRET, body: utf8, header: buildSignatureHeader(SECRET, utf8) }).valid);
  });
});

describe('failure reasons are for logs only', () => {
  it('never includes the secret or the expected digest', () => {
    const result = verifySignature({ secret: SECRET, body: BODY, header: `${SIGNATURE_PREFIX}${'a'.repeat(64)}` });
    assert.ok(!result.valid);
    // The reason is a fixed token, so there is nothing to leak into a response
    // or a log line by accident.
    assert.ok(['no_secret_configured', 'missing_header', 'malformed_header', 'mismatch'].includes(result.reason));
    assert.ok(!result.reason.includes(SECRET));
  });
});
