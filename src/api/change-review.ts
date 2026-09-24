/**
 * POST /change-reviews/:reviewId/approve and /reject — GATE 3, the human
 * decision on the Coding Agent's proposed changes.
 *
 * Same shape as approval.ts and repository-selection.ts: verify the
 * operator bearer token before reading or parsing the body, build
 * `operator:<name>` and let `ChangeReviewRepository.approve`/`reject`
 * (change-execution/review-repository.ts) do all state-machine and audit
 * work — this handler only authenticates, parses, and translates the
 * outcome to HTTP. `approve`/`reject` themselves refuse any actor without
 * the `operator:` prefix (ReviewDecisionRequiresOperatorError) — this is
 * what makes it structurally impossible for a service identity, including
 * the Coding Agent, to approve its own proposal through this route: the
 * principal built here always carries that prefix, but nothing stops a
 * FUTURE caller of the repository directly, which is why that repository
 * enforces it too, not just this handler.
 */

import type { IncomingMessage } from 'node:http';
import { ObjectId } from 'mongodb';

import {
  ReviewDecisionRequiresOperatorError,
  ReviewNotFoundError,
  ReviewNotPendingError,
  type ChangeReviewRepository,
} from '../change-execution/review-repository.ts';
import type { Logger } from '../logging/logger.ts';
import { readRawBody } from './body.ts';
import { AUTHORIZATION_HEADER, verifyOperatorToken } from './operator-auth.ts';

export type ChangeReviewAction = 'approve' | 'reject';

export interface ChangeReviewDeps {
  readonly logger: Logger;
  readonly operatorToken: string | undefined;
  readonly reviews: ChangeReviewRepository | undefined;
  readonly maxBodyBytes?: number;
}

export interface ChangeReviewApiResult {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
}

const UNAUTHORIZED: ChangeReviewApiResult = { statusCode: 401, body: { error: 'unauthorized' } };
const INVALID: ChangeReviewApiResult = { statusCode: 400, body: { error: 'invalid_request' } };
const NOT_FOUND: ChangeReviewApiResult = { statusCode: 404, body: { error: 'not_found' } };
const UNAVAILABLE: ChangeReviewApiResult = { statusCode: 503, body: { error: 'unavailable' } };

/** 4 KB: the body is `{ operator, comment? }`, both short strings. */
const CHANGE_REVIEW_MAX_BODY_BYTES = 4 * 1024;

interface ChangeReviewBody {
  readonly operator: string;
  readonly comment?: string;
}

function parseChangeReviewBody(raw: Buffer): ChangeReviewBody | null {
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

  const comment = record['comment'];
  if (comment !== undefined && typeof comment !== 'string') return null;

  return { operator: operator.trim(), ...(comment === undefined ? {} : { comment }) };
}

export async function handleChangeReviewDecision(
  req: IncomingMessage,
  deps: ChangeReviewDeps,
  reviewIdParam: string,
  action: ChangeReviewAction,
): Promise<ChangeReviewApiResult> {
  const child = deps.logger.child({ route: 'change-reviews.decision', action });

  const auth = verifyOperatorToken({
    token: deps.operatorToken,
    header: req.headers[AUTHORIZATION_HEADER] as string | undefined,
  });
  if (!auth.valid) {
    child.warn('change review decision rejected: unauthorized', { reason: auth.reason });
    return UNAUTHORIZED;
  }

  if (deps.reviews === undefined) {
    child.error('change review decision rejected: database unavailable');
    return UNAVAILABLE;
  }

  if (!ObjectId.isValid(reviewIdParam) || !/^[0-9a-fA-F]{24}$/.test(reviewIdParam)) {
    return INVALID;
  }
  const reviewId = new ObjectId(reviewIdParam);

  const read = await readRawBody(req, { maxBytes: deps.maxBodyBytes ?? CHANGE_REVIEW_MAX_BODY_BYTES });
  if (!read.ok) {
    return read.reason === 'too_large' ? { statusCode: 413, body: { error: 'payload_too_large' } } : INVALID;
  }
  const parsedBody = parseChangeReviewBody(read.body);
  if (parsedBody === null) return INVALID;

  const principal = `operator:${parsedBody.operator}`;
  const options = { actor: principal, ...(parsedBody.comment === undefined ? {} : { comment: parsedBody.comment }) };

  try {
    const review = action === 'approve' ? await deps.reviews.approve(reviewId, options) : await deps.reviews.reject(reviewId, options);
    child.info('change review decided', { reviewId: reviewId.toHexString(), status: review.status, operator: parsedBody.operator });
    return {
      statusCode: 200,
      body: {
        reviewId: review._id!.toHexString(),
        runId: review.runId.toHexString(),
        status: review.status,
        reviewedBy: review.reviewedBy,
        reviewedAt: review.reviewedAt,
        reviewComment: review.reviewComment,
      },
    };
  } catch (error) {
    if (error instanceof ReviewNotFoundError) return NOT_FOUND;
    if (error instanceof ReviewNotPendingError) {
      child.warn('change review decision rejected: not pending', { detail: error.message });
      return { statusCode: 409, body: { error: 'conflict', detail: error.message } };
    }
    if (error instanceof ReviewDecisionRequiresOperatorError) {
      // Defensive: principal always carries the operator: prefix above —
      // see the module comment. Unreachable through this route.
      child.error('change review decision rejected: operator prefix missing unexpectedly', { error });
      return INVALID;
    }
    child.error('change review decision failed unexpectedly', { error });
    return { statusCode: 500, body: { error: 'internal_error' } };
  }
}
