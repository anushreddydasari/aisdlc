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
import { handleChangeReviewDecision, type ChangeReviewDeps } from './change-review.ts';
import { handleTriggerCodingAgent, type CodingAgentApiDeps } from './coding-agent.ts';
import { handleGetDeploymentStatus, type DeploymentStatusDeps } from './deployment-status.ts';
import { buildLiveness, buildReadiness, type HealthDeps } from './health.ts';
import { handleIngest, type IngestDeps } from './ingest.ts';
import { handleGetOperatorQueue, type OperatorQueueDeps } from './operator-queue.ts';
import { handleGetOperatorTickets, type OperatorTicketsDeps } from './operator-tickets.ts';
import { renderConsoleUi, type ConsoleUiOptions } from './console-ui.ts';
import { handleDeleteTestTicket, type TicketDeleteDeps } from './ticket-delete.ts';
import {
  handleCreateRegistryEntry,
  handleGetRegistryEntry,
  handleListRegistryEntries,
  handleSetRegistryEntryStatus,
  handleUpdateRegistryEntry,
  type RepositoryRegistryDeps,
} from './repository-registry.ts';
import { REPOSITORY_UI_HTML, REPOSITORY_UI_DELETE_FLAG_OFF, REPOSITORY_UI_DELETE_FLAG_ON } from './repository-ui.ts';
import { handleDeleteRegistryEntry, type RegistryDeleteDeps } from './registry-delete.ts';
import { handleConfirmRepositorySelection, type RepositorySelectionDeps } from './repository-selection.ts';
import { handleGetRunStatus, type RunStatusDeps } from './run-status.ts';

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
  /** Same "mounted but refuses without a token" choice as `approval`. */
  readonly runStatus?: RunStatusDeps | undefined;
  /** Same "mounted but refuses without a token" choice as `approval`. */
  readonly codingAgent?: CodingAgentApiDeps | undefined;
  /** Same "mounted but refuses without a token" choice as `approval`. */
  readonly changeReview?: ChangeReviewDeps | undefined;
  /** Same "mounted but refuses without a token" choice as `approval`. */
  readonly deploymentStatus?: DeploymentStatusDeps | undefined;
  /** Same "mounted but refuses without a token" choice as `approval`. */
  readonly operatorQueue?: OperatorQueueDeps | undefined;
  /** Same "mounted but refuses without a token" choice as `approval`. */
  readonly operatorTickets?: OperatorTicketsDeps | undefined;
  /** Absent means the console shows no Create-test-ticket tab. */
  readonly consoleUi?: ConsoleUiOptions | undefined;
  /** Test mode only — absent (outside test mode) means the delete route answers 404. */
  readonly ticketDelete?: TicketDeleteDeps | undefined;
  /** Test mode only — absent means the registry delete route answers 404 and the page shows no Delete. */
  readonly registryDelete?: RegistryDeleteDeps | undefined;
}

/** POST /intake/{issueKey}/approve or /reject. issueKey is opaque, so no slashes. */
const APPROVAL_PATH = /^\/intake\/([^/]+)\/(approve|reject)$/;

/** GET/POST /repository-registry — list or create. */
const REGISTRY_COLLECTION_PATH = /^\/repository-registry$/;
/** GET/PATCH /repository-registry/{id} — get or update one entry. */
const REGISTRY_ITEM_PATH = /^\/repository-registry\/([^/]+)$/;
/** POST /repository-registry/{id}/delete — test mode only, inactive entries only. */
const REGISTRY_DELETE_PATH = /^\/repository-registry\/([^/]+)\/delete$/;
/** POST /repository-registry/{id}/deactivate or /reactivate. */
const REGISTRY_STATUS_PATH = /^\/repository-registry\/([^/]+)\/(deactivate|reactivate)$/;

/** POST /repository-selections/{runId}/confirm. */
const SELECTION_CONFIRM_PATH = /^\/repository-selections\/([^/]+)\/confirm$/;

/** POST /operator/tickets/{issueKey}/delete — test mode only. */
const TICKET_DELETE_PATH = /^\/operator\/tickets\/([^/]+)\/delete$/;

