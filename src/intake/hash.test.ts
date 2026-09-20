import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { canonicalize, contentHash } from './hash.ts';

describe('canonicalize', () => {
  it('sorts object keys, so insertion order cannot change the digest', () => {
    // The whole point: JSON.stringify would produce two different strings here.
    assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
    assert.equal(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');
  });

  it('sorts nested keys too', () => {
    assert.equal(
      canonicalize({ outer: { z: 1, a: 2 } }),
      canonicalize({ outer: { a: 2, z: 1 } }),
    );
  });

  it('preserves array order, because order is content for a list', () => {
    assert.notEqual(canonicalize([1, 2]), canonicalize([2, 1]));
  });

  it('omits undefined properties, matching JSON semantics', () => {
    assert.equal(canonicalize({ a: 1, b: undefined }), '{"a":1}');
  });

  it('keeps null, and distinguishes it from an absent key', () => {
    assert.notEqual(canonicalize({ a: null }), canonicalize({}));
    assert.equal(canonicalize({ a: null }), '{"a":null}');
  });

  it('renders dates as ISO strings', () => {
    assert.equal(canonicalize(new Date('2026-09-20T00:00:00.000Z')), '"2026-09-20T00:00:00.000Z"');
  });

  it('handles the primitives', () => {
    assert.equal(canonicalize('x'), '"x"');
    assert.equal(canonicalize(42), '42');
    assert.equal(canonicalize(true), 'true');
    assert.equal(canonicalize(null), 'null');
  });

  it('escapes strings, so punctuation cannot forge structure', () => {
    // Without escaping, a title containing a quote could make two different
    // snapshots serialize identically.
    assert.notEqual(canonicalize({ a: 'x","b":"y' }), canonicalize({ a: 'x', b: 'y' }));
  });

  it('refuses non-finite numbers rather than collapsing them to null', () => {
    assert.throws(() => canonicalize({ a: Number.NaN }), /non-finite/);
    assert.throws(() => canonicalize({ a: Number.POSITIVE_INFINITY }), /non-finite/);
  });

  it('refuses values it cannot represent', () => {
    assert.throws(() => canonicalize({ fn: () => {} }), /cannot canonicalize/);
  });
});

describe('contentHash', () => {
  it('is stable across key order', () => {
    assert.equal(contentHash({ a: 1, b: 2 }), contentHash({ b: 2, a: 1 }));
  });

  it('changes when any content changes', () => {
    assert.notEqual(contentHash({ title: 'a' }), contentHash({ title: 'b' }));
  });

  it('returns lowercase hex sha256', () => {
    assert.match(contentHash({ a: 1 }), /^[0-9a-f]{64}$/);
  });

  it('is deterministic across calls', () => {
    const value = { title: 'Fix login', description: 'It breaks', issueType: 'bug' };
    assert.equal(contentHash(value), contentHash(value));
  });
});
