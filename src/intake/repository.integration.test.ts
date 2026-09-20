/**
 * Integration tests against a real Atlas cluster.
 *
 * SKIPPED unless all three of these are set:
 *   AISDLC_TEST_MONGODB_URI            test application credential
 *   AISDLC_TEST_MONGODB_MIGRATION_URI  test migration credential
 *   AISDLC_TEST_DATABASE               an isolated database name
 *
 * Run with `npm run test:integration`, which loads `.env`. Plain `npm test`
 * does not, so the default suite stays offline.
 *
 * SEPARATE CREDENTIALS. This file reads no production variable — not
 * `AISDLC_MONGODB_URI`, not `AISDLC_MONGODB_MIGRATION_URI` — and there is no
 * fallback to one. A test run cannot authenticate as `aisdlc_app` or
 * `aisdlc_migrator` even by accident. Two offline tests in
 * integration-config.test.ts assert that statically, so a fallback added
 * later fails the build rather than quietly reaching production.
 *
 * HARD SAFETY CHECK. These tests create, mutate and delete documents. They
 * refuse to run against the production database: `AISDLC_TEST_DATABASE` must
 * be set explicitly and must differ from `DATABASE_NAME`, case-insensitively.
 * The check is enforced twice, in the skip gate and again in `before()`, so
 * editing one does not quietly disable it.
 *
 * There is also a natural backstop. The production roles are scoped to
 * `{ db: "aisdlc" }`, so pasting a production connection string into a test
 * variable fails immediately with `not allowed to do action [listCollections]
 * on [aisdlc_test.]` rather than doing damage.
 *
 * TWO CONNECTIONS, ON PURPOSE. Schema setup runs over the MIGRATION
 * connection and everything else over the APPLICATION connection, exactly as
 * production does. An earlier version ran `initializeDatabase()` over the app
 * connection and every test failed in the hook with
 * `user is not allowed to do action [createIndex]` — the privilege separation
 * working correctly, not a fault. Keeping them distinct means the suite also
 * proves that separation holds.
 *
 * AUDIT RECORDS ARE NOT CLEANED UP. `auditLog` grants `find`+`insert` to the
 * app role and DDL-only to the migrator, so neither credential can delete an
 * audit entry — which is the point of the collection. Entries written here
 * are namespaced `ITEST-<runId>-*` and remain. Do not add a cleanup step for
 * them; it cannot work, and it should not.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ObjectId, type Db } from 'mongodb';

import { DATABASE_NAME, connect, type MongoConnection } from '../db/client.ts';
import {
  createAuditLog,
  guardAuditCollection,
  AuditLogMutationError,
  type AuditEntryDocument,
} from '../db/audit-log.ts';
import { COLLECTIONS } from '../db/collections.ts';
import { initializeDatabase } from '../db/indexes.ts';
import { createLogger } from '../logging/logger.ts';
import { resolveIntegrationConfig } from './integration-config.ts';
import {
  ApprovalRequiresOperatorError,
  createIntakeRepository,
  type IntakeSnapshot,
} from './repository.ts';

const resolved = resolveIntegrationConfig(process.env, DATABASE_NAME);
const config = resolved.ok ? resolved.config : undefined;
const blocked = resolved.ok ? false : resolved.reason;

const logger = createLogger({ write: () => {} });

/** Namespaced so a failed run never collides with other data. */
const RUN_ID = new ObjectId().toHexString().slice(-8);
const KEY_PREFIX = `ITEST-${RUN_ID}-`;
const testKey = (n: number): string => `${KEY_PREFIX}${n}`;

const SNAPSHOT: IntakeSnapshot = {
  title: 'Integration test item',
  description: 'Created by repository.integration.test.ts',
  issueType: 'task',
  priority: null,
  reporter: null,
  project: 'ITEST',
};