/** GET /runs/{runId} — the composed end-to-end status view. */
const RUN_STATUS_PATH = /^\/runs\/([^/]+)$/;
/** POST /runs/{runId}/coding-agent. */
const RUN_CODING_AGENT_PATH = /^\/runs\/([^/]+)\/coding-agent$/;
/** POST /change-reviews/{reviewId}/approve or /reject. */
const CHANGE_REVIEW_DECISION_PATH = /^\/change-reviews\/([^/]+)\/(approve|reject)$/;
/** GET /runs/{runId}/deployment — the detailed deployment record for a run. */
const RUN_DEPLOYMENT_PATH = /^\/runs\/([^/]+)\/deployment$/;

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

function sendHtml(res: ServerResponse, statusCode: number, html: string): void {
  res.writeHead(statusCode, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-store',
  });
  res.end(html);
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

  const registryDeleteMatch = REGISTRY_DELETE_PATH.exec(path);
  if (registryDeleteMatch) {
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    if (deps.registryDelete === undefined) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    const [, id] = registryDeleteMatch as unknown as [string, string];
    const result = await handleDeleteRegistryEntry(req, deps.registryDelete, decodeURIComponent(id));
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

  const ticketDeleteMatch = TICKET_DELETE_PATH.exec(path);
  if (ticketDeleteMatch) {
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    if (deps.ticketDelete === undefined) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    const [, issueKey] = ticketDeleteMatch as unknown as [string, string];
    const result = await handleDeleteTestTicket(req, deps.ticketDelete, decodeURIComponent(issueKey));
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

  const codingAgentMatch = RUN_CODING_AGENT_PATH.exec(path);
  if (codingAgentMatch) {
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    if (deps.codingAgent === undefined) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    const [, runId] = codingAgentMatch as unknown as [string, string];
    const result = await handleTriggerCodingAgent(req, deps.codingAgent, decodeURIComponent(runId));
    sendJson(res, result.statusCode, result.body);
    return;
  }

  const changeReviewMatch = CHANGE_REVIEW_DECISION_PATH.exec(path);
  if (changeReviewMatch) {
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    if (deps.changeReview === undefined) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    const [, reviewId, action] = changeReviewMatch as unknown as [string, string, 'approve' | 'reject'];
    const result = await handleChangeReviewDecision(req, deps.changeReview, decodeURIComponent(reviewId), action);
    sendJson(res, result.statusCode, result.body);
    return;
  }

  const runDeploymentMatch = RUN_DEPLOYMENT_PATH.exec(path);
  if (runDeploymentMatch) {
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    if (deps.deploymentStatus === undefined) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    const [, runId] = runDeploymentMatch as unknown as [string, string];
    const result = await handleGetDeploymentStatus(req, deps.deploymentStatus, decodeURIComponent(runId));
    sendJson(res, result.statusCode, result.body);
    return;
  }

  const runStatusMatch = RUN_STATUS_PATH.exec(path);
  if (runStatusMatch) {
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    if (deps.runStatus === undefined) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    const [, runId] = runStatusMatch as unknown as [string, string];
    const result = await handleGetRunStatus(req, deps.runStatus, decodeURIComponent(runId));
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
    case '/operator/queue': {
      if (deps.operatorQueue === undefined) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      const result = await handleGetOperatorQueue(req, deps.operatorQueue);
      sendJson(res, result.statusCode, result.body);
      return;
    }
    case '/operator/tickets': {
      if (deps.operatorTickets === undefined) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      const result = await handleGetOperatorTickets(req, deps.operatorTickets);
      sendJson(res, result.statusCode, result.body);
      return;
    }
    case '/console':
      // Static page, same posture as /repositories below: it only calls the
      // /operator/* reads and the pre-existing gate routes from the browser.
      sendHtml(res, 200, renderConsoleUi(deps.consoleUi ?? { ticketCreatorUrl: null }));
      return;
    case '/operator':
      // The approvals page now lives in the console; keep the old link working.
      res.writeHead(302, { location: '/console#approvals', 'cache-control': 'no-store' });
      res.end();
      return;
    case '/repositories':
      // Static admin page — see repository-ui.ts's module comment. No deps
      // to check: it has no server-side logic of its own, only calls the
      // already-gated /repository-registry JSON API from the browser.
      // The Delete button exists only when the delete route is mounted.
      sendHtml(res, 200, deps.registryDelete === undefined ? REPOSITORY_UI_HTML : REPOSITORY_UI_HTML.replace(REPOSITORY_UI_DELETE_FLAG_OFF, REPOSITORY_UI_DELETE_FLAG_ON));
      return;
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
