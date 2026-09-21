/**
 * POST /intake/:issueKey/approve and POST /intake/:issueKey/reject — the
 * Phase 6 human approval gate.
 *
 * Order is load-bearing, the same discipline /ingest follows: verify the
 * operator bearer token BEFORE reading or parsing the body. An unauthorized
 * caller's request body is never parsed — parsing attacker-controlled JSON
 * is work performed on behalf of someone who has not proven they may act.
 *
 * All the state-machine and audit work already exists in
 * intake/repository.ts's transition(): this module's only job is to
 * authenticate the caller, validate the request shape, name the operator
 * (`operator:<name>`, required by ApprovalOptions for an approval — and
 * used consistently for a rejection too, even though the repository does
 * not enforce it there, so the audit trail always names a real person), and
 * translate the repository's outcome into an HTTP response.
 *
 * Returns a result rather than writing to the response, matching
 * handleIngest's shape, so the decision tree is testable without a socket.
 */

import type { IncomingMessage } from 'node:http';

import {
  ApprovalRequiresOperatorError,
  IntakeConflictError,
  IntakeNotFoundError,
  type IntakeRepository,
} from '../intake/repository.ts';
import { InvalidTransitionError } from '../intake/state.ts';
import type { Logger } from '../logging/logger.ts';
import { DEFAULT_MAX_BODY_BYTES, readRawBody } from './body.ts';
import { AUTHORIZATION_HEADER, verifyOperatorToken } from './operator-auth.ts';

export type ApprovalAction = 'approve' | 'reject';

export interface ApprovalDeps {
  readonly logger: Logger;
  /** OPERATOR_TOKEN. Absent means every request is refused. */
  readonly operatorToken: string | undefined;
  /** Absent while the database is unreachable. */
  readonly intake: IntakeRepository | undefined;
  readonly maxBodyBytes?: number;
}

export interface ApprovalResult {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
}

const UNAUTHORIZED: ApprovalResult = { statusCode: 401, body: { error: 'unauthorized' } };
const INVALID: ApprovalResult = { statusCode: 400, body: { error: 'invalid_request' } };
const UNAVAILABLE: ApprovalResult = { statusCode: 503, body: { error: 'unavailable' } };

/** 4 KB: the body is `{ operator, reason? }`, both short strings. */
const APPROVAL_MAX_BODY_BYTES = 4 * 1024;

interface ApprovalRequestBody {
  readonly operator: string;
  readonly reason?: string;
}

function parseRequestBody(raw: Buffer): ApprovalRequestBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  const operator = record['operator'];
  if (typeof operator !== 'string' || operator.trim() === '') return null;

  const reason = record['reason'];
  if (reason !== undefined && typeof reason !== 'string') return null;

  return { operator: operator.trim(), ...(reason === undefined ? {} : { reason }) };
}

export async function handleApproval(
  req: IncomingMessage,
  deps: ApprovalDeps,
  issueKey: string,
  action: ApprovalAction,
): Promise<ApprovalResult> {
  const { logger } = deps;
  const child = logger.child({ issueKey, action });

  // Checked first, before a single byte of the body is read.
  const auth = verifyOperatorToken({
    token: deps.operatorToken,
    header: req.headers[AUTHORIZATION_HEADER] as string | undefined,
  });
  if (!auth.valid) {
    // The reason is logged but never returned — see operator-auth.ts.
    child.warn('approval rejected: unauthorized', { reason: auth.reason });
    return UNAUTHORIZED;
  }

  if (deps.intake === undefined) {
    child.error('approval rejected: database unavailable');
    return UNAVAILABLE;
  }

  if (issueKey.trim() === '') {
    return INVALID;
  }

  const read = await readRawBody(req, { maxBytes: deps.maxBodyBytes ?? APPROVAL_MAX_BODY_BYTES });
  if (!read.ok) {
    child.warn('approval rejected: body unreadable', { reason: read.reason });
    return read.reason === 'too_large' ? { statusCode: 413, body: { error: 'payload_too_large' } } : INVALID;
  }

  const parsedBody = parseRequestBody(read.body);
  if (parsedBody === null) {
    child.warn('approval rejected: invalid request body');
    return INVALID;
  }

  // Never a secret — this names WHO, not what authorizes them. The bearer
  // token already proved the caller may act as an operator; this is purely
  // for the audit trail.
  const principal = `operator:${parsedBody.operator}`;

  try {
    const item =
      action === 'approve'
        ? await deps.intake.transition(issueKey, 'approved', {
            actor: principal,
            approvedBy: principal,
            ...(parsedBody.reason === undefined ? {} : { reason: parsedBody.reason }),
          })
        : await deps.intake.transition(issueKey, 'rejected', {
            actor: principal,
            ...(parsedBody.reason === undefined ? {} : { reason: parsedBody.reason }),
          });

    child.info('approval applied', { status: item.status, operator: parsedBody.operator });
    return {
      statusCode: 200,
      body: {
        issueKey: item.issueKey,
        status: item.status,
        approvedBy: item.approvedBy,
        approvedAt: item.approvedAt,
        statusReason: item.statusReason,
      },
    };
  } catch (error) {
    if (error instanceof IntakeNotFoundError) {
      return { statusCode: 404, body: { error: 'not_found' } };
    }
    if (error instanceof InvalidTransitionError) {
      child.warn('approval rejected: invalid transition', { detail: error.message });
      return { statusCode: 409, body: { error: 'invalid_transition', detail: error.message } };
    }
    if (error instanceof IntakeConflictError) {
      child.warn('approval rejected: conflict', { detail: error.message });
      return { statusCode: 409, body: { error: 'conflict', detail: error.message } };
    }
    if (error instanceof ApprovalRequiresOperatorError) {
      // Defensive: principal is always built with the operator: prefix
      // above, so this should be unreachable, but the type system cannot
      // prove it — a code change elsewhere must not turn this into a 500.
      child.error('approval rejected: operator prefix missing unexpectedly', { error });
      return INVALID;
    }
    child.error('approval failed unexpectedly', { error });
    return { statusCode: 500, body: { error: 'internal_error' } };
  }
}
