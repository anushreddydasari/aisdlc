/**
 * End-to-end integration test against a real Atlas cluster: the full
 * Repository Registry + Repository Selection workflow, `aisdlc_test` only.
 *
 * SKIPPED unless all three of these are set:
 *   AISDLC_TEST_MONGODB_URI            test application credential
 *   AISDLC_TEST_MONGODB_MIGRATION_URI  test migration credential
 *   AISDLC_TEST_DATABASE               an isolated database name
 *
 * Run with `npm run test:integration`, which loads `.env`. Plain `npm test`
 * does not, so the default suite stays offline. See
 * src/intake/repository.integration.test.ts for the full rationale behind
 * this gate — the same safety discipline applies verbatim here: separate
 * test-only credentials, no fallback to a production variable, a hard
 * refusal if `AISDLC_TEST_DATABASE` resolves to the production database
 * name, and DDL only ever runs over the migration connection, never the
 * application one this test otherwise exercises throughout.
 *
 * NO PRODUCTION SERVICES. This file never imports or calls anything from
 * neutara/, openai/, or GitHub-facing code — repositoryUrl values here are
 * inert strings, never dereferenced over the network. The static checks in
 * src/intake/integration-config.test.ts additionally assert, by scanning
 * this file's source, that it never reads a production Mongo variable.
 *
 * CLEANUP DOES NOT REQUIRE GRANTING `remove` TO THE APPLICATION ROLE.
 * `aisdlcTestAppRole` intentionally grants only `find`/`insert`/`update` on
 * `repositoryRegistry`/`repositorySelections` (see docs/atlas-roles.md) —
 * nothing in the application ever deletes from either collection, so there
 * is no product reason to widen that grant merely so a test can tidy up
 * after itself. Instead:
 *
 *   - If `AISDLC_TEST_CLEANUP_MONGODB_URI` is set, it names a THIRD,
 *     narrower identity — `remove` only, only on the specific test
 *     collections below, never `auditLog` — used solely in `after()` to
 *     delete this run's own `ITEST-`-namespaced rows. See "Optional: a
 *     dedicated test-cleanup credential" in docs/atlas-roles.md for the
 *     exact role to provision.
 *   - If it is not set (the default), `after()` does not attempt to widen
 *     any credential's privileges and does not fail the suite over
 *     leftover data. It reports, by name and count, exactly which
 *     `ITEST-`-namespaced documents from THIS run remain, so nothing is
 *     silently lost track of. Every row is namespaced with a fresh run id
 *     (see `KEY_PREFIX` below), so re-running this file never collides with
 *     rows a previous run left behind — the suite is fully repeatable
 *     whether or not cleanup ever actually deletes anything.
 *
 * A cleanup failure (of either kind above) is reported separately from an
 * application-behavior failure: it never throws out of `after()`, and it
 * can never turn a passing `it()` into a failing one, since no `it()` below
 * deletes anything itself.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ObjectId, type Db } from 'mongodb';

import { DATABASE_NAME, connect, type MongoConnection } from '../db/client.ts';
import { createAuditLog } from '../db/audit-log.ts';
import { COLLECTIONS, type CollectionName } from '../db/collections.ts';
import { initializeDatabase } from '../db/indexes.ts';
import { createLogger } from '../logging/logger.ts';
import { resolveIntegrationConfig } from '../intake/integration-config.ts';
import { createIntakeRepository, type IntakeSnapshot } from '../intake/repository.ts';
import { createRunsRepository } from '../orchestrator/repository.ts';
import { queueApprovedRuns } from '../orchestrator/worker.ts';
import {
  DuplicateActiveMappingError,
  createRepositoryRegistryRepository,
} from '../repository-registry/repository.ts';
import { SelectionConflictError, createRepositorySelectionRepository } from './repository.ts';
import { matchRepositorySelections } from './worker.ts';

const resolved = resolveIntegrationConfig(process.env, DATABASE_NAME);
const config = resolved.ok ? resolved.config : undefined;
const blocked = resolved.ok ? false : resolved.reason;

const logger = createLogger({ write: () => {} });

/** Namespaced so a failed run never collides with other data. */
const RUN_ID = new ObjectId().toHexString().slice(-8);
const KEY_PREFIX = `ITEST-${RUN_ID}-`;
const testKey = (n: number): string => `${KEY_PREFIX}${n}`;

