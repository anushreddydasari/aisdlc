/**
 * Service entrypoint.
 *
 * Order matters: configuration is validated before anything else, so a
 * missing variable is a clean startup failure naming the variable rather than
 * an obscure error later on.
 */

import {
  loadConfig,
  loadNeutaraConfig,
  loadWebhookConfig,
  resolveDatabaseName,
  resolveRuntimeMongoUri,
  ConfigError,
} from './config/env.ts';
import { DATABASE_NAME, createConnectionManager } from './db/client.ts';
import { createAuditLog } from './db/audit-log.ts';
import { createWebhookDeliveryRepository } from './db/webhook-deliveries.ts';
import { createIntakeRepository } from './intake/repository.ts';
import { createNeutaraClient } from './neutara/client.ts';
import { startEnrichmentLoop, type EnrichmentLoop } from './enrichment/scheduler.ts';
import { createLogger } from './logging/logger.ts';
import { createHttpServer } from './api/server.ts';

const VERSION = '0.1.0';

async function main(): Promise<void> {
  const bootLogger = createLogger({ level: 'info' });

  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      // Names the variables, never the values.
      bootLogger.error('startup aborted: invalid configuration', {
        variables: error.variables,
        detail: error.message,
      });
      process.exitCode = 78; // EX_CONFIG
      return;
    }
    throw error;
  }

  const logger = createLogger({
    level: config.nodeEnv === 'production' ? 'info' : 'debug',
    base: { service: 'aisdlc-service', env: config.nodeEnv, version: VERSION },
  });

  // Which database, decided before anything connects. Outside production the
  // override is mandatory, so a local run cannot default into `aisdlc`.
  const target = resolveDatabaseName(process.env, config.nodeEnv, DATABASE_NAME);
  if (!target.ok) {
    logger.error('startup aborted: unsafe database target', { detail: target.reason });
    process.exitCode = 78; // EX_CONFIG
    return;
  }
  // Which credential, decided independently of which database. Outside
  // production this can never be the production identity (`aisdlc_app`),
  // even though AISDLC_DATABASE_NAME already points elsewhere — the two used
  // to be conflated, which is how the service ended up authenticating as
  // aisdlc_app against aisdlc_test and failing at query time instead of here.
  const credential = resolveRuntimeMongoUri(process.env, config.nodeEnv, config.mongodbUri);
  if (!credential.ok) {
    logger.error('startup aborted: unsafe mongodb credential', { detail: credential.reason });
    process.exitCode = 78; // EX_CONFIG
    return;
  }

  logger.info('database target resolved', {
    database: target.databaseName,
    overridden: target.overridden,
    identity: credential.identity,
  });

  // Non-blocking: the server starts serving immediately and reports itself
  // not-ready until the connection lands. A failed first attempt is retried
  // with backoff rather than leaving the instance permanently unready.
  const mongo = createConnectionManager({
    uri: credential.uri,
    logger,
    databaseName: target.databaseName,
  });
  mongo.start();

  const { webhookSecret } = loadWebhookConfig(process.env);
  if (webhookSecret === undefined) {
    // Mounted anyway, answering 401: refusing to start would take the health
    // endpoints down with it, and .env.example specifies refusal per request.
    logger.warn('NEUTARA_WEBHOOK_SECRET is not set; /ingest will reject every request');
  }

  const server = createHttpServer({
    logger,
    health: {
      version: VERSION,
      uptimeSeconds: () => process.uptime(),
      database: mongo,
    },
    ingest: {
      logger,
      webhookSecret,
      // Resolved per request: the connection manager reconnects in the
      // background, so a database that comes back makes /ingest work again
      // without a restart.
      get deliveries() {
        const db = mongo.db();
        return db ? createWebhookDeliveryRepository(db, logger) : undefined;
      },
      get audit() {
        const db = mongo.db();
        return db ? createAuditLog(db, logger) : undefined;
      },
    },
  });

  // Phase 4: drain pending deliveries into intake items. Started only when
  // Neutara is configured — without it there is nothing to enrich with, and
  // a loop that can only fail is worse than no loop.
  let enrichment: EnrichmentLoop | undefined;
  const neutara = loadNeutaraConfig(process.env);
  if (!neutara.configured) {
    logger.warn('enrichment disabled', { detail: neutara.reason });
  } else {
    const client = createNeutaraClient({
      baseUrl: neutara.config.baseUrl,
      token: neutara.config.token,
      logger,
    });
    enrichment = startEnrichmentLoop(
      {
        get deliveries() {
          return createWebhookDeliveryRepository(mongo.db()!, logger);
        },
        get intake() {
          const db = mongo.db()!;
          return createIntakeRepository(db, createAuditLog(db, logger), logger);
        },
        client,
        logger,
      },
      // Skipped while disconnected: a pass then could only produce errors.
      { isReady: () => mongo.db() !== undefined },
    );
  }

  server.listen(config.port, () => {
    logger.info('http server listening', { port: config.port });
  });

  const shutdown = (signal: string): void => {
    logger.info('shutting down', { signal });
    // Stopped before the connection closes, so an in-flight pass is not left
    // reaching for a client that is going away.
    enrichment?.stop();
    server.close(() => {
      void (async () => {
        await mongo.close();
        process.exit(0);
      })();
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

await main();
