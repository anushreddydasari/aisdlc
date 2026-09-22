/**
 * HTTP server.
 *
 * node:http rather than a framework: Phase 0 serves two health routes, and a
 * framework would be dependency surface with nothing to show for it. Revisit
 * at Phase 3 when /ingest arrives.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { Logger } from '../logging/logger.ts';
import { handleApproval, type ApprovalDeps } from './approval.ts';
import { buildLiveness, buildReadiness, type HealthDeps } from './health.ts';
import { handleIngest, type IngestDeps } from './ingest.ts';
import {
  handleCreateRegistryEntry,
  handleGetRegistryEntry,
  handleListRegistryEntries,
  handleSetRegistryEntryStatus,
  handleUpdateRegistryEntry,
  type RepositoryRegistryDeps,
} from './repository-registry.ts';
import { handleConfirmRepositorySelection, type RepositorySelectionDeps } from './repository-selection.ts';

export interface ServerDeps {
  readonly logger: Logger;
  readonly health: HealthDeps;
  /** Absent means /ingest is not mounted at all. */
  readonly ingest?: IngestDeps | undefined;
  /**
   * Present whenever the intake repository can be constructed — unlike
   * /ingest, these routes stay mounted even without OPERATOR_TOKEN (it
   * answers 401 to everything instead, the same "mounted but refuses"
   * choice /ingest makes for an absent webhook secret).
   */
  readonly approval?: ApprovalDeps | undefined;
  /** Same "mounted but refuses without a token" choice as `approval`. */
  readonly repositoryRegistry?: RepositoryRegistryDeps | undefined;
  /** Same "mounted but refuses without a token" choice as `approval`. */
  readonly repositorySelection?: RepositorySelectionDeps | undefined;
}

/** POST /intake/{issueKey}/approve or /reject. issueKey is opaque, so no slashes. */
const APPROVAL_PATH = /^\/intake\/([^/]+)\/(approve|reject)$/;

/** GET/POST /repository-registry — list or create. */
const REGISTRY_COLLECTION_PATH = /^\/repository-registry$/;
/** GET/PATCH /repository-registry/{id} — get or update one entry. */
const REGISTRY_ITEM_PATH = /^\/repository-registry\/([^/]+)$/;
/** POST /repository-registry/{id}/deactivate or /reactivate. */
const REGISTRY_STATUS_PATH = /^\/repository-registry\/([^/]+)\/(deactivate|reactivate)$/;

/** POST /repository-selections/{runId}/confirm. */
const SELECTION_CONFIRM_PATH = /^\/repository-selections\/([^/]+)\/confirm$/;

/**
 * Neutara does not retry, so a slow or stalled request costs an event. These
 * bound how long one can occupy a connection.
 */
export const REQUEST_TIMEOUT_MS = 30_000;
export const HEADERS_TIMEOUT_MS = 10_000;

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

  // POST is accepted on /ingest and nowhere else.
  if (path === '/ingest') {
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    if (deps.ingest === undefined) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    const result = await handleIngest(req, deps.ingest);
    sendJson(res, result.statusCode, result.body);
    return;
  }

  const approvalMatch = APPROVAL_PATH.exec(path);
  if (approvalMatch) {
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    if (deps.approval === undefined) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    const [, issueKey, action] = approvalMatch as unknown as [string, string, 'approve' | 'reject'];
    const result = await handleApproval(req, deps.approval, decodeURIComponent(issueKey), action);
    sendJson(res, result.statusCode, result.body);
    return;
  }

  const registryStatusMatch = REGISTRY_STATUS_PATH.exec(path);
  if (registryStatusMatch) {
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    if (deps.repositoryRegistry === undefined) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    const [, id, action] = registryStatusMatch as unknown as [string, string, 'deactivate' | 'reactivate'];
    const result = await handleSetRegistryEntryStatus(
      req,
      deps.repositoryRegistry,
      decodeURIComponent(id),
      action === 'reactivate' ? 'active' : 'inactive',
    );
    sendJson(res, result.statusCode, result.body);
    return;
  }

  if (REGISTRY_COLLECTION_PATH.test(path)) {
    if (method !== 'GET' && method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    if (deps.repositoryRegistry === undefined) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    const result =
      method === 'POST'
        ? await handleCreateRegistryEntry(req, deps.repositoryRegistry)
        : await handleListRegistryEntries(req, deps.repositoryRegistry, new URL(req.url ?? '/', 'http://localhost').searchParams);
    sendJson(res, result.statusCode, result.body);
    return;
  }

  const registryItemMatch = REGISTRY_ITEM_PATH.exec(path);
  if (registryItemMatch) {
    if (method !== 'GET' && method !== 'PATCH') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    if (deps.repositoryRegistry === undefined) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    const [, id] = registryItemMatch as unknown as [string, string];
    const result =
      method === 'GET'
        ? await handleGetRegistryEntry(req, deps.repositoryRegistry, decodeURIComponent(id))
        : await handleUpdateRegistryEntry(req, deps.repositoryRegistry, decodeURIComponent(id));
    sendJson(res, result.statusCode, result.body);
    return;
  }

  const selectionConfirmMatch = SELECTION_CONFIRM_PATH.exec(path);
  if (selectionConfirmMatch) {
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    if (deps.repositorySelection === undefined) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    const [, runId] = selectionConfirmMatch as unknown as [string, string];
    const result = await handleConfirmRepositorySelection(
      req,
      deps.repositorySelection,
      decodeURIComponent(runId),
    );
    sendJson(res, result.statusCode, result.body);
    return;
  }

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
  const server = createServer((req, res) => {
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

  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  return server;
}
