/**
 * POST /repository-registry/:id/delete — permanently remove an INACTIVE
 * registry entry (repository-registry/test-delete.ts). TEST MODE ONLY:
 * server.ts answers 404 unless index.ts mounted `registryDelete`.
 *
 * Operator token first, then `{ operator, confirm }` where `confirm` must
 * repeat the entry's repositoryId, so the entry removed is the one the
 * operator confirmed on screen.
 */

import type { IncomingMessage } from 'node:http';
import { ObjectId } from 'mongodb';

import type { Logger } from '../logging/logger.ts';
import type { TestRegistryDeleter } from '../repository-registry/test-delete.ts';
import { readRawBody } from './body.ts';
import { AUTHORIZATION_HEADER, verifyOperatorToken } from './operator-auth.ts';

export interface RegistryDeleteDeps {
  readonly logger: Logger;
  /** OPERATOR_TOKEN. Absent means every request is refused. */
  readonly operatorToken: string | undefined;
  /** Absent while the database is unreachable. */
  readonly deleter: TestRegistryDeleter | undefined;
}

export interface RegistryDeleteResult {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
}

export async function handleDeleteRegistryEntry(req: IncomingMessage, deps: RegistryDeleteDeps, idParam: string): Promise<RegistryDeleteResult> {
  const child = deps.logger.child({ route: 'repository-registry.delete' });

  const auth = verifyOperatorToken({ token: deps.operatorToken, header: req.headers[AUTHORIZATION_HEADER] as string | undefined });
  if (!auth.valid) {
    child.warn('registry delete rejected: unauthorized', { reason: auth.reason });
    return { statusCode: 401, body: { error: 'unauthorized' } };
  }
  if (deps.deleter === undefined) return { statusCode: 503, body: { error: 'unavailable' } };
  if (!/^[0-9a-fA-F]{24}$/.test(idParam)) return { statusCode: 400, body: { error: 'invalid_request', field: 'id' } };

  const read = await readRawBody(req, { maxBytes: 4 * 1024 });
  if (!read.ok) return { statusCode: 400, body: { error: 'invalid_request' } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.body.toString('utf8'));
  } catch {
    return { statusCode: 400, body: { error: 'invalid_request' } };
  }
  const record = (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>;
  const operator = typeof record['operator'] === 'string' ? record['operator'].trim() : '';
  const confirm = typeof record['confirm'] === 'string' ? record['confirm'] : '';
  if (operator === '') return { statusCode: 400, body: { error: 'invalid_request', field: 'operator', detail: 'name the operator deleting it' } };

  const result = await deps.deleter.delete(new ObjectId(idParam), confirm, `operator:${operator}`);
  switch (result.outcome) {
    case 'deleted':
      return { statusCode: 200, body: { id: idParam, repositoryId: result.repositoryId, projectIdentifier: result.projectIdentifier, deleted: true } };
    case 'not_found':
      return { statusCode: 404, body: { error: 'not_found' } };
    case 'confirm_mismatch':
      return { statusCode: 400, body: { error: 'invalid_request', field: 'confirm', detail: 'confirm must repeat the repository id exactly' } };
    case 'still_active':
      return { statusCode: 409, body: { error: 'conflict', detail: `${result.repositoryId} is active — deactivate it first, then delete` } };
    case 'permission_denied':
      return { statusCode: 403, body: { error: 'permission_denied', detail: "the service's database role cannot delete from repositoryRegistry — nothing was deleted" } };
  }
}
