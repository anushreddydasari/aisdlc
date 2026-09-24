import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import {
  HEADERS_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  createHttpServer,
  type ServerDeps,
} from './server.ts';
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

describe('/ingest routing', () => {
  /** Starts a server whose ingest handler just records that it was reached. */
  async function withIngest(mounted: boolean): Promise<{ url: string; calls: number }> {
    const state = { calls: 0 };
    const logLines: string[] = [];
    const deps: ServerDeps = {
      logger: createLogger({ write: (line) => logLines.push(line) }),
      health: { version: '0.1.0', uptimeSeconds: () => 1, database: undefined },
      ...(mounted
        ? {
            ingest: {
              logger: createLogger({ write: () => {} }),
              webhookSecret: undefined,
              deliveries: undefined,
              audit: undefined,
            },
          }
        : {}),
    };
    const server = createHttpServer(deps);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, get calls() { return state.calls; } };
  }

  it('routes POST /ingest to the handler', async () => {
    const { url } = await withIngest(true);
    const res = await fetch(`${url}/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    // No secret configured, so the handler answers 401 — which proves the
    // request reached it rather than the 405 or 404 paths.
    assert.equal(res.status, 401);
  });

  it('returns 404 when /ingest is not mounted', async () => {
    const { url } = await withIngest(false);
    const res = await fetch(`${url}/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 404);
  });

  it('refuses GET on /ingest', async () => {
    const { url } = await withIngest(true);
    assert.equal((await fetch(`${url}/ingest`)).status, 405);
  });

  it('refuses POST on any other path', async () => {
    const { url } = await withIngest(true);
    for (const path of ['/health', '/health/ready', '/anything']) {
      const res = await fetch(`${url}${path}`, { method: 'POST' });
      assert.equal(res.status, 405, `POST ${path} was not refused`);
    }
  });

  it('leaves the health endpoints untouched', async () => {
    const { url } = await withIngest(true);
    assert.equal((await fetch(`${url}/health`)).status, 200);
    assert.equal((await fetch(`${url}/health/ready`)).status, 503);
  });
});

describe('/intake approval routing', () => {
  async function withApproval(mounted: boolean): Promise<{ url: string }> {
    const deps: ServerDeps = {
      logger: createLogger({ write: () => {} }),
      health: { version: '0.1.0', uptimeSeconds: () => 1, database: undefined },
      ...(mounted
        ? {
            approval: {
              logger: createLogger({ write: () => {} }),
              operatorToken: undefined,
              intake: undefined,
            },
          }
        : {}),
    };
    const server = createHttpServer(deps);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}` };
  }

  it('routes POST /intake/:issueKey/approve to the handler', async () => {
    const { url } = await withApproval(true);
    const res = await fetch(`${url}/intake/CF-1/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    // No operator token configured, so the handler answers 401 — which
    // proves the request reached it rather than the 405 or 404 paths.
    assert.equal(res.status, 401);
  });

  it('routes POST /intake/:issueKey/reject to the handler', async () => {
    const { url } = await withApproval(true);
    const res = await fetch(`${url}/intake/CF-1/reject`, { method: 'POST' });
    assert.equal(res.status, 401);
  });

  it('returns 404 when the approval routes are not mounted', async () => {
    const { url } = await withApproval(false);
    const res = await fetch(`${url}/intake/CF-1/approve`, { method: 'POST' });
    assert.equal(res.status, 404);
  });

  it('refuses GET on an approval route', async () => {
    const { url } = await withApproval(true);
    assert.equal((await fetch(`${url}/intake/CF-1/approve`)).status, 405);
  });

  it('does not match an unrelated action segment', async () => {
    // Falls through to the generic "POST anywhere but /ingest or an
    // approval route" case, same as the /ingest sibling test above: any
    // unmatched path answers 405 to POST, not 404 (404 is reserved for a
    // GET/HEAD to an unknown path).
    const { url } = await withApproval(true);
    const res = await fetch(`${url}/intake/CF-1/delete`, { method: 'POST' });
    assert.equal(res.status, 405);
  });

  it('url-decodes the issue key', async () => {
    // Proves routing extracts and decodes the segment rather than passing
    // the raw path through — a 401 (reached the handler) rather than a 404
    // confirms the route matched.
    const { url } = await withApproval(true);
    const res = await fetch(`${url}/intake/CF%2F1/approve`, { method: 'POST' });
    assert.equal(res.status, 401);
  });

  it('leaves /ingest and the health endpoints untouched', async () => {
    const { url } = await withApproval(true);
    assert.equal((await fetch(`${url}/health`)).status, 200);
    assert.equal(
      (await fetch(`${url}/ingest`, { method: 'POST', body: '{}' })).status,
      404,
    );
  });
});