const PROJECT_IDENTIFIER = `${KEY_PREFIX}PROJECT`;
const REPOSITORY_ID = `${KEY_PREFIX}repo`;

const SNAPSHOT: IntakeSnapshot = {
  title: 'Repository selection integration test item',
  description: 'Created by repository-selection/workflow.integration.test.ts',
  issueType: 'task',
  priority: null,
  reporter: null,
  project: PROJECT_IDENTIFIER,
};

/** The only collections this suite ever writes test rows into. Never `auditLog`. */
const TEST_DATA_COLLECTIONS: readonly CollectionName[] = [
  COLLECTIONS.repositoryRegistry,
  COLLECTIONS.repositorySelections,
  COLLECTIONS.runs,
  COLLECTIONS.intakeItems,
];

/** This run's own rows in `collection`, and nothing else. */
function ownRowsFilter(collectionName: CollectionName): Record<string, unknown> {
  if (collectionName === COLLECTIONS.repositoryRegistry) {
    return { repositoryId: { $regex: `^${KEY_PREFIX}` } };
  }
  return { issueKey: { $regex: `^${KEY_PREFIX}` } };
}

describe('repository registry + repository selection against real Atlas', { skip: blocked }, () => {
  /** Application role: data access, no DDL. Every workflow step below uses this connection. */
  let app: MongoConnection | undefined;
  /** Migration role: DDL only, used solely to (re-)apply the schema in `before`. */
  let migration: MongoConnection | undefined;
  /** Optional third identity: `remove` only, only on TEST_DATA_COLLECTIONS. See the module comment above. */
  let cleanup: MongoConnection | undefined;
  let db: Db;

  let registryEntryId: ObjectId;
  let runId: ObjectId;
  const issueKey = testKey(1);

  before(async () => {
    // Second enforcement of the safety check, mirroring the intake suite.
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

    if (config.cleanupUri !== undefined) {
      cleanup = await connect({
        uri: config.cleanupUri,
        logger,
        databaseName: config.databaseName,
        appName: 'aisdlc-integration-cleanup',
      });
      // Verified against the connection actually made, not merely requested —
      // same discipline as the "is not pointed at the production database" check.
      if (cleanup.db.databaseName.toLowerCase() === DATABASE_NAME.toLowerCase()) {
        throw new Error('the cleanup credential resolved to the production database; refusing to use it');
      }
    }
  });

  after(async () => {
    try {
      // Deletes with whichever identity is willing to do them: the dedicated
      // cleanup credential if one was configured, otherwise the application
      // credential on a best-effort basis. Neither path can fail the suite —
      // a cleanup gap is data left behind under a stable, ITEST- namespace
      // that a later run will never collide with, not lost data.
      const deleter = cleanup?.db ?? app?.db;
      const remaining: { collection: CollectionName; count: number }[] = [];

      if (deleter) {
        for (const collectionName of TEST_DATA_COLLECTIONS) {
          const filter = ownRowsFilter(collectionName);
          try {
            await deleter.collection(collectionName).deleteMany(filter);
          } catch (error) {
            logger.warn('integration test cleanup could not delete from a collection', {
              collection: collectionName,
              usingCleanupCredential: cleanup !== undefined,
              error,
            });
          }
        }
      }

      // Report what is actually left, regardless of why — using `find`,
      // which the application credential always has.
      if (app) {
        for (const collectionName of TEST_DATA_COLLECTIONS) {
          const count = await app.db.collection(collectionName).countDocuments(ownRowsFilter(collectionName));
          if (count > 0) remaining.push({ collection: collectionName, count });
        }
      }
      if (remaining.length > 0) {
        logger.warn('integration test data remains in aisdlc_test after cleanup', {
          runPrefix: KEY_PREFIX,
          remaining,
          hint:
            cleanup === undefined
              ? 'no AISDLC_TEST_CLEANUP_MONGODB_URI configured; see docs/atlas-roles.md ' +
                '("Optional: a dedicated test-cleanup credential") to enable automatic cleanup'
              : 'the cleanup credential could not remove these rows; check its grants',
        });
      }
      // auditLog is append-only by design (neither credential can delete from
      // it, and this suite never tries) — entries created below are
      // namespaced ITEST- and stay, same policy as
      // src/intake/repository.integration.test.ts.
    } finally {
      await app?.close().catch(() => {});
      await migration?.close().catch(() => {});
      await cleanup?.close().catch(() => {});
    }
  });

  it('is not pointed at the production database', () => {
    assert.notEqual(config!.databaseName.toLowerCase(), DATABASE_NAME.toLowerCase());
    assert.equal(db.databaseName, config!.databaseName);
    assert.equal(migration!.db.databaseName, config!.databaseName);
  });

  it('the application credential can read repositoryRegistry and repositorySelections', async () => {
    // A direct collection probe, independent of the repository layer below —
    // proves the Atlas `find` grant itself. `insert`/`update` are proven by
    // the substantive workflow tests further down, which is also why this
    // test does not need to write (and then delete) a throwaway document of
    // its own to make the same point twice.
    await assert.doesNotReject(() => db.collection(COLLECTIONS.repositoryRegistry).find({}).limit(1).toArray());
    await assert.doesNotReject(() => db.collection(COLLECTIONS.repositorySelections).find({}).limit(1).toArray());
  });

  it('enforces the repositoryRegistry validator server-side', async () => {
    await assert.rejects(
      () =>
        db.collection(COLLECTIONS.repositoryRegistry).insertOne({
          projectIdentifier: PROJECT_IDENTIFIER,
          repositoryId: `${REPOSITORY_ID}-invalid`,
          repositoryUrl: 'https://github.com/cloudfuze/x',
          defaultBranch: 'main',
          allowedBranches: ['main'],
          status: 'not_a_real_status',
          createdAt: new Date(),
          updatedAt: new Date(),
          createdBy: 'operator:itest',
          updatedBy: 'operator:itest',
        } as never),
      /validation/i,
    );
  });

  it('creates a repository mapping', async () => {
    const audit = createAuditLog(db, logger);
    const registry = createRepositoryRegistryRepository(db, audit, logger);

    const created = await registry.create({
      projectIdentifier: PROJECT_IDENTIFIER,
      repositoryId: REPOSITORY_ID,
      repositoryUrl: 'https://github.com/cloudfuze/aisdlc-service',
      defaultBranch: 'main',
      allowedBranches: ['main', 'feature/*'],
      actor: 'operator:itest',
    });

    assert.ok(created._id instanceof ObjectId);
    assert.equal(created.status, 'active');
    registryEntryId = created._id;
  });

  it('looks up the mapping by id and by active-project', async () => {
    const audit = createAuditLog(db, logger);
    const registry = createRepositoryRegistryRepository(db, audit, logger);

    const byId = await registry.findById(registryEntryId);
    assert.equal(byId?.repositoryId, REPOSITORY_ID);

    const active = await registry.findActiveByProjectIdentifier(PROJECT_IDENTIFIER);
    assert.ok(active.some((e) => e.repositoryId === REPOSITORY_ID));
  });

  it('rejects a duplicate active mapping for the same project and repositoryId', async () => {
    const audit = createAuditLog(db, logger);
    const registry = createRepositoryRegistryRepository(db, audit, logger);

    await assert.rejects(
      () =>
        registry.create({
          projectIdentifier: PROJECT_IDENTIFIER,
          repositoryId: REPOSITORY_ID,
          repositoryUrl: 'https://github.com/cloudfuze/aisdlc-service',
          defaultBranch: 'main',
          allowedBranches: ['main'],
          actor: 'operator:itest',
        }),
      DuplicateActiveMappingError,
    );
  });

  it('an approved intake item flows through orchestrator queueing into a pending repository selection', async () => {
    const audit = createAuditLog(db, logger);
    const intake = createIntakeRepository(db, audit, logger);
    const runs = createRunsRepository(db, logger);

    await intake.create({ issueKey, source: 'manual', snapshot: SNAPSHOT });
    await intake.transition(issueKey, 'pending_approval', { actor: 'svc:itest' });
    await intake.transition(issueKey, 'approved', { actor: 'svc:itest', approvedBy: 'operator:itest' });

    const queueSummary = await queueApprovedRuns({ intake, runs, audit, logger }, 100);
    assert.ok(queueSummary.examined >= 1);

    const run = await runs.findByIntakeItemId((await intake.findByIssueKey(issueKey))!._id!);
    assert.ok(run);
    runId = run!._id!;

    const registry = createRepositoryRegistryRepository(db, audit, logger);
    const selections = createRepositorySelectionRepository(db, audit, logger);

    const matchSummary = await matchRepositorySelections(
      { intake, runs, registry, selections, audit, logger },
      100,
    );
    assert.ok(matchSummary.newlyExamined >= 1);

    const selection = await selections.findByRunId(runId);
    assert.equal(selection?.status, 'pending');
    assert.deepEqual(selection?.candidateRepositoryIds, [REPOSITORY_ID]);
  });

  it('confirms the pending selection as a human operator', async () => {
    const audit = createAuditLog(db, logger);
    const selections = createRepositorySelectionRepository(db, audit, logger);

    const confirmed = await selections.confirm(runId, {
      repositoryId: REPOSITORY_ID,
      repositoryUrl: 'https://github.com/cloudfuze/aisdlc-service',
      defaultBranch: 'main',
      allowedBranches: ['main', 'feature/*'],
      accessPolicy: null,
      confirmedBy: 'operator:itest',
    });

    assert.equal(confirmed.status, 'selected');
    assert.equal(confirmed.selectedRepositoryId, REPOSITORY_ID);
    assert.equal(confirmed.confirmedBy, 'operator:itest');
    assert.ok(confirmed.confirmedAt instanceof Date);
  });

  it('created audit-log entries for the mapping and the confirmation', async () => {
    const audit = createAuditLog(db, logger);

    const registryEntries = await audit.query({ subjectId: registryEntryId });
    assert.ok(
      registryEntries.some((e) => e.action === 'repository-registry.created'),
      'expected a repository-registry.created audit entry',
    );

    const selectionEntries = await audit.query({ 'detail.issueKey': issueKey });
    assert.ok(
      selectionEntries.some((e) => e.action === 'repository-selection.confirmed'),
      'expected a repository-selection.confirmed audit entry',
    );
    // A single candidate resolves straight to `pending` — decision D6 only
    // requires notifying on `failed`/`ambiguous`, so no notification entry
    // should exist for this run.
    assert.ok(
      !selectionEntries.some((e) => e.action === 'repository-selection.notification'),
      'a single-candidate match must not have notified',
    );
  });

  it('rejects a duplicate confirmation once already selected (idempotency guard)', async () => {
    const audit = createAuditLog(db, logger);
    const selections = createRepositorySelectionRepository(db, audit, logger);

    const before = await audit.query({ 'detail.issueKey': issueKey });
    const confirmedCountBefore = before.filter((e) => e.action === 'repository-selection.confirmed').length;

    await assert.rejects(
      () =>
        selections.confirm(runId, {
          repositoryId: REPOSITORY_ID,
          repositoryUrl: 'https://github.com/cloudfuze/aisdlc-service',
          defaultBranch: 'main',
          allowedBranches: ['main'],
          accessPolicy: null,
          confirmedBy: 'operator:someone-else',
        }),
      SelectionConflictError,
    );

    // Re-confirming must not change who confirmed it, nor add a second entry.
    const stillSelected = await selections.findByRunId(runId);
    assert.equal(stillSelected?.confirmedBy, 'operator:itest');

    const after = await audit.query({ 'detail.issueKey': issueKey });
    const confirmedCountAfter = after.filter((e) => e.action === 'repository-selection.confirmed').length;
    assert.equal(confirmedCountAfter, confirmedCountBefore, 'a rejected duplicate confirmation must not audit-log');
  });
});
