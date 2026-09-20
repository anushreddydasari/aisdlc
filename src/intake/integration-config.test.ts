import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { DATABASE_NAME } from '../db/client.ts';
import {
  PRODUCTION_URI_VARIABLES,
  TEST_APP_URI_VARIABLE,
  TEST_DATABASE_VARIABLE,
  TEST_MIGRATION_URI_VARIABLE,
  resolveIntegrationConfig,
} from './integration-config.ts';

const VALID = {
  AISDLC_TEST_MONGODB_URI: 'mongodb+srv://test_app:pw@cluster.example.mongodb.net/?authSource=admin',
  AISDLC_TEST_MONGODB_MIGRATION_URI:
    'mongodb+srv://test_migrator:pw@cluster.example.mongodb.net/?authSource=admin',
  AISDLC_TEST_DATABASE: 'aisdlc_test',
} as const;

/** What a developer's shell looks like with production credentials loaded. */
const PRODUCTION_ENV = {
  AISDLC_MONGODB_URI: 'mongodb+srv://aisdlc_app:pw@cluster.example.mongodb.net/aisdlc?authSource=admin',
  AISDLC_MONGODB_MIGRATION_URI:
    'mongodb+srv://aisdlc_migrator:pw@cluster.example.mongodb.net/aisdlc?authSource=admin',
} as const;

describe('resolveIntegrationConfig', () => {
  it('resolves when all three test variables are set', () => {
    const result = resolveIntegrationConfig(VALID, DATABASE_NAME);
    assert.ok(result.ok);
    assert.equal(result.config.databaseName, 'aisdlc_test');
    assert.equal(result.config.appUri, VALID.AISDLC_TEST_MONGODB_URI);
    assert.equal(result.config.migrationUri, VALID.AISDLC_TEST_MONGODB_MIGRATION_URI);
  });

  for (const variable of [
    TEST_APP_URI_VARIABLE,
    TEST_MIGRATION_URI_VARIABLE,
    TEST_DATABASE_VARIABLE,
  ]) {
    it(`refuses when ${variable} is missing`, () => {
      const result = resolveIntegrationConfig({ ...VALID, [variable]: undefined }, DATABASE_NAME);
      assert.ok(!result.ok);
      assert.match(result.reason, new RegExp(variable));
    });

    it(`treats a blank ${variable} as missing`, () => {
      const result = resolveIntegrationConfig({ ...VALID, [variable]: '   ' }, DATABASE_NAME);
      assert.ok(!result.ok);
      assert.match(result.reason, new RegExp(variable));
    });
  }

  it('names every missing variable at once', () => {
    const result = resolveIntegrationConfig({}, DATABASE_NAME);
    assert.ok(!result.ok);
    for (const v of [TEST_APP_URI_VARIABLE, TEST_MIGRATION_URI_VARIABLE, TEST_DATABASE_VARIABLE]) {
      assert.match(result.reason, new RegExp(v));
    }
  });
});

describe('the production-database guard', () => {
  it('refuses the production database name', () => {
    const result = resolveIntegrationConfig(
      { ...VALID, AISDLC_TEST_DATABASE: DATABASE_NAME },
      DATABASE_NAME,
    );
    assert.ok(!result.ok);
    assert.match(result.reason, /refusing to run/);
  });

  it('refuses a case variant of the production database name', () => {
    // MongoDB names are case-sensitive, but a case-insensitive host is not a
    // reason to let 'AISDLC' through.
    for (const variant of ['AISDLC', 'Aisdlc', 'aiSDLC']) {
      const result = resolveIntegrationConfig(
        { ...VALID, AISDLC_TEST_DATABASE: variant },
        DATABASE_NAME,
      );
      assert.ok(!result.ok, `${variant} was accepted`);
    }
  });

  it('allows a name that merely contains the production name', () => {
    const result = resolveIntegrationConfig(
      { ...VALID, AISDLC_TEST_DATABASE: 'aisdlc_test' },
      DATABASE_NAME,
    );
    assert.ok(result.ok);
  });
});

describe('isolation from production credentials', () => {
  it('refuses even when production credentials are present', () => {
    // The critical case: a developer with a working .env runs the suite
    // without test variables. It must refuse, not silently fall back.
    const result = resolveIntegrationConfig(PRODUCTION_ENV, DATABASE_NAME);
    assert.ok(!result.ok);
    assert.match(result.reason, /AISDLC_TEST_MONGODB_URI/);
  });

  it('ignores production variables entirely when test variables are set', () => {
    const result = resolveIntegrationConfig({ ...PRODUCTION_ENV, ...VALID }, DATABASE_NAME);
    assert.ok(result.ok);
    assert.equal(result.config.appUri, VALID.AISDLC_TEST_MONGODB_URI);
    assert.equal(result.config.migrationUri, VALID.AISDLC_TEST_MONGODB_MIGRATION_URI);
    // Neither production URI reached the resolved config.
    for (const uri of Object.values(PRODUCTION_ENV)) {
      assert.notEqual(result.config.appUri, uri);
      assert.notEqual(result.config.migrationUri, uri);
    }
  });

  /**
   * Strips comments so these checks assert what the code DOES, not what the
   * comments discuss. Both files legitimately name the production variables
   * in prose, explaining that they are deliberately not read.
   */
  function executableSource(fileName: string): string {
    return readFileSync(new URL(`./${fileName}`, import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  }

  it('resolveIntegrationConfig reads no production variable', () => {
    // Static guarantee: if someone adds a fallback later, this fails.
    const source = executableSource('integration-config.ts');
    const body = source.slice(source.indexOf('export function resolveIntegrationConfig'));
    for (const variable of PRODUCTION_URI_VARIABLES) {
      assert.ok(!body.includes(variable), `resolveIntegrationConfig references ${variable}`);
    }
  });

  it('the integration test reads no production variable', () => {
    const source = executableSource('repository.integration.test.ts');
    for (const variable of PRODUCTION_URI_VARIABLES) {
      assert.ok(
        !source.includes(variable),
        `repository.integration.test.ts references ${variable} outside a comment`,
      );
    }
  });

  it('the integration test reads no individual environment variable', () => {
    // It may hand `process.env` wholesale to resolveIntegrationConfig — that
    // is the design. What it must not do is index into it, because that is
    // how a production variable would get read.
    const source = executableSource('repository.integration.test.ts');
    assert.ok(!/process\.env\s*\[/.test(source), 'the integration test indexes into process.env');
    assert.ok(!/process\.env\s*\./.test(source), 'the integration test reads a process.env property');
    assert.ok(
      source.includes('resolveIntegrationConfig(process.env'),
      'the integration test no longer routes configuration through the guard',
    );
  });
});
