/**
 * POST /operator/tickets/:issueKey/delete — remove a test ticket and its
 * pipeline trail (intake/test-purge.ts). TEST MODE ONLY: server.ts answers
 * 404 unless index.ts mounted `ticketDelete`, which it does only when the
 * console's Create-test-ticket tab is enabled (non-production + loopback
 * mock).
 *
 * Same gate as every operator write: bearer token first, then a JSON body
 * naming the operator for the audit entry. The body must also repeat the
 * issue key as `confirm`, so a mistyped or replayed URL cannot delete a
 * different ticket than the one the operator confirmed on screen.
 */

import type { IncomingMessage } from 'node:http';

import type { TestTicketPurger } from '../intake/test-purge.ts';
import type { Logger } from '../logging/logger.ts';
import { readRawBody } from './body.ts';
import { AUTHORIZATION_HEADER, verifyOperatorToken } from './operator-auth.ts';

export interface TicketDeleteDeps {
  readonly logger: Logger;
  /** OPERATOR_TOKEN. Absent means every request is refused. */
  readonly operatorToken: string | undefined;
  /** Absent while the database is unreachable. */
  readonly purger: TestTicketPurger | undefined;
}

export interface TicketDeleteResult {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
}

const MAX_BODY_BYTES = 4 * 1024;

export async function handleDeleteTestTicket(req: IncomingMessage, deps: TicketDeleteDeps, issueKey: string): Promise<TicketDeleteResult> {
  const child = deps.logger.child({ route: 'operator.tickets.delete', issueKey });

  const auth = verifyOperatorToken({ token: deps.operatorToken, header: req.headers[AUTHORIZATION_HEADER] as string | undefined });
  if (!auth.valid) {
    child.warn('ticket delete rejected: unauthorized', { reason: auth.reason });
    return { statusCode: 401, body: { error: 'unauthorized' } };
  }
  if (deps.purger === undefined) {
    child.error('ticket delete rejected: database unavailable');
    return { statusCode: 503, body: { error: 'unavailable' } };
  }

  const read = await readRawBody(req, { maxBytes: MAX_BODY_BYTES });
  if (!read.ok) return read.reason === 'too_large' ? { statusCode: 413, body: { error: 'payload_too_large' } } : { statusCode: 400, body: { error: 'invalid_request' } };

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.body.toString('utf8'));
  } catch {
    return { statusCode: 400, body: { error: 'invalid_request' } };
  }
  const record = (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>;
  const operator = typeof record['operator'] === 'string' ? record['operator'].trim() : '';
  if (operator === '') return { statusCode: 400, body: { error: 'invalid_request', field: 'operator', detail: 'name the operator deleting it' } };
  if (record['confirm'] !== issueKey) {
    return { statusCode: 400, body: { error: 'invalid_request', field: 'confirm', detail: 'confirm must repeat the issue key exactly' } };
  }

  const result = await deps.purger.purge(issueKey, `operator:${operator}`);
  switch (result.outcome) {
    case 'purged':
      return { statusCode: 200, body: { issueKey, deleted: result.deleted } };
    case 'not_found':
      return { statusCode: 404, body: { error: 'not_found' } };
    case 'permission_denied':
      return {
        statusCode: 403,
        body: {
          error: 'permission_denied',
          collections: result.collections,
          detail: `the service's database role cannot delete from: ${result.collections.join(', ')} — nothing was deleted`,
        },
      };
  }
}
