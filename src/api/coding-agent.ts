/**
 * POST /runs/:runId/coding-agent — triggers the Coding Agent for a
 * confirmed run.
 *
 * `candidateFilePaths` is operator-supplied, not automatically discovered
 * — see pipeline/coding-agent-trigger.ts's module comment for exactly why
 * that is a deliberate limitation, not an oversight. This is a MUTATION
 * (it can create a `changeReviews` row), so it is gated behind the
 * operator bearer token like every other write route in this codebase,
 * even though "run the Coding Agent" is not itself one of the four human
 * approval gates — it is closer in kind to a human choosing which files
 * matter, a decision nothing here can safely automate for it.
 */

import type { IncomingMessage } from 'node:http';
import { ObjectId } from 'mongodb';

import { triggerCodingAgent, type TriggerCodingAgentDeps } from '../pipeline/coding-agent-trigger.ts';
import type { Logger } from '../logging/logger.ts';
import { readRawBody } from './body.ts';
import { AUTHORIZATION_HEADER, verifyOperatorToken } from './operator-auth.ts';

export interface CodingAgentApiDeps {
  readonly logger: Logger;
  readonly operatorToken: string | undefined;
  /** Absent while the database is unreachable, or GitHub App / Coding Agent configuration is missing. */
  readonly trigger: Omit<TriggerCodingAgentDeps, 'logger'> | undefined;
  readonly maxBodyBytes?: number;
}

export interface CodingAgentApiResult {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
}

const UNAUTHORIZED: CodingAgentApiResult = { statusCode: 401, body: { error: 'unauthorized' } };
const INVALID: CodingAgentApiResult = { statusCode: 400, body: { error: 'invalid_request' } };
const UNAVAILABLE: CodingAgentApiResult = { statusCode: 503, body: { error: 'unavailable' } };

/** 64 KB: candidateFilePaths can legitimately list many files. */
const CODING_AGENT_MAX_BODY_BYTES = 64 * 1024;
/** Mirrors coding-agent/repository-context.ts's own bound on how many files one run considers. */
const MAX_CANDIDATE_FILE_PATHS = 25;

interface TriggerBody {
  readonly candidateFilePaths: readonly string[];
  readonly operator: string;
}

function parseTriggerBody(raw: Buffer): TriggerBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;

  const paths = record['candidateFilePaths'];
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_CANDIDATE_FILE_PATHS) return null;
  const candidateFilePaths: string[] = [];
  for (const path of paths) {
    if (typeof path !== 'string' || path.trim() === '') return null;
    candidateFilePaths.push(path.trim());
  }

  const operator = record['operator'];
  if (typeof operator !== 'string' || operator.trim() === '') return null;

  return { candidateFilePaths, operator: operator.trim() };
}

export async function handleTriggerCodingAgent(
  req: IncomingMessage,
  deps: CodingAgentApiDeps,
  runIdParam: string,
): Promise<CodingAgentApiResult> {
  const child = deps.logger.child({ route: 'runs.coding-agent' });

  const auth = verifyOperatorToken({
    token: deps.operatorToken,
    header: req.headers[AUTHORIZATION_HEADER] as string | undefined,
  });
  if (!auth.valid) {
    child.warn('coding agent trigger rejected: unauthorized', { reason: auth.reason });
    return UNAUTHORIZED;
  }

  if (deps.trigger === undefined) {
    child.error('coding agent trigger rejected: unavailable');
    return UNAVAILABLE;
  }

  if (!ObjectId.isValid(runIdParam) || !/^[0-9a-fA-F]{24}$/.test(runIdParam)) {
    return INVALID;
  }
  const runId = new ObjectId(runIdParam);

  const read = await readRawBody(req, { maxBytes: deps.maxBodyBytes ?? CODING_AGENT_MAX_BODY_BYTES });
  if (!read.ok) {
    return read.reason === 'too_large' ? { statusCode: 413, body: { error: 'payload_too_large' } } : INVALID;
  }
  const parsedBody = parseTriggerBody(read.body);
  if (parsedBody === null) return INVALID;

  const result = await triggerCodingAgent(
    { ...deps.trigger, logger: deps.logger },
    runId,
    parsedBody.candidateFilePaths,
  );

  if (!result.ok) {
    child.warn('coding agent trigger failed', { category: result.category, message: result.message });
    return {
      statusCode: result.category === 'repository_access_failure' ? 409 : 422,
      body: { error: result.category, detail: result.message, retryable: result.retryable },
    };
  }

  child.info('coding agent triggered', { reviewId: result.review._id!.toHexString(), created: result.created });
  return {
    statusCode: result.created ? 201 : 200,
    body: {
      reviewId: result.review._id!.toHexString(),
      runId: result.review.runId.toHexString(),
      status: result.review.status,
      proposalHash: result.review.proposalHash,
      changeCount: result.review.proposedChanges.length,
      created: result.created,
    },
  };
}
