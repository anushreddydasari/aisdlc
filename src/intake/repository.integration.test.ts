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
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { ObjectId, type Db } from 'mongodb';

import { createHttpServer } from '../api/server.ts';
import { buildSignatureHeader } from '../api/signature.ts';

import { DATABASE_NAME, connect, type MongoConnection } from '../db/client.ts';
import {
  createAuditLog,
  guardAuditCollection,
  AuditLogMutationError,
  type AuditEntryDocument,
} from '../db/audit-log.ts';
import { COLLECTIONS } from '../db/collections.ts';
import { createWebhookDeliveryRepository } from '../db/webhook-deliveries.ts';
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

/** Deterministic so `after()` can clean up exactly what the tests created. */
const DELIVERY_NAMES = ['accepted', 'dupe', 'invalid'] as const;
const deliveryKey = (name: (typeof DELIVERY_NAMES)[number]): string =>
  createHash('sha256').update(`${KEY_PREFIX}${name}`).digest('hex');

/**
 * Delivery ids a test cannot precompute, because they are the hash of a body
 * built at run time. Registered here so cleanup still removes exactly what
 * was created rather than guessing with a prefix match.
 */
const runtimeDeliveryIds: string[] = [];

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
        await app.db
          .collection(COLLECTIONS.webhookDeliveries)
          .deleteMany({
            deliveryId: { $in: [...DELIVERY_NAMES.map(deliveryKey), ...runtimeDeliveryIds] },
          });
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

  it('accepts a webhook delivery and queues it as pending', async () => {
    const deliveries = createWebhookDeliveryRepository(db, logger);
    const deliveryId = deliveryKey('accepted');

    const result = await deliveries.record({
      deliveryId,
      status: 'pending',
      event: 'issue.created',
      issueKey: testKey(10),
      eventTimestamp: new Date(),
      payload: { event: 'issue.created', issue: { key: testKey(10) } },
    });
    assert.ok(result.recorded);

    const stored = await deliveries.findByDeliveryId(deliveryId);
    assert.equal(stored?.status, 'pending');
    assert.equal(stored?.intakeItemId, null, 'Phase 3 must not create an intake item');
  });

  it('rejects a duplicate delivery at the unique index', async () => {
    const deliveries = createWebhookDeliveryRepository(db, logger);
    const deliveryId = deliveryKey('dupe');

    const first = await deliveries.record({ deliveryId, status: 'pending', issueKey: testKey(11) });
    const second = await deliveries.record({ deliveryId, status: 'pending', issueKey: testKey(11) });

    assert.ok(first.recorded);
    assert.ok(!second.recorded);
    assert.equal(second.id.toString(), first.id.toString());
  });

  it('stores an unparseable delivery with null event and payload', async () => {
    // The signature proved Neutara sent it, so it is recorded as evidence
    // even though nothing could be parsed out of it.
    const deliveries = createWebhookDeliveryRepository(db, logger);
    const deliveryId = deliveryKey('invalid');

    await deliveries.record({ deliveryId, status: 'invalid', invalidReason: 'malformed_json' });
    const stored = await deliveries.findByDeliveryId(deliveryId);

    assert.equal(stored?.status, 'invalid');
    assert.equal(stored?.event, null);
    assert.equal(stored?.payload, null);
  });

  it('enforces the webhookDeliveries validator server-side', async () => {
    // Bypasses the repository: the vocabulary must hold for any writer with
    // the app credential, not only for callers going through our code.
    await assert.rejects(
      () =>
        db.collection(COLLECTIONS.webhookDeliveries).insertOne({
          deliveryId: 'not-a-sha256',
          status: 'pending',
          attempts: 0,
          maxAttempts: 5,
          nextAttemptAt: new Date(),
          receivedAt: new Date(),
        } as never),
      /validation/i,
      'the server accepted a malformed deliveryId',
    );

    await assert.rejects(
      () =>
        db.collection(COLLECTIONS.webhookDeliveries).insertOne({
          deliveryId: 'c'.repeat(64),
          status: 'not_a_real_status',
          attempts: 0,
          maxAttempts: 5,
          nextAttemptAt: new Date(),
          receivedAt: new Date(),
        } as never),
      /validation/i,
      'the server accepted an unknown delivery status',
    );
  });

  it('accepts a real signed POST to /ingest end to end', async () => {
    // The one seam nothing else covers: a real server, a real socket, a real
    // signature computed over the exact bytes sent, and a real row in Atlas.
    // Every other webhook test stops at either side of the HTTP boundary.
    const secret = `whsec_itest_${RUN_ID}`;
    const deliveries = createWebhookDeliveryRepository(db, logger);

    const server = createHttpServer({
      logger,
      health: { version: '0.0.0', uptimeSeconds: () => 0, database: undefined },
      ingest: { logger, webhookSecret: secret, deliveries, audit: createAuditLog(db, logger) },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const { port } = server.address() as AddressInfo;
      const issueKey = testKey(20);

      // Serialised once: the signature covers these exact bytes, and fetch
      // sends the same string unchanged.
      const body = JSON.stringify({
        event: 'issue.created',
        timestamp: new Date().toISOString(),
        issue: {
          key: issueKey,
          summary: 'End-to-end ingest test',
          type: 'task',
          priority: 'low',
          spaceKey: 'ITEST',
          url: `https://neutara.example.com/browse/${issueKey}`,
        },
      });
      const raw = Buffer.from(body, 'utf8');
      const deliveryId = createHash('sha256').update(raw).digest('hex');
      runtimeDeliveryIds.push(deliveryId);

      const response = await fetch(`http://127.0.0.1:${port}/ingest`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-neutara-signature': buildSignatureHeader(secret, raw),
        },
        body,
      });

      assert.equal(response.status, 202);
      const json = (await response.json()) as Record<string, unknown>;
      assert.equal(json['status'], 'accepted');
      assert.equal(json['deliveryId'], deliveryId);
      assert.equal(json['issueKey'], issueKey);

      const stored = await deliveries.findByDeliveryId(deliveryId);
      assert.ok(stored, 'the delivery was not persisted');
      assert.equal(stored.deliveryId, deliveryId);
      assert.equal(stored.issueKey, issueKey);
      assert.equal(stored.event, 'issue.created');
      assert.equal(stored.status, 'pending');
      assert.equal(stored.intakeItemId, null);

      // Phase 3 queues; it does not create intake items.
      const intake = await db.collection(COLLECTIONS.intakeItems).findOne({ issueKey });
      assert.equal(intake, null, 'Phase 3 created an intake item');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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