describe('/repository-registry routing', () => {
  async function withRegistry(mounted: boolean): Promise<{ url: string }> {
    const deps: ServerDeps = {
      logger: createLogger({ write: () => {} }),
      health: { version: '0.1.0', uptimeSeconds: () => 1, database: undefined },
      ...(mounted
        ? {
            repositoryRegistry: {
              logger: createLogger({ write: () => {} }),
              operatorToken: undefined,
              registry: undefined,
            },
          }
        : {}),
    };
    const server = createHttpServer(deps);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}` };
  }

  it('routes POST /repository-registry to the create handler', async () => {
    const { url } = await withRegistry(true);
    const res = await fetch(`${url}/repository-registry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    // No operator token configured, so the handler answers 401 — which
    // proves the request reached it rather than the 405 or 404 paths.
    assert.equal(res.status, 401);
  });

  it('routes GET /repository-registry to the list handler', async () => {
    const { url } = await withRegistry(true);
    const res = await fetch(`${url}/repository-registry`);
    assert.equal(res.status, 401);
  });

  it('routes GET /repository-registry/:id to the get handler', async () => {
    const { url } = await withRegistry(true);
    const res = await fetch(`${url}/repository-registry/abc123`);
    assert.equal(res.status, 401);
  });

  it('routes PATCH /repository-registry/:id to the update handler', async () => {
    const { url } = await withRegistry(true);
    const res = await fetch(`${url}/repository-registry/abc123`, { method: 'PATCH', body: '{}' });
    assert.equal(res.status, 401);
  });

  it('routes POST /repository-registry/:id/deactivate to the status handler', async () => {
    const { url } = await withRegistry(true);
    const res = await fetch(`${url}/repository-registry/abc123/deactivate`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 401);
  });

  it('routes POST /repository-registry/:id/reactivate to the status handler', async () => {
    const { url } = await withRegistry(true);
    const res = await fetch(`${url}/repository-registry/abc123/reactivate`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 401);
  });

  it('returns 404 for every registry route when not mounted', async () => {
    const { url } = await withRegistry(false);
    for (const [path, method] of [
      ['/repository-registry', 'GET'],
      ['/repository-registry', 'POST'],
      ['/repository-registry/abc123', 'GET'],
      ['/repository-registry/abc123', 'PATCH'],
      ['/repository-registry/abc123/deactivate', 'POST'],
    ] as const) {
      const res = await fetch(`${url}${path}`, { method });
      assert.equal(res.status, 404, `${method} ${path} was not 404`);
    }
  });

  it('refuses DELETE on the collection route', async () => {
    const { url } = await withRegistry(true);
    const res = await fetch(`${url}/repository-registry`, { method: 'DELETE' });
    assert.equal(res.status, 405);
  });

  it('refuses an unmatched action segment on an item route', async () => {
    // Falls through to the generic "POST anywhere unmatched" case, same as
    // the /intake sibling test above: 405, not 404 (404 is reserved for a
    // GET/HEAD to an unknown path).
    // (`/delete` is a real, test-mode-only route now — see registry-delete.ts —
    // so this uses a segment that matches nothing.)
    const { url } = await withRegistry(true);
    const res = await fetch(`${url}/repository-registry/abc123/archive`, { method: 'POST' });
    assert.equal(res.status, 405);
  });

  it('leaves /health, /ingest, and /intake untouched', async () => {
    const { url } = await withRegistry(true);
    assert.equal((await fetch(`${url}/health`)).status, 200);
    assert.equal((await fetch(`${url}/ingest`, { method: 'POST', body: '{}' })).status, 404);
    assert.equal((await fetch(`${url}/intake/CF-1/approve`, { method: 'POST', body: '{}' })).status, 404);
  });
});

describe('/repositories admin UI routing', () => {
  it('serves the admin page at GET /repositories, with no deps required', async () => {
    const { url } = await start();
    const res = await fetch(`${url}/repositories`);

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.text();
    assert.ok(body.includes('<title>Repository Management</title>'));
    assert.ok(body.includes('+ Add Repository'));
  });

  it('never embeds an OPERATOR_TOKEN, GitHub token, or private key in the served page', async () => {
    // The page has no server-side deps and is rendered from a static
    // constant, so this can never vary by request — but it's still worth
    // asserting directly, since this is the one HTTP response an admin's
    // browser actually receives.
    const { url } = await start();
    const body = await (await fetch(`${url}/repositories`)).text();
    assert.ok(!body.includes('BEGIN PRIVATE KEY'));
    assert.ok(!body.toLowerCase().includes('op_test_token'));
  });

  it('allows HEAD on the admin page', async () => {
    const { url } = await start();
    const res = await fetch(`${url}/repositories`, { method: 'HEAD' });
    assert.equal(res.status, 200);
  });

  it('refuses POST on the admin page — it is read-only, static content', async () => {
    const { url } = await start();
    const res = await fetch(`${url}/repositories`, { method: 'POST' });
    assert.equal(res.status, 405);
  });
});

