import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { Db, MongoClient } from 'mongodb';

import {
  DATABASE_NAME,
  DEFAULT_PING_TIMEOUT_MS,
  buildClientOptions,
  createConnectionManager,
  withTimeout,
  type MongoConnection,
} from './client.ts';
import { createLogger } from '../logging/logger.ts';

const logger = createLogger({ write: () => {} });
const URI = 'mongodb+srv://user:pw@cluster0.example.mongodb.net/aisdlc';

/**
 * These tests never open a connection. Phase 0 has no Atlas URI configured,
 * and a unit test should not need one.
 */
describe('mongo client options', () => {
  it('targets the aisdlc database by default', () => {
    assert.equal(DATABASE_NAME, 'aisdlc');
  });

  it('does not read the database name from the environment', () => {
    // An env-driven database name would fall back to production whenever it
    // was unset or misspelled. The override is a code-level option instead,
    // so a wrong target fails loudly rather than quietly hitting live data.
    const source = readFileSync(new URL('./client.ts', import.meta.url), 'utf8');
    assert.ok(
      !/process\.env\[?['"`]?AISDLC_DATABASE/.test(source),
      'client.ts reads the database name from the environment',
    );
  });

  it('requires TLS regardless of what the URI says', () => {
    assert.equal(buildClientOptions({ uri: 'mongodb://host/db', logger }).tls, true);
  });

  it('fails server selection fast so a bad URI or allowlist gap surfaces quickly', () => {
    assert.equal(
      buildClientOptions({ uri: 'mongodb+srv://host/db', logger }).serverSelectionTimeoutMS,
      10_000,
    );
  });

  it('identifies itself to Atlas for per-app metrics', () => {
    assert.equal(buildClientOptions({ uri: 'mongodb://h', logger }).appName, 'aisdlc-service');
    assert.equal(
      buildClientOptions({ uri: 'mongodb://h', logger, appName: 'aisdlc-db-init' }).appName,
      'aisdlc-db-init',
    );
  });

  it('bounds the connection pool', () => {
    const options = buildClientOptions({ uri: 'mongodb://h', logger });
    assert.equal(options.maxPoolSize, 10);
    assert.equal(options.minPoolSize, 0);
    assert.equal(options.retryWrites, true);
  });

  it('allows a caller to shorten the selection timeout', () => {
    assert.equal(
      buildClientOptions({ uri: 'mongodb://h', logger, serverSelectionTimeoutMs: 500 })
        .serverSelectionTimeoutMS,
      500,
    );
  });
});

describe('withTimeout', () => {
  it('bounds the readiness ping well inside a probe deadline', () => {
    // Orchestrators kill probes after 1-5s; the ping must fail before that.
    assert.equal(DEFAULT_PING_TIMEOUT_MS, 2_000);
  });

  it('returns the value when the promise settles in time', async () => {
    assert.equal(await withTimeout(Promise.resolve('fast'), 1_000, 'fallback'), 'fast');
  });

  it('returns the fallback when the promise is too slow', async () => {
    const never = new Promise<string>(() => {});
    assert.equal(await withTimeout(never, 5, 'fallback'), 'fallback');
  });

  it('does not wait for the slow promise once it has given up', async () => {
    const started = Date.now();
    await withTimeout(new Promise<string>((r) => setTimeout(() => r('late'), 5_000).unref()), 5, 'x');
    assert.ok(Date.now() - started < 1_000, 'withTimeout blocked on the slow promise');
  });
});

/* ── Connection manager ───────────────────────────────────────────────── */

function fakeConnection(overrides: Partial<MongoConnection> = {}): MongoConnection {
  return {
    client: {} as MongoClient,
    db: {} as Db,
    ping: async () => true,
    close: async () => {},
    ...overrides,
  };
}

/** Polls until `predicate` holds, so tests never depend on exact timer order. */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met within timeout');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe('createConnectionManager', () => {
  it('connects on start and exposes the database', async () => {
    const manager = createConnectionManager({ uri: URI, logger, connectFn: async () => fakeConnection() });
    manager.start();
    await waitFor(() => manager.state() === 'connected');

    assert.equal(manager.state(), 'connected');
    assert.ok(manager.db());
    assert.equal(await manager.ping(), true);
    await manager.close();
  });

  it('reports connecting, not connected, before the first attempt lands', async () => {
    const manager = createConnectionManager({
      uri: URI,
      logger,
      connectFn: () => new Promise<MongoConnection>(() => {}),
    });
    manager.start();

    assert.equal(manager.state(), 'connecting');
    assert.equal(await manager.ping(), false);
    assert.equal(manager.db(), undefined);
    await manager.close();
  });

  it('recovers after a failed first attempt instead of staying unready forever', async () => {
    // The regression this exists for: the old code captured the connection
    // once at startup, so a transient Atlas blip meant permanent unreadiness.
    let attempts = 0;
    const manager = createConnectionManager({
      uri: URI,
      logger,
      retryBaseMs: 5,
      retryMaxMs: 10,
      connectFn: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('atlas unreachable');
        return fakeConnection();
      },
    });

    manager.start();
    assert.equal(manager.state(), 'connecting');

    await waitFor(() => manager.state() === 'connected');
    assert.equal(attempts, 3);
    assert.equal(await manager.ping(), true);
    await manager.close();
  });

  it('reports not-ready while the database is unreachable', async () => {
    const manager = createConnectionManager({
      uri: URI,
      logger,
      connectFn: async () => fakeConnection({ ping: async () => false }),
    });
    manager.start();
    await waitFor(() => manager.state() === 'connected');

    // Connected but unreachable: readiness must say no.
    assert.equal(await manager.ping(), false);
    await manager.close();
  });

  it('stops retrying once closed', async () => {
    let attempts = 0;
    const manager = createConnectionManager({
      uri: URI,
      logger,
      retryBaseMs: 5,
      retryMaxMs: 5,
      connectFn: async () => {
        attempts += 1;
        throw new Error('atlas unreachable');
      },
    });

    manager.start();
    await waitFor(() => attempts >= 2);
    await manager.close();

    const settled = attempts;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(attempts, settled, 'manager kept retrying after close');
    assert.equal(manager.state(), 'stopped');
    assert.equal(await manager.ping(), false);
  });

  it('ignores a second start', async () => {
    let attempts = 0;
    const manager = createConnectionManager({
      uri: URI,
      logger,
      connectFn: async () => {
        attempts += 1;
        return fakeConnection();
      },
    });
    manager.start();
    manager.start();
    await waitFor(() => manager.state() === 'connected');

    assert.equal(attempts, 1);
    await manager.close();
  });
});