describe('intake repository against real Atlas', { skip: blocked }, () => {
  /** Application role: data access, no DDL. */
  let app: MongoConnection | undefined;
  /** Migration role: DDL only, no data writes. */
  let migration: MongoConnection | undefined;
  let db: Db;

  before(async () => {
    // Second enforcement of the safety check. The skip gate above should have
    // caught this; if someone edits that logic, this still stops the run.
    if (config === undefined || config.databaseName.toLowerCase() === DATABASE_NAME.toLowerCase()) {
      throw new Error(
        `refusing to run integration tests against '${config?.databaseName ?? '(unset)'}'; ` +
          `AISDLC_TEST_DATABASE must be set and must not be '${DATABASE_NAME}'`,
      );
    }

    migration = await connect({
      uri: config.migrationUri,
      logger,
      databaseName: config.databaseName,
      appName: 'aisdlc-integration-migrate',
    });
    await initializeDatabase(migration.db, logger);

    app = await connect({
      uri: config.appUri,
      logger,
      databaseName: config.databaseName,
      appName: 'aisdlc-integration-test',
    });
    db = app.db;
  });

  after(async () => {
    try {
      if (app) {
        await app.db
          .collection(COLLECTIONS.intakeItems)
          .deleteMany({ issueKey: { $regex: `^${KEY_PREFIX}` } });
      }
    } finally {
      // Always close both, even if cleanup threw. Skipping this leaves an
      // open MongoClient holding the event loop and the run never exits.
      await app?.close().catch(() => {});
      await migration?.close().catch(() => {});
    }
  });

  it('is not pointed at the production database', () => {
    assert.notEqual(config!.databaseName.toLowerCase(), DATABASE_NAME.toLowerCase());
    // What the connection actually resolved to, not merely what was requested.
    assert.equal(db.databaseName, config!.databaseName);
    assert.equal(migration!.db.databaseName, config!.databaseName);
  });

  it('reaches the cluster on both connections', async () => {
    assert.equal(await app!.ping(), true, 'application connection');
    assert.equal(await migration!.ping(), true, 'migration connection');
  });

  it('created every collection with its indexes', async () => {
    const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
    for (const expected of Object.values(COLLECTIONS)) {
      assert.ok(names.includes(expected), `${expected} was not created`);
    }
    const indexes = await db.collection(COLLECTIONS.intakeItems).listIndexes().toArray();
    assert.ok(indexes.some((i) => i['name'] === 'issueKey_unique'));
  });

  it('is idempotent when initialization is re-run', async () => {
    const result = await initializeDatabase(migration!.db, logger);
    assert.deepEqual(result.collectionsCreated, []);
    assert.equal(result.indexesRecreated, 0);
    assert.equal(result.indexesTtlUpdated, 0);
  });

  it('refuses schema changes over the application connection', async () => {
    await assert.rejects(
      () =>
        db
          .collection(COLLECTIONS.webhookDeliveries)
          .createIndex({ probe: 1 }, { name: 'itest_probe' }),
      /not allowed to do action|Unauthorized/i,
    );
  });

  it('creates and transitions an intake item', async () => {
    const audit = createAuditLog(db, logger);
    const repo = createIntakeRepository(db, audit, logger);
    const issueKey = testKey(1);

    const created = await repo.create({ issueKey, source: 'manual', snapshot: SNAPSHOT });
    assert.ok(created.created);

    await repo.transition(issueKey, 'pending_approval', { actor: 'svc:itest' });
    const approved = await repo.transition(issueKey, 'approved', {
      actor: 'svc:itest',
      approvedBy: 'operator:itest',
    });
    assert.equal(approved.status, 'approved');
    assert.equal(approved.approvedBy, 'operator:itest');

    const entries = await audit.query({ 'detail.issueKey': issueKey });
    assert.equal(entries.length, 3, 'expected received + pending_approval + approved');
  });

  it('rejects a duplicate issueKey at the unique index', async () => {
    const audit = createAuditLog(db, logger);
    const repo = createIntakeRepository(db, audit, logger);
    const issueKey = testKey(2);

    const first = await repo.create({ issueKey, source: 'manual', snapshot: SNAPSHOT });
    const second = await repo.create({ issueKey, source: 'manual', snapshot: SNAPSHOT });

    assert.ok(!second.created);
    assert.equal(second.id.toString(), first.id.toString());
  });

  it('refuses a service identity as approver in application code', async () => {
    const repo = createIntakeRepository(db, createAuditLog(db, logger), logger);
    const issueKey = testKey(6);
    await repo.create({ issueKey, source: 'manual', snapshot: SNAPSHOT });
    await repo.transition(issueKey, 'pending_approval', { actor: 'svc:itest' });

    await assert.rejects(
      () => repo.transition(issueKey, 'approved', { actor: 'svc:worker', approvedBy: 'svc:worker' }),
      ApprovalRequiresOperatorError,
    );
  });

  it('THE DATABASE refuses a self-approved item, not just our code', async () => {
    // Bypasses the repository entirely: the approval rule must hold for any
    // writer holding the app credential, not only for callers going through
    // createIntakeRepository().
    await assert.rejects(
      () =>
        db.collection(COLLECTIONS.intakeItems).insertOne({
          issueKey: testKey(7),
          source: 'manual',
          snapshot: SNAPSHOT,
          sourceHash: 'x',
          status: 'approved',
          approvedBy: 'svc:worker', // not an operator
          approvedAt: new Date(),
          receivedAt: new Date(),
          createdAt: new Date(),
        } as never),
      /validation/i,
      'the server accepted a service-approved item',
    );
  });

  it('the database accepts an operator-approved item', async () => {
    // The other half: the rule must not reject legitimate approvals.
    const result = await db.collection(COLLECTIONS.intakeItems).insertOne({
      issueKey: testKey(8),
      source: 'manual',
      snapshot: SNAPSHOT,
      sourceHash: 'x',
      status: 'approved',
      approvedBy: 'operator:itest',
      approvedAt: new Date(),
      receivedAt: new Date(),
      createdAt: new Date(),
    } as never);
    assert.ok(result.insertedId);
  });

  it('enforces the intakeItems validator server-side', async () => {
    await assert.rejects(
      () =>
        db.collection(COLLECTIONS.intakeItems).insertOne({
          issueKey: testKey(3),
          source: 'manual',
          snapshot: SNAPSHOT,
          sourceHash: 'x',
          status: 'not_a_real_status',
          receivedAt: new Date(),
          createdAt: new Date(),
        } as never),
      /validation/i,
    );
  });

  it('enforces the auditLog validator server-side', async () => {
    await assert.rejects(
      () =>
        db.collection(COLLECTIONS.auditLog).insertOne({
          occurredAt: new Date(),
          actor: 'itest',
          action: 'bogus',
          subjectType: 'notASubject',
          subjectId: new ObjectId(),
        } as never),
      /validation/i,
    );
  });

  it('blocks audit mutation in application code', async () => {
    const guarded = guardAuditCollection(db.collection<AuditEntryDocument>(COLLECTIONS.auditLog));
    assert.throws(() => guarded.deleteMany({}), AuditLogMutationError);
    assert.throws(() => guarded.updateOne({}, {}), AuditLogMutationError);
  });

  it('the DATABASE refuses audit mutation, not just our code', async () => {
    const id = await createAuditLog(db, logger).append({
      actor: 'itest',
      action: 'itest.tamper_probe',
      subjectType: 'intakeItem',
      subjectId: new ObjectId(),
      detail: { issueKey: testKey(5) },
    });

    const raw = db.collection(COLLECTIONS.auditLog);
    await assert.rejects(
      () => raw.updateOne({ _id: id }, { $set: { actor: 'someone-else' } }),
      /not allowed to do action|Unauthorized/i,
      'the server permitted an audit update — the append-only guarantee is gone',
    );
    await assert.rejects(
      () => raw.deleteOne({ _id: id }),
      /not allowed to do action|Unauthorized/i,
      'the server permitted an audit delete — the append-only guarantee is gone',
    );
  });
});
