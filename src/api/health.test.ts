import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildLiveness,
  buildReadiness,
  resolveDatabaseStatus,
  type DatabaseProbe,
  type HealthDeps,
} from './health.ts';
import type { ConnectionState } from '../db/client.ts';

const deps: HealthDeps = { version: '0.1.0', uptimeSeconds: () => 12.7 };

function probe(state: ConnectionState, pingResult = true): DatabaseProbe & { pings: number } {
  const p = {
    pings: 0,
    state: () => state,
    async ping() {
      p.pings += 1;
      return pingResult;
    },
  };
  return p;
}

describe('liveness', () => {
  it('reports ok without touching the database', () => {
    assert.deepEqual(buildLiveness(deps), {
      status: 'ok',
      service: 'aisdlc-service',
      version: '0.1.0',
      uptimeSeconds: 12,
    });
  });
});

describe('resolveDatabaseStatus', () => {
  it('reports not_configured when no database is wired up', async () => {
    assert.equal(await resolveDatabaseStatus(undefined), 'not_configured');
  });

  it('reports connecting while the manager is still retrying', async () => {
    // Distinct from unavailable: the instance is mid-recovery, not stuck.
    assert.equal(await resolveDatabaseStatus(probe('connecting')), 'connecting');
  });

  it('does not ping while connecting', async () => {
    const p = probe('connecting');
    await resolveDatabaseStatus(p);
    assert.equal(p.pings, 0);
  });

  it('reports unavailable once the manager has stopped', async () => {
    assert.equal(await resolveDatabaseStatus(probe('stopped')), 'unavailable');
  });

  it('reports ok when connected and the ping succeeds', async () => {
    assert.equal(await resolveDatabaseStatus(probe('connected', true)), 'ok');
  });

  it('reports unavailable when connected but the ping fails', async () => {
    assert.equal(await resolveDatabaseStatus(probe('connected', false)), 'unavailable');
  });
});

describe('readiness', () => {
  it('returns 503 and not_configured when no database is wired up', async () => {
    const { body, statusCode } = await buildReadiness(deps);
    assert.equal(body.dependencies.database, 'not_configured');
    assert.equal(body.status, 'degraded');
    assert.equal(statusCode, 503);
  });

  it('returns 503 while connecting', async () => {
    const { body, statusCode } = await buildReadiness({ ...deps, database: probe('connecting') });
    assert.equal(body.dependencies.database, 'connecting');
    assert.equal(statusCode, 503);
  });

  it('returns 200 only when the database is reachable', async () => {
    const { body, statusCode } = await buildReadiness({
      ...deps,
      database: probe('connected', true),
    });
    assert.equal(body.dependencies.database, 'ok');
    assert.equal(body.status, 'ok');
    assert.equal(statusCode, 200);
  });

  it('returns 503 when the ping fails', async () => {
    const { body, statusCode } = await buildReadiness({
      ...deps,
      database: probe('connected', false),
    });
    assert.equal(body.dependencies.database, 'unavailable');
    assert.equal(statusCode, 503);
  });

  it('re-reads state on every probe, so recovery is automatic', async () => {
    // The health payload must not cache a decision made at startup.
    let state: ConnectionState = 'connecting';
    const database: DatabaseProbe = { state: () => state, ping: async () => true };

    assert.equal((await buildReadiness({ ...deps, database })).statusCode, 503);
    state = 'connected';
    assert.equal((await buildReadiness({ ...deps, database })).statusCode, 200);
  });
});
