/**
 * MongoDB Atlas connection.
 *
 * Importing this module opens nothing. A client is constructed only when
 * `connect()` or `createConnectionManager().start()` is called, so tests,
 * type-checks and a `--help` run never touch the network.
 *
 * Two entry points, because the two callers want opposite failure behaviour:
 *
 *   connect()                 fail fast — used by the one-off setup script,
 *                             where a bad credential should stop the run.
 *   createConnectionManager() keep trying — used by the service, where a
 *                             transient Atlas blip at boot must not leave the
 *                             process permanently unready.
 */

import { MongoClient, type Db, type MongoClientOptions } from 'mongodb';

import type { Logger } from '../logging/logger.ts';
import { redactUri } from '../logging/logger.ts';

/**
 * The production database. The URI supplies the cluster, not the database.
 *
 * Overridable per-connection via `ConnectOptions.databaseName`, which exists
 * so integration tests can target an isolated database. Deliberately NOT
 * driven by an environment variable: a misconfigured or unset variable would
 * silently fall back to production, and the point of the override is to make
 * "wrong target" a loud failure rather than a quiet one.
 */
export const DATABASE_NAME = 'aisdlc';

/**
 * Readiness probes are usually killed after 1–5 seconds, so a ping must fail
 * well inside that. Without its own bound it would inherit
 * serverSelectionTimeoutMS and could block for ten.
 */
export const DEFAULT_PING_TIMEOUT_MS = 2_000;

export interface MongoConnection {
  readonly client: MongoClient;
  readonly db: Db;
  /** Round-trips a ping under a bounded timeout. Returns false, never throws. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export interface ConnectOptions {
  readonly uri: string;
  readonly logger: Logger;
  /** Fail fast on a bad URI or an IP not on the Atlas allowlist. */
  readonly serverSelectionTimeoutMs?: number;
  readonly pingTimeoutMs?: number;
  readonly appName?: string;
  /** Defaults to DATABASE_NAME. Set by integration tests only. */
  readonly databaseName?: string;
}

export function buildClientOptions(options: ConnectOptions): MongoClientOptions {
  return {
    appName: options.appName ?? 'aisdlc-service',
    serverSelectionTimeoutMS: options.serverSelectionTimeoutMs ?? 10_000,
    // Atlas requires TLS; state it rather than relying on the URI to carry it.
    tls: true,
    retryWrites: true,
    // Small pool: this service is request-light and runs beside other tenants.
    maxPoolSize: 10,
    minPoolSize: 0,
  };
}

/**
 * Resolves to `fallback` if `promise` has not settled within `ms`.
 *
 * `promise` must already handle its own rejection, or a late failure becomes
 * an unhandled rejection after the race is over.
 */
export async function withTimeout<T, F>(promise: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<F>((resolve) => {
    // Deliberately NOT unref'd. This timer is the only thing guaranteeing the
    // returned promise settles; unref'ing it means that when the raced promise
    // hangs and nothing else keeps the loop alive, the timeout never fires and
    // the await never returns. The `finally` below clears it, so it cannot leak.
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise, expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function connect(options: ConnectOptions): Promise<MongoConnection> {
  const { uri, logger } = options;
  const pingTimeoutMs = options.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS;
  const databaseName = options.databaseName ?? DATABASE_NAME;
  const client = new MongoClient(uri, buildClientOptions(options));

  // redactUri keeps the host visible, which is what you need when the failure
  // is "wrong cluster" or "IP not allowlisted".
  logger.info('connecting to mongodb', { target: redactUri(uri), database: databaseName });

  await client.connect();
  const db = client.db(databaseName);
  logger.info('mongodb connected', { database: databaseName });

  return {
    client,
    db,
    async ping(): Promise<boolean> {
      const probe = db
        .command({ ping: 1 })
        .then(() => true)
        .catch((error: unknown) => {
          logger.warn('mongodb ping failed', { error });
          return false;
        });

      const result = await withTimeout(probe, pingTimeoutMs, null);
      if (result === null) {
        logger.warn('mongodb ping timed out', { timeoutMs: pingTimeoutMs });
        return false;
      }
      return result;
    },
    async close(): Promise<void> {
      await client.close();
      logger.info('mongodb connection closed');
    },
  };
}

/* ── Connection manager ───────────────────────────────────────────────── */

export type ConnectionState = 'connecting' | 'connected' | 'stopped';

export interface ConnectionManager {
  /** Begins connecting. Returns immediately; does not block startup. */
  start(): void;
  state(): ConnectionState;
  /** The live handle, or undefined while not connected. */
  db(): Db | undefined;
  /** False whenever the database is not currently reachable. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export interface ConnectionManagerOptions extends ConnectOptions {
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
  /** Injectable so tests can drive the retry loop without a database. */
  readonly connectFn?: (options: ConnectOptions) => Promise<MongoConnection>;
}

/**
 * Keeps trying to establish a connection, with exponential backoff.
 *
 * The previous shape captured `pingDatabase` once at startup: if that single
 * connect attempt failed, the service reported itself unready for the rest of
 * its life and only a restart fixed it. Here the state is re-read on every
 * readiness probe, so recovery is automatic once Atlas comes back.
 */
export function createConnectionManager(options: ConnectionManagerOptions): ConnectionManager {
  const { logger } = options;
  const connectFn = options.connectFn ?? connect;
  const retryBaseMs = options.retryBaseMs ?? 1_000;
  const retryMaxMs = options.retryMaxMs ?? 30_000;

  let state: ConnectionState = 'connecting';
  let connection: MongoConnection | undefined;
  let timer: NodeJS.Timeout | undefined;
  let failures = 0;
  let started = false;

  function scheduleRetry(): void {
    // 1s, 2s, 4s … capped. Capped rather than unbounded so a long outage still
    // recovers within half a minute of Atlas returning.
    const delay = Math.min(retryMaxMs, retryBaseMs * 2 ** (failures - 1));
    logger.info('retrying mongodb connection', { attempt: failures + 1, delayMs: delay });
    timer = setTimeout(() => {
      void attempt();
    }, delay);
    timer.unref?.();
  }

  async function attempt(): Promise<void> {
    if (state === 'stopped') return;
    try {
      connection = await connectFn(options);
      failures = 0;
      state = 'connected';
    } catch (error) {
      failures += 1;
      state = 'connecting';
      logger.error('mongodb connection attempt failed', { error, attempt: failures });
      scheduleRetry();
    }
  }

  return {
    start(): void {
      if (started) return;
      started = true;
      state = 'connecting';
      void attempt();
    },
    state: () => state,
    db: () => connection?.db,
    async ping(): Promise<boolean> {
      if (state !== 'connected' || connection === undefined) return false;
      const alive = await connection.ping();
      if (!alive) {
        // The driver reconnects its own sockets, so do not tear the client
        // down here — just report unready until the next probe succeeds.
        logger.warn('mongodb unreachable; reporting not-ready');
      }
      return alive;
    },
    async close(): Promise<void> {
      state = 'stopped';
      if (timer) clearTimeout(timer);
      await connection?.close();
      connection = undefined;
    },
  };
}
