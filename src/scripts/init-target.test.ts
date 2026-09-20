import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DATABASE_NAME } from '../db/client.ts';
import { PRODUCTION_FLAG, TEST_FLAG, resolveInitTarget } from './init-target.ts';

const TEST_ENV = {
  AISDLC_TEST_MONGODB_URI: 'mongodb+srv://test_app:pw@cluster.example.mongodb.net/?authSource=admin',
  AISDLC_TEST_MONGODB_MIGRATION_URI:
    'mongodb+srv://test_migrator:pw@cluster.example.mongodb.net/?authSource=admin',
  AISDLC_TEST_DATABASE: 'aisdlc_test',
} as const;

const PRODUCTION_ENV = {
  AISDLC_MONGODB_URI: 'mongodb+srv://aisdlc_app:pw@cluster.example.mongodb.net/aisdlc?authSource=admin',
  AISDLC_MONGODB_MIGRATION_URI:
    'mongodb+srv://aisdlc_migrator:pw@cluster.example.mongodb.net/aisdlc?authSource=admin',
} as const;

const BOTH = { ...TEST_ENV, ...PRODUCTION_ENV };

describe('target selection', () => {
  it('refuses when no target is named', () => {
    // The central property: a forgotten flag must not reach production.
    const result = resolveInitTarget([], BOTH, DATABASE_NAME);
    assert.ok(!result.ok);
    assert.match(result.reason, /specify a target/);
    assert.match(result.reason, /must not initialise production/);
  });

  it('refuses when both targets are named', () => {
    const result = resolveInitTarget([TEST_FLAG, PRODUCTION_FLAG], BOTH, DATABASE_NAME);
    assert.ok(!result.ok);
    assert.match(result.reason, /mutually exclusive/);
  });

  it('refuses an unrecognised argument rather than ignoring it', () => {
    // `--prod` is not `--production`; silently treating it as "no flag" would
    // be defensible, but naming the typo is better than a confusing refusal.
    const result = resolveInitTarget(['--prod'], BOTH, DATABASE_NAME);
    assert.ok(!result.ok);
    assert.match(result.reason, /unrecognised argument/);
  });

  it('ignores empty arguments', () => {
    const result = resolveInitTarget(['', TEST_FLAG, '  '], BOTH, DATABASE_NAME);
    assert.ok(result.ok);
  });
});

describe('the test target', () => {
  it('resolves the test migration user and database', () => {
    const result = resolveInitTarget([TEST_FLAG], BOTH, DATABASE_NAME);
    assert.ok(result.ok);
    assert.equal(result.target.kind, 'test');
    assert.equal(result.target.databaseName, 'aisdlc_test');
    assert.equal(result.target.uri, TEST_ENV.AISDLC_TEST_MONGODB_MIGRATION_URI);
  });

  it('never resolves to the production database', () => {
    const result = resolveInitTarget([TEST_FLAG], BOTH, DATABASE_NAME);
    assert.ok(result.ok);
    assert.notEqual(result.target.databaseName, DATABASE_NAME);
  });

  it('never resolves to a production credential', () => {
    const result = resolveInitTarget([TEST_FLAG], BOTH, DATABASE_NAME);
    assert.ok(result.ok);
    assert.notEqual(result.target.uri, PRODUCTION_ENV.AISDLC_MONGODB_MIGRATION_URI);
    assert.notEqual(result.target.uri, PRODUCTION_ENV.AISDLC_MONGODB_URI);
  });

  it('inherits the production-database guard', () => {
    const result = resolveInitTarget(
      [TEST_FLAG],
      { ...BOTH, AISDLC_TEST_DATABASE: DATABASE_NAME },
      DATABASE_NAME,
    );
    assert.ok(!result.ok);
    assert.match(result.reason, /refusing to run/);
  });

  it('inherits the case-insensitive form of that guard', () => {
    const result = resolveInitTarget(
      [TEST_FLAG],
      { ...BOTH, AISDLC_TEST_DATABASE: 'AISDLC' },
      DATABASE_NAME,
    );
    assert.ok(!result.ok);
  });

  it('refuses when the test variables are missing', () => {
    const result = resolveInitTarget([TEST_FLAG], PRODUCTION_ENV, DATABASE_NAME);
    assert.ok(!result.ok);
    assert.match(result.reason, /AISDLC_TEST_MONGODB_URI/);
  });

  it('refuses a production connection string pasted into the test variable', () => {
    // The guard on the database name cannot catch this: the name would be
    // `aisdlc_test`, but the credential would be the production migrator.
    const result = resolveInitTarget(
      [TEST_FLAG],
      { ...BOTH, AISDLC_TEST_MONGODB_MIGRATION_URI: PRODUCTION_ENV.AISDLC_MONGODB_MIGRATION_URI },
      DATABASE_NAME,
    );
    assert.ok(!result.ok);
    assert.match(result.reason, /identical to AISDLC_MONGODB_MIGRATION_URI/);
  });

  it('does not require production variables to be present', () => {
    // A machine with only test credentials must still be able to init test.
    const result = resolveInitTarget([TEST_FLAG], TEST_ENV, DATABASE_NAME);
    assert.ok(result.ok);
    assert.equal(result.target.databaseName, 'aisdlc_test');
  });
});

describe('the production target', () => {
  it('resolves the production migration user and database', () => {
    const result = resolveInitTarget([PRODUCTION_FLAG], BOTH, DATABASE_NAME);
    assert.ok(result.ok);
    assert.equal(result.target.kind, 'production');
    assert.equal(result.target.databaseName, DATABASE_NAME);
    assert.equal(result.target.uri, PRODUCTION_ENV.AISDLC_MONGODB_MIGRATION_URI);
  });

  it('requires it to be asked for explicitly', () => {
    // Production is reachable only by naming it. No argument, no production.
    assert.ok(!resolveInitTarget([], PRODUCTION_ENV, DATABASE_NAME).ok);
    assert.ok(!resolveInitTarget([TEST_FLAG], BOTH, DATABASE_NAME).ok === false);
  });

  it('refuses when the production migration URI is missing', () => {
    const result = resolveInitTarget([PRODUCTION_FLAG], TEST_ENV, DATABASE_NAME);
    assert.ok(!result.ok);
    assert.match(result.reason, /AISDLC_MONGODB_MIGRATION_URI/);
  });

  it('refuses when both production URIs are identical', () => {
    const shared = {
      AISDLC_MONGODB_URI: PRODUCTION_ENV.AISDLC_MONGODB_MIGRATION_URI,
      AISDLC_MONGODB_MIGRATION_URI: PRODUCTION_ENV.AISDLC_MONGODB_MIGRATION_URI,
    };
    const result = resolveInitTarget([PRODUCTION_FLAG], shared, DATABASE_NAME);
    assert.ok(!result.ok);
    assert.match(result.reason, /identical/);
  });

  it('does not leak a credential into the refusal reason', () => {
    const result = resolveInitTarget(
      [PRODUCTION_FLAG],
      { AISDLC_MONGODB_MIGRATION_URI: 'postgres://user:hunter2@host/db' },
      DATABASE_NAME,
    );
    assert.ok(!result.ok);
    assert.ok(!result.reason.includes('hunter2'));
  });
});
