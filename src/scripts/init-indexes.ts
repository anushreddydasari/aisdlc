/**
 * One-off collection, index and validator setup.
 *
 *   npm run db:init:test         → the AISDLC_TEST_* configuration
 *   npm run db:init:production   → the production migration user
 *
 * A target must be named. `npm run db:init` with no flag refuses and prints
 * guidance, because a forgotten flag must never default to production.
 *
 * Safe to re-run: every step is idempotent, and an index whose definition
 * changed is reconciled rather than failing the run.
 */

import { DATABASE_NAME, connect } from '../db/client.ts';
import { initializeDatabase } from '../db/indexes.ts';
import { createLogger } from '../logging/logger.ts';
import { resolveInitTarget } from './init-target.ts';

const logger = createLogger({ level: 'debug', base: { task: 'db:init' } });

const resolved = resolveInitTarget(process.argv.slice(2), process.env, DATABASE_NAME);
if (!resolved.ok) {
  logger.error('cannot run setup', { detail: resolved.reason });
  process.exit(78); // EX_CONFIG
}

const { kind, uri, databaseName } = resolved.target;

// Stated plainly before connecting, so a production run is never a surprise
// discovered afterwards in the logs.
logger.info('initializing database', { target: kind, database: databaseName });

const mongo = await connect({ uri, logger, databaseName, appName: `aisdlc-db-init-${kind}` });
try {
  const result = await initializeDatabase(mongo.db, logger);
  logger.info('setup complete', {
    target: kind,
    database: databaseName,
    collectionsCreated: result.collectionsCreated.length,
    indexesEnsured: result.indexesEnsured,
    indexesRecreated: result.indexesRecreated,
    indexesTtlUpdated: result.indexesTtlUpdated,
  });
} finally {
  await mongo.close();
}
