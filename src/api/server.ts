/**
 * HTTP server.
 *
 * node:http rather than a framework: Phase 0 serves two health routes, and a
 * framework would be dependency surface with nothing to show for it. Revisit
 * at Phase 3 when /ingest arrives.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { Logger } from '../logging/logger.ts';
import { buildLiveness, buildReadiness, type HealthDeps } from './health.ts';

export interface ServerDeps {
  readonly logger: Logger;
  readonly health: HealthDeps;
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  // url is relative; the base is discarded and only the path is used.
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  const method = req.method ?? 'GET';

  if (method !== 'GET' && method !== 'HEAD') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  switch (path) {
    case '/health':
      sendJson(res, 200, buildLiveness(deps.health));
      return;
    case '/health/ready': {
      const { body, statusCode } = await buildReadiness(deps.health);
      sendJson(res, statusCode, body);
      return;
    }
    default:
      sendJson(res, 404, { error: 'not_found' });
  }
}

export function createHttpServer(deps: ServerDeps): Server {
  return createServer((req, res) => {
    const startedAt = process.hrtime.bigint();

    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      deps.logger.info('request', {
        method: req.method,
        // `path`, not `url`: the redactor blanks any field named `url`.
        path: new URL(req.url ?? '/', 'http://localhost').pathname,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
      });
    });

    handleRequest(req, res, deps).catch((error: unknown) => {
      deps.logger.error('unhandled request error', { error });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
      else res.end();
    });
  });
}
