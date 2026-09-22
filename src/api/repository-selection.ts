/**
 * POST /repository-selections/:runId/confirm — the human-confirmation step
 * decision D2 requires for every run, even when only one repository ever
 * matched.
 *
 * Order mirrors approval.ts: verify the operator bearer token before
 * reading or parsing the body. Authorization is the same known limitation
 * as repository-registry.ts (a single shared operator token, no per-person
 * role) — see that module's header comment.
 *
 * Before delegating to `selections.confirm()`, this handler re-reads the
 * CURRENT active mappings for the selection's project and looks up the
 * chosen repositoryId there, rather than trusting the selection's own
 * (possibly stale) `candidateRepositoryIds` for the snapshot values. This
 * is what "future registry changes do not alter the stored selection
 * snapshot, but a confirmation itself always uses current data" comes
 * down to: the repository could have been edited (URL, branches) since it
 * was last matched, and the human is confirming what exists NOW, not what
 * was true when the row was created. `confirm()` itself still guards that
 * the chosen id was among the row's own candidates, so this handler cannot
 * be used to confirm a repository the matching pass never actually offered.
 */

import type { IncomingMessage } from 'node:http';
import { ObjectId } from 'mongodb';

import {
  SelectionConflictError,
  SelectionNotFoundError,
  SelectionValidationError,
  type RepositorySelectionRepository,
} from '../repository-selection/repository.ts';
import type { RepositoryRegistryRepository } from '../repository-registry/repository.ts';
import type { Logger } from '../logging/logger.ts';
import { readRawBody } from './body.ts';
import { AUTHORIZATION_HEADER, verifyOperatorToken } from './operator-auth.ts';

export interface RepositorySelectionDeps {
  readonly logger: Logger;
  /** OPERATOR_TOKEN. Absent means every request is refused. */
  readonly operatorToken: string | undefined;
  /** Absent while the database is unreachable. */
  readonly selections: RepositorySelectionRepository | undefined;
  readonly registry: RepositoryRegistryRepository | undefined;
  readonly maxBodyBytes?: number;
}

export interface SelectionApiResult {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
}

const UNAUTHORIZED: SelectionApiResult = { statusCode: 401, body: { error: 'unauthorized' } };
const INVALID: SelectionApiResult = { statusCode: 400, body: { error: 'invalid_request' } };
const NOT_FOUND: SelectionApiResult = { statusCode: 404, body: { error: 'not_found' } };
const UNAVAILABLE: SelectionApiResult = { statusCode: 503, body: { error: 'unavailable' } };

/** 4 KB: the body is `{ repositoryId, operator, reason? }`, all short strings. */
const CONFIRM_MAX_BODY_BYTES = 4 * 1024;

interface ConfirmBody {
  readonly repositoryId: string;
  readonly operator: string;
  readonly reason?: string;
}

function parseConfirmBody(raw: Buffer): ConfirmBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;

  const repositoryId = record['repositoryId'];
  if (typeof repositoryId !== 'string' || repositoryId.trim() === '') return null;

  const operator = record['operator'];
  if (typeof operator !== 'string' || operator.trim() === '') return null;

  const reason = record['reason'];
  if (reason !== undefined && typeof reason !== 'string') return null;

  return { repositoryId: repositoryId.trim(), operator: operator.trim(), ...(reason === undefined ? {} : { reason }) };
}

function serialize(selection: {
  _id?: ObjectId;
  runId: ObjectId;
  issueKey: string;
  projectIdentifier: string;
  status: string;
  candidateRepositoryIds: string[];
  selectedRepositoryId: string | null;
  selectedRepositoryUrl: string | null;
  selectedDefaultBranch: string | null;
  selectedAllowedBranches: string[] | null;
  confirmedBy: string | null;
  confirmedAt: Date | null;
}): Record<string, unknown> {
  return {
    runId: selection.runId.toHexString(),
    issueKey: selection.issueKey,
    projectIdentifier: selection.projectIdentifier,
    status: selection.status,
    candidateRepositoryIds: selection.candidateRepositoryIds,
    selectedRepositoryId: selection.selectedRepositoryId,
    selectedRepositoryUrl: selection.selectedRepositoryUrl,
    selectedDefaultBranch: selection.selectedDefaultBranch,
    selectedAllowedBranches: selection.selectedAllowedBranches,
    confirmedBy: selection.confirmedBy,
    confirmedAt: selection.confirmedAt,
  };
}

export async function handleConfirmRepositorySelection(
  req: IncomingMessage,
  deps: RepositorySelectionDeps,
  runIdParam: string,
): Promise<SelectionApiResult> {
  const child = deps.logger.child({ route: 'repository-selections.confirm' });

  const auth = verifyOperatorToken({
    token: deps.operatorToken,
    header: req.headers[AUTHORIZATION_HEADER] as string | undefined,
  });
  if (!auth.valid) {
    child.warn('confirmation rejected: unauthorized', { reason: auth.reason });
    return UNAUTHORIZED;
  }

  if (deps.selections === undefined || deps.registry === undefined) {
    child.error('confirmation rejected: database unavailable');
    return UNAVAILABLE;
  }

  if (!ObjectId.isValid(runIdParam) || !/^[0-9a-fA-F]{24}$/.test(runIdParam)) {
    return INVALID;
  }
  const runId = new ObjectId(runIdParam);

  const read = await readRawBody(req, { maxBytes: deps.maxBodyBytes ?? CONFIRM_MAX_BODY_BYTES });
  if (!read.ok) {
    return read.reason === 'too_large' ? { statusCode: 413, body: { error: 'payload_too_large' } } : INVALID;
  }
  const parsedBody = parseConfirmBody(read.body);
  if (parsedBody === null) return INVALID;

  const selection = await deps.selections.findByRunId(runId);
  if (selection === null) return NOT_FOUND;

  // Re-checked against the registry's CURRENT state, not the selection's
  // possibly-stale candidateRepositoryIds — see the module comment above.
  const activeEntries = await deps.registry.findActiveByProjectIdentifier(selection.projectIdentifier);
  const chosen = activeEntries.find((e) => e.repositoryId === parsedBody.repositoryId);
  if (chosen === undefined) {
    return {
      statusCode: 409,
      body: {
        error: 'conflict',
        detail: `repositoryId '${parsedBody.repositoryId}' is not currently an active mapping for this project`,
      },
    };
  }

  const principal = `operator:${parsedBody.operator}`;
  try {
    const confirmed = await deps.selections.confirm(runId, {
      repositoryId: chosen.repositoryId,
      repositoryUrl: chosen.repositoryUrl,
      defaultBranch: chosen.defaultBranch,
      allowedBranches: chosen.allowedBranches,
      accessPolicy: chosen.accessPolicy,
      confirmedBy: principal,
    });
    child.info('repository selection confirmed via API', {
      issueKey: confirmed.issueKey,
      repositoryId: chosen.repositoryId,
    });
    return { statusCode: 200, body: serialize(confirmed) };
  } catch (error) {
    if (error instanceof SelectionNotFoundError) return NOT_FOUND;
    if (error instanceof SelectionConflictError) {
      child.warn('confirmation rejected: conflict', { detail: error.message });
      return { statusCode: 409, body: { error: 'conflict', detail: error.message } };
    }
    if (error instanceof SelectionValidationError) {
      child.warn('confirmation rejected: invalid repositoryId', { detail: error.message });
      return { statusCode: 400, body: { error: 'invalid_request', field: error.field, detail: error.message } };
    }
    child.error('confirmation failed unexpectedly', { error });
    return { statusCode: 500, body: { error: 'internal_error' } };
  }
}
