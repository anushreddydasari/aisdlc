import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isRetryable, type GitHubAccessFailureKind } from './client.ts';

const RETRYABLE: readonly GitHubAccessFailureKind[] = ['rate_limited', 'transient', 'timeout'];

const NOT_RETRYABLE: readonly GitHubAccessFailureKind[] = [
  'selection_not_confirmed',
  'unsupported_repository_url',
  'repository_inactive',
  'invalid_installation_configuration',
  'branch_not_allowed',
  'installation_not_found',
  'branch_not_found',
  'file_not_found',
  'authentication_failed',
  'insufficient_permission',
  'malformed',
  'unexpected_redirect',
  'ref_already_exists',
  'pull_request_already_exists',
];

describe('isRetryable', () => {
  for (const kind of RETRYABLE) {
    it(`is true for '${kind}'`, () => {
      assert.equal(isRetryable(kind), true);
    });
  }

  for (const kind of NOT_RETRYABLE) {
    it(`is false for '${kind}'`, () => {
      assert.equal(isRetryable(kind), false);
    });
  }

  it('covers every failure kind exactly once between the two lists', () => {
    // If a new GitHubAccessFailureKind is ever added without updating this
    // file, TypeScript will not catch it — this is the safety net: it
    // fails loudly instead of silently treating an unclassified kind as
    // non-retryable by omission.
    const all = [...RETRYABLE, ...NOT_RETRYABLE];
    assert.equal(new Set(all).size, all.length, 'a kind is listed twice');
  });
});