describe('/repository-selections routing', () => {
  async function withSelection(mounted: boolean): Promise<{ url: string }> {
    const deps: ServerDeps = {
      logger: createLogger({ write: () => {} }),
      health: { version: '0.1.0', uptimeSeconds: () => 1, database: undefined },
      ...(mounted
        ? {
            repositorySelection: {
              logger: createLogger({ write: () => {} }),
              operatorToken: undefined,
              selections: undefined,
              registry: undefined,
            },
          }
        : {}),
    };
    const server = createHttpServer(deps);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}` };
  }

  it('routes POST /repository-selections/:runId/confirm to the handler', async () => {
    const { url } = await withSelection(true);
    const res = await fetch(`${url}/repository-selections/abc123/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    // No operator token configured, so the handler answers 401 — which
    // proves the request reached it rather than the 405 or 404 paths.
    assert.equal(res.status, 401);
  });

  it('returns 404 when the selection route is not mounted', async () => {
    const { url } = await withSelection(false);
    const res = await fetch(`${url}/repository-selections/abc123/confirm`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 404);
  });

  it('refuses GET on the confirm route', async () => {
    const { url } = await withSelection(true);
    assert.equal((await fetch(`${url}/repository-selections/abc123/confirm`)).status, 405);
  });

  it('does not match an unrelated action segment', async () => {
    const { url } = await withSelection(true);
    const res = await fetch(`${url}/repository-selections/abc123/reject`, { method: 'POST' });
    assert.equal(res.status, 405);
  });

  it('leaves /health and /repository-registry untouched', async () => {
    const { url } = await withSelection(true);
    assert.equal((await fetch(`${url}/health`)).status, 200);
    assert.equal((await fetch(`${url}/repository-registry`)).status, 404);
  });
});

describe('/runs/:runId/deployment routing', () => {
  async function withDeploymentStatus(mounted: boolean): Promise<{ url: string }> {
    const deps: ServerDeps = {
      logger: createLogger({ write: () => {} }),
      health: { version: '0.1.0', uptimeSeconds: () => 1, database: undefined },
      ...(mounted
        ? {
            deploymentStatus: {
              logger: createLogger({ write: () => {} }),
              operatorToken: undefined,
              runs: undefined,
              reviews: undefined,
              executions: undefined,
              publications: undefined,
              deployments: undefined,
            },
          }
        : {}),
    };
    const server = createHttpServer(deps);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}` };
  }

  it('routes GET /runs/:runId/deployment to the handler', async () => {
    const { url } = await withDeploymentStatus(true);
    const res = await fetch(`${url}/runs/abc123/deployment`);
    // No operator token configured, so the handler answers 401 — which
    // proves the request reached it rather than the 405 or 404 paths.
    assert.equal(res.status, 401);
  });

  it('returns 404 when the deployment status route is not mounted', async () => {
    const { url } = await withDeploymentStatus(false);
    const res = await fetch(`${url}/runs/abc123/deployment`);
    assert.equal(res.status, 404);
  });

  // Security (Section 16/23): this surface is read-only. There is no
  // merge-trigger, approve, or deploy-trigger endpoint anywhere on this
  // path — POST (or any other write method) to it is always refused.
  it('refuses POST, PATCH, and DELETE on the deployment status route', async () => {
    const { url } = await withDeploymentStatus(true);
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      const res = await fetch(`${url}/runs/abc123/deployment`, { method });
      assert.equal(res.status, 405, `${method} /runs/:runId/deployment was not refused`);
    }
  });

  // No such endpoint exists anywhere: not /merge, not /approve-pr, not
  // /auto-deploy, not /deploy — Section 16 forbids all four explicitly.
  it('has no merge, approve-pr, auto-deploy, or deploy-trigger endpoint', async () => {
    const { url } = await withDeploymentStatus(true);
    for (const path of [
      '/runs/abc123/merge',
      '/runs/abc123/approve-pr',
      '/runs/abc123/auto-deploy',
      '/runs/abc123/deploy',
      '/merge',
      '/approve-pr',
      '/auto-deploy',
    ]) {
      const res = await fetch(`${url}${path}`, { method: 'POST' });
      assert.notEqual(res.status, 200, `${path} unexpectedly succeeded`);
      assert.ok([404, 405].includes(res.status), `${path} returned an unexpected status ${res.status}`);
    }
  });

  it('leaves /health and /runs/:runId untouched', async () => {
    const { url } = await withDeploymentStatus(true);
    assert.equal((await fetch(`${url}/health`)).status, 200);
    assert.equal((await fetch(`${url}/runs/abc123`)).status, 404);
  });
});

describe('timeouts', () => {
  it('bounds how long a request can occupy a connection', async () => {
    // Neutara does not retry, so a stalled request costs an event.
    const { server } = await start();
    assert.equal(server.requestTimeout, REQUEST_TIMEOUT_MS);
    assert.equal(server.headersTimeout, HEADERS_TIMEOUT_MS);
    assert.ok(HEADERS_TIMEOUT_MS < REQUEST_TIMEOUT_MS);
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
