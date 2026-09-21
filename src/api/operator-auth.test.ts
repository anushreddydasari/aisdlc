import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AUTHORIZATION_HEADER, BEARER_PREFIX, verifyOperatorToken } from './operator-auth.ts';

const TOKEN = 'op_test_token_value_not_real'; // pragma: fixture

describe('accepts a valid bearer token', () => {
  it('accepts the exact configured token', () => {
    const result = verifyOperatorToken({ token: TOKEN, header: `${BEARER_PREFIX}${TOKEN}` });
    assert.ok(result.valid);
  });

  it('uses the documented header name and scheme', () => {
    assert.equal(AUTHORIZATION_HEADER, 'authorization');
    assert.equal(BEARER_PREFIX, 'Bearer ');
  });
});

describe('rejection', () => {
  it('refuses everything when no token is configured', () => {
    for (const token of [undefined, '', '   ']) {
      const result = verifyOperatorToken({ token, header: `${BEARER_PREFIX}${TOKEN}` });
      assert.ok(!result.valid);
      assert.equal(result.reason, 'no_token_configured');
    }
  });

  it('refuses a missing header', () => {
    for (const header of [undefined, '', '  ']) {
      const result = verifyOperatorToken({ token: TOKEN, header });
      assert.ok(!result.valid);
      assert.equal(result.reason, 'missing_header');
    }
  });

  it('refuses a header without the Bearer scheme', () => {
    for (const header of [TOKEN, `Basic ${TOKEN}`, `bearer ${TOKEN}`]) {
      const result = verifyOperatorToken({ token: TOKEN, header });
      assert.ok(!result.valid, `accepted: ${header}`);
      assert.equal(result.reason, 'malformed_header');
    }
  });

  it('refuses a wrong token', () => {
    const result = verifyOperatorToken({ token: TOKEN, header: `${BEARER_PREFIX}wrong-token` });
    assert.ok(!result.valid);
    assert.equal(result.reason, 'mismatch');
  });

  it('refuses a token that merely shares a prefix', () => {
    const result = verifyOperatorToken({ token: TOKEN, header: `${BEARER_PREFIX}${TOKEN}-extra` });
    assert.ok(!result.valid);
    assert.equal(result.reason, 'mismatch');
  });

  it('refuses a token that is a truncated prefix of the real one', () => {
    const result = verifyOperatorToken({ token: TOKEN, header: `${BEARER_PREFIX}${TOKEN.slice(0, -1)}` });
    assert.ok(!result.valid);
    assert.equal(result.reason, 'mismatch');
  });

  it('refuses an empty token after the Bearer prefix', () => {
    const result = verifyOperatorToken({ token: TOKEN, header: BEARER_PREFIX });
    assert.ok(!result.valid);
    assert.equal(result.reason, 'mismatch');
  });
});

describe('failure reasons are for logs only', () => {
  it('never includes the token', () => {
    const result = verifyOperatorToken({ token: TOKEN, header: `${BEARER_PREFIX}wrong` });
    assert.ok(!result.valid);
    assert.ok(['no_token_configured', 'missing_header', 'malformed_header', 'mismatch'].includes(result.reason));
    assert.ok(!result.reason.includes(TOKEN));
  });
});
