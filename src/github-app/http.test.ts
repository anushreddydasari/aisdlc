import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyRateLimit, githubRequestHeaders, normalizeBaseUrl, parseRetryAfterMs } from './http.ts';

const NOW = new Date('2026-09-22T00:00:00.000Z');

describe('githubRequestHeaders', () => {
  it('sends the pinned API version, accept header, and user agent', () => {
    const headers = githubRequestHeaders('Bearer secret-value');
    assert.equal(headers['authorization'], 'Bearer secret-value');
    assert.equal(headers['accept'], 'application/vnd.github+json');
    assert.equal(headers['x-github-api-version'], '2022-11-28');
    assert.equal(headers['user-agent'], 'aisdlc-service');
  });
});

describe('normalizeBaseUrl', () => {
  it('strips a trailing slash', () => {
    assert.equal(normalizeBaseUrl('https://api.github.com/'), 'https://api.github.com');
  });

  it('strips multiple trailing slashes', () => {
    assert.equal(normalizeBaseUrl('https://api.github.com///'), 'https://api.github.com');
  });

  it('leaves a URL with no trailing slash unchanged', () => {
    assert.equal(normalizeBaseUrl('https://api.github.com'), 'https://api.github.com');
  });
});

describe('parseRetryAfterMs', () => {
  it('prefers Retry-After (seconds) when present', () => {
    const headers = new Headers({ 'retry-after': '30' });
    assert.equal(parseRetryAfterMs(headers, NOW), 30_000);
  });

  it('falls back to X-RateLimit-Reset when X-RateLimit-Remaining is 0', () => {
    const resetEpochSeconds = Math.floor(NOW.getTime() / 1000) + 45;
    const headers = new Headers({
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(resetEpochSeconds),
    });
    assert.equal(parseRetryAfterMs(headers, NOW), 45_000);
  });

  it('ignores X-RateLimit-Reset when remaining is not exactly "0"', () => {
    const headers = new Headers({ 'x-ratelimit-remaining': '5', 'x-ratelimit-reset': '9999999999' });
    assert.equal(parseRetryAfterMs(headers, NOW), undefined);
  });

  it('returns undefined when no rate-limit header is present at all', () => {
    assert.equal(parseRetryAfterMs(new Headers(), NOW), undefined);
  });

  it('never returns a negative delay, even for a reset time in the past', () => {
    const headers = new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '0' });
    assert.equal(parseRetryAfterMs(headers, NOW), 0);
  });
});

describe('classifyRateLimit', () => {
  it('treats 429 as a rate limit even without a computable retry delay', () => {
    const result = classifyRateLimit(429, new Headers(), NOW);
    assert.deepEqual(result, { limited: true, retryAfterMs: undefined });
  });

  it('treats 429 as a rate limit and surfaces retryAfterMs when present', () => {
    const result = classifyRateLimit(429, new Headers({ 'retry-after': '10' }), NOW);
    assert.deepEqual(result, { limited: true, retryAfterMs: 10_000 });
  });

  it('does NOT treat a bare 403 as a rate limit', () => {
    // The exact bug found and fixed during Stage 2 testing.
    const result = classifyRateLimit(403, new Headers(), NOW);
    assert.deepEqual(result, { limited: false });
  });

  it('treats 403 as a rate limit only when Retry-After is present', () => {
    const result = classifyRateLimit(403, new Headers({ 'retry-after': '5' }), NOW);
    assert.deepEqual(result, { limited: true, retryAfterMs: 5_000 });
  });

  it('treats 403 as a rate limit only when X-RateLimit-Remaining: 0 is present', () => {
    const resetEpochSeconds = Math.floor(NOW.getTime() / 1000) + 20;
    const result = classifyRateLimit(
      403,
      new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetEpochSeconds) }),
      NOW,
    );
    assert.deepEqual(result, { limited: true, retryAfterMs: 20_000 });
  });

  it('does not treat any other status as a rate limit', () => {
    for (const status of [200, 201, 401, 404, 409, 422, 500, 502, 503, 504]) {
      assert.deepEqual(classifyRateLimit(status, new Headers(), NOW), { limited: false }, `status ${status}`);
    }
  });
});
