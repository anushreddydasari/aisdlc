import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateFileReference, validatePath } from './path-safety.ts';
import type { RepositoryContextFile } from './types.ts';

describe('validatePath', () => {
  it('accepts an ordinary repository-relative path', () => {
    assert.deepEqual(validatePath('src/index.ts'), { ok: true });
    assert.deepEqual(validatePath('README.md'), { ok: true });
    assert.deepEqual(validatePath('src/coding-agent/service.ts'), { ok: true });
  });

  it('rejects an empty or whitespace-only path', () => {
    assert.equal(validatePath('').ok, false);
    assert.equal(validatePath('   ').ok, false);
  });

  it('rejects a path with leading or trailing whitespace', () => {
    const result = validatePath(' src/index.ts');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'invalid_path');
  });

  it('rejects an absolute POSIX path', () => {
    const result = validatePath('/etc/passwd');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'absolute_path');
  });

  it('rejects an absolute Windows path', () => {
    const result = validatePath('C:\\Windows\\System32');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'absolute_path');
  });

  it('rejects path traversal', () => {
    for (const path of ['../secrets.txt', 'src/../../etc/passwd', 'src/../..', '..']) {
      const result = validatePath(path);
      assert.equal(result.ok, false, `${path} should be rejected`);
      assert.equal(result.ok === false && result.reason, 'path_traversal', `${path} should be path_traversal`);
    }
  });

  it('rejects a backslash path separator, without normalizing it', () => {
    const result = validatePath('src\\index.ts');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'invalid_path');
  });

  it('rejects a URL-shaped path', () => {
    const result = validatePath('https://github.com/cloudfuze/aisdlc-service/src/index.ts');
    assert.equal(result.ok, false);
  });

  it('rejects a NUL byte', () => {
    const result = validatePath('src/index.ts\0.exe');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'invalid_path');
  });

  it('rejects characters outside the accepted safe set', () => {
    for (const path of ['src/$(rm -rf).ts', 'src/`whoami`.ts', 'src/file;name.ts', 'src/file|name.ts']) {
      assert.equal(validatePath(path).ok, false, `${path} should be rejected`);
    }
  });

  describe('credential and secret files', () => {
    for (const path of [
      '.env',
      '.env.local',
      'config/.env.production',
      '.git/config',
      'src/.git/HEAD',
      'keys/private.pem',
      'certs/server.key',
      'certs/bundle.p12',
      'certs/bundle.pfx',
      'keystore.jks',
      'id_rsa',
      '.ssh/id_rsa',
      'home/.aws/credentials',
    ]) {
      it(`rejects '${path}' as a credential or secret file`, () => {
        const result = validatePath(path);
        assert.equal(result.ok, false);
        assert.equal(result.ok === false && result.reason, 'credential_or_secret_file');
      });
    }

    it('does not flag an ordinary file merely containing "env" or "key" as a substring', () => {
      assert.deepEqual(validatePath('src/config/environment.ts'), { ok: true });
      assert.deepEqual(validatePath('src/keyboard-shortcuts.ts'), { ok: true });
    });
  });

  describe('unauthorized configuration files', () => {
    for (const path of ['.github/workflows/ci.yml', 'Dockerfile', 'Dockerfile.prod', 'docker-compose.yml', 'infra/docker-compose.prod.yaml']) {
      it(`rejects '${path}' as unauthorized configuration`, () => {
        const result = validatePath(path);
        assert.equal(result.ok, false);
        assert.equal(result.ok === false && result.reason, 'unauthorized_configuration_file');
      });
    }

    it('does not reject an ordinary .github file outside workflows/', () => {
      assert.deepEqual(validatePath('.github/ISSUE_TEMPLATE.md'), { ok: true });
    });
  });

  it('never silently normalizes an unsafe path into a safe one', () => {
    // The contract is refusal, not rewriting — this test exists to make
    // that explicit rather than merely implicit in the other assertions.
    const result = validatePath('../secret.txt');
    assert.equal(result.ok, false);
  });
});

describe('validateFileReference', () => {
  const files: readonly RepositoryContextFile[] = [
    { path: 'src/index.ts', content: 'export {};' },
    { path: 'README.md', content: '# hi' },
  ];

  it('accepts a modify targeting a file already in context', () => {
    assert.deepEqual(validateFileReference('src/index.ts', 'modify', files), { ok: true });
  });

  it('accepts a create targeting a path not yet in context', () => {
    assert.deepEqual(validateFileReference('src/new-file.ts', 'create', files), { ok: true });
  });

  it('rejects a modify targeting a file not in context', () => {
    const result = validateFileReference('src/missing.ts', 'modify', files);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'modify_target_not_in_context');
  });

  it('rejects a create targeting a file already in context', () => {
    const result = validateFileReference('src/index.ts', 'create', files);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'create_target_already_exists');
  });

  it('rejects an invalid operation value', () => {
    const result = validateFileReference('src/index.ts', 'delete' as never, files);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'invalid_operation');
  });

  it('rejects an unsafe path before checking create/modify semantics', () => {
    const result = validateFileReference('../secret.txt', 'create', files);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'path_traversal');
  });
});
