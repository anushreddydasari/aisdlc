/**
 * Uses a synthetic RSA keypair generated fresh, in memory, for this test
 * run only. It is never written to disk, never reused between runs, and is
 * not associated with any real GitHub App — generating a throwaway keypair
 * is the only way to test real RS256 signing without a real credential.
 */

import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';

import { APP_JWT_CLOCK_DRIFT_SECONDS, APP_JWT_TTL_SECONDS, signAppJwt } from './jwt.ts';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

describe('signAppJwt', () => {
  it('produces a three-segment header.payload.signature JWT', () => {
    const jwt = signAppJwt({ appId: 123456, privateKey });
    assert.equal(jwt.split('.').length, 3);
  });

  it('sets alg RS256 and typ JWT in the header', () => {
    const [header] = signAppJwt({ appId: 123456, privateKey }).split('.');
    assert.deepEqual(decodeSegment(header!), { alg: 'RS256', typ: 'JWT' });
  });

  it('sets iss to the app id, and exp exactly 600s after iat', () => {
    const now = new Date('2026-09-22T00:00:00.000Z');
    const [, payload] = signAppJwt({ appId: 987654, privateKey, now: () => now }).split('.');
    const claims = decodeSegment(payload!) as { iss: number; iat: number; exp: number };

    assert.equal(claims.iss, 987654);
    assert.equal(claims.exp - claims.iat, APP_JWT_TTL_SECONDS);
  });

  it('back-dates iat by the clock-drift buffer', () => {
    const now = new Date('2026-09-22T00:00:00.000Z');
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const [, payload] = signAppJwt({ appId: 1, privateKey, now: () => now }).split('.');
    const claims = decodeSegment(payload!) as { iat: number };

    assert.equal(claims.iat, nowSeconds - APP_JWT_CLOCK_DRIFT_SECONDS);
  });

  it('produces a signature that verifies against the matching public key', () => {
    const jwt = signAppJwt({ appId: 42, privateKey });
    const [header, payload, signature] = jwt.split('.');
    const signingInput = `${header}.${payload}`;

    const verified = createVerify('RSA-SHA256')
      .update(signingInput)
      .end()
      .verify(publicKey, signature!, 'base64url');

    assert.equal(verified, true);
  });

  it('does not verify against a different keypair', () => {
    const otherKeys = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    const jwt = signAppJwt({ appId: 42, privateKey });
    const [header, payload, signature] = jwt.split('.');

    const verified = createVerify('RSA-SHA256')
      .update(`${header}.${payload}`)
      .end()
      .verify(otherKeys.publicKey, signature!, 'base64url');

    assert.equal(verified, false);
  });

  it('mints a different JWT (different iat) on each call a second apart', () => {
    const first = signAppJwt({ appId: 1, privateKey, now: () => new Date('2026-09-22T00:00:00.000Z') });
    const second = signAppJwt({ appId: 1, privateKey, now: () => new Date('2026-09-22T00:00:01.000Z') });
    assert.notEqual(first, second);
  });

  describe('secret-safe: no key material leaks into the JWT itself', () => {
    it('the encoded header and payload never contain the raw private key text', () => {
      const jwt = signAppJwt({ appId: 1, privateKey });
      assert.ok(!jwt.includes('BEGIN RSA PRIVATE KEY'));
      // The signature is derived from, but does not literally embed, the key.
      const [, , signature] = jwt.split('.');
      assert.ok(!privateKey.includes(signature!));
    });
  });
});
