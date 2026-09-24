import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { looksLikePemPrivateKey } from '../github-app/config.ts';
import { fingerprint, pemEnvValue, upsertEnvValue } from './configure-github-app.ts';

// Not a real key: the shape only, which is all config.ts checks.
const FAKE_PEM = '-----BEGIN RSA PRIVATE KEY-----\nAAAAfake\nBBBBfake\n-----END RSA PRIVATE KEY-----\n'; // pragma: fixture

/** Mirrors Node's --env-file reading of a double-quoted multi-line value. */
function readBack(env: string, name: string): string | undefined {
  const m = new RegExp(`^${name}=(?:"([\\s\\S]*?)"|(.*))$`, 'm').exec(env);
  return m === null ? undefined : (m[1] ?? m[2]);
}

describe('upsertEnvValue', () => {
  it('replaces an empty existing entry in place and keeps every other line', () => {
    const env = 'A=1\nGITHUB_APP_ID=\nB=2\n';
    assert.equal(upsertEnvValue(env, 'GITHUB_APP_ID', '12345'), 'A=1\nGITHUB_APP_ID=12345\nB=2\n');
  });

  it('appends a missing entry', () => {
    assert.equal(upsertEnvValue('A=1\n', 'GITHUB_APP_ID', '12345'), 'A=1\nGITHUB_APP_ID=12345\n');
  });

  it('replaces an existing multi-line quoted key without leaving any of its old lines', () => {
    const env = `A=1\nGITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nOLD\n-----END RSA PRIVATE KEY-----"\nB=2\n`; // pragma: fixture
    const next = upsertEnvValue(env, 'GITHUB_APP_PRIVATE_KEY', pemEnvValue(FAKE_PEM));
    assert.ok(!next.includes('OLD'));
    assert.ok(next.startsWith('A=1\n'));
    assert.ok(next.endsWith('\nB=2\n'));
  });

  it('is idempotent', () => {
    const once = upsertEnvValue('A=1\n', 'GITHUB_APP_PRIVATE_KEY', pemEnvValue(FAKE_PEM));
    assert.equal(upsertEnvValue(once, 'GITHUB_APP_PRIVATE_KEY', pemEnvValue(FAKE_PEM)), once);
  });
});

describe('pemEnvValue', () => {
  it('produces a value that reads back as a PEM the service accepts', () => {
    const env = upsertEnvValue('A=1\n', 'GITHUB_APP_PRIVATE_KEY', pemEnvValue(FAKE_PEM.replace(/\n/g, '\r\n')));
    const value = readBack(env, 'GITHUB_APP_PRIVATE_KEY')!;
    assert.ok(looksLikePemPrivateKey(value));
    assert.ok(!value.includes('\r'));
  });

  it('refuses content containing a double quote', () => {
    assert.throws(() => pemEnvValue('-----BEGIN RSA PRIVATE KEY-----\n"\n-----END RSA PRIVATE KEY-----')); // pragma: fixture
  });
});

describe('fingerprint', () => {
  it('is short, stable across line endings, and contains no part of the key', () => {
    const f = fingerprint(FAKE_PEM);
    assert.equal(f.length, 12);
    assert.equal(fingerprint(FAKE_PEM.replace(/\n/g, '\r\n')), f);
    assert.ok(!FAKE_PEM.includes(f));
  });
});
