import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createHttpServer, type ServerDeps } from './server.ts';
import type { HealthDeps } from './health.ts';
import { createLogger } from '../logging/logger.ts';

interface Harness {
  readonly url: string;
  readonly logLines: string[];
  readonly server: Server;
}

const servers: Server[] = [];

async function start(health: Partial<HealthDeps> = {}): Promise<Harness> {
  const logLines: string[] = [];
  const deps: ServerDeps = {
    logger: createLogger({ write: (line) => logLines.push(line) }),
    health: {
      version: '0.1.0',
      uptimeSeconds: () => 1,
      // Phase 0 default: nothing wired up.
      database: undefined,
      ...health,
    },
  };

  const server = createHttpServer(deps);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return { url: `http://127.0.0.1:${port}`, logLines, server };
}

after(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

/** The request log is written on the `finish` event, just after the response. */
async function waitForLog(lines: readonly string[], count = 1): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (lines.length < count) {
    if (Date.now() > deadline) throw new Error('no request log was written');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe('routing', () => {
  it('serves liveness at /health', async () => {
    const { url } = await start();
    const res = await fetch(`${url}/health`);

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    // A cached health response would report a stale instance as healthy.
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), {
      status: 'ok',
      service: 'aisdlc-service',
      version: '0.1.0',
      uptimeSeconds: 1,
    });
  });

  it('serves readiness at /health/ready', async () => {
    const { url } = await start();
    const res = await fetch(`${url}/health/ready`);

    assert.equal(res.status, 503);
    const body = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(body['dependencies'], { database: 'not_configured' });
  });

  it('returns 200 on readiness when the database is reachable', async () => {
    const { url } = await start({
      database: { state: () => 'connected', ping: async () => true },
    });
    const res = await fetch(`${url}/health/ready`);

    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body['status'], 'ok');
  });

  it('returns 404 for an unknown path', async () => {
    const { url } = await start();
    const res = await fetch(`${url}/nope`);

    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'not_found' });
  });

  it('returns 405 for a non-GET method', async () => {
    const { url } = await start();
    const res = await fetch(`${url}/health`, { method: 'POST' });

    assert.equal(res.status, 405);
    assert.deepEqual(await res.json(), { error: 'method_not_allowed' });
  });

  it('allows HEAD on a health route', async () => {
    const { url } = await start();
    const res = await fetch(`${url}/health`, { method: 'HEAD' });

    assert.equal(res.status, 200);
    assert.equal(await res.text(), '');
  });

  it('ignores the query string when routing', async () => {
    const { url } = await start();
    assert.equal((await fetch(`${url}/health?verbose=1`)).status, 200);
  });
});

describe('error handling', () => {
  it('returns 500 rather than hanging when a handler throws', async () => {
    const { url, logLines } = await start({
      uptimeSeconds: () => {
        throw new Error('clock exploded');
      },
    });

    const res = await fetch(`${url}/health`);
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'internal_error' });

    await waitForLog(logLines, 1);
    assert.ok(
      logLines.some((line) => line.includes('unhandled request error')),
      'the failure was not logged',
    );
  });

  it('does not leak the error message to the client', async () => {
    const { url } = await start({
      uptimeSeconds: () => {
        throw new Error('connection string mongodb+srv://u:pw@host/db failed');
      },
    });

    const body = await (await fetch(`${url}/health`)).text();
    assert.ok(!body.includes('mongodb'), 'internal detail reached the client');
    assert.ok(!body.includes('pw'), 'internal detail reached the client');
  });
});

describe('request logging', () => {
  it('records method, path, status and duration', async () => {
    const { url, logLines } = await start();
    await fetch(`${url}/health`);
    await waitForLog(logLines);

    const record = JSON.parse(logLines.find((l) => l.includes('"msg":"request"'))!) as Record<
      string,
      unknown
    >;
    assert.equal(record['method'], 'GET');
    assert.equal(record['path'], '/health');
    assert.equal(record['status'], 200);
    assert.equal(typeof record['durationMs'], 'number');
  });

  it('never writes the query string to the log', async () => {
    // The redactor does not scrub query strings, so the server must log the
    // pathname only. A token in a query parameter must not reach the log.
    const { url, logLines } = await start();
    await fetch(`${url}/health?token=SUPERSECRET123456&api_key=abcdef`);
    await waitForLog(logLines);

    const joined = logLines.join('\n');
    assert.ok(!joined.includes('SUPERSECRET123456'), 'query string token was logged');
    assert.ok(!joined.includes('api_key'), 'query string was logged');

    const record = JSON.parse(logLines.find((l) => l.includes('"msg":"request"'))!) as Record<
      string,
      unknown
    >;
    assert.equal(record['path'], '/health');
  });

  it('logs the 404 path too', async () => {
    const { url, logLines } = await start();
    await fetch(`${url}/does-not-exist`);
    await waitForLog(logLines);

    const record = JSON.parse(logLines.find((l) => l.includes('"msg":"request"'))!) as Record<
      string,
      unknown
    >;
    assert.equal(record['status'], 404);
    assert.equal(record['path'], '/does-not-exist');
  });
});
