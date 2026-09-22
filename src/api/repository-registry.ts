/**
 * /repository-registry — operator-gated CRUD over `repositoryRegistry`.
 *
 * Decision D4 asked for "administrators and authorized team members" to
 * manage mappings "according to their permissions, reusing the existing
 * authentication and authorization mechanisms." The existing mechanism
 * (verifyOperatorToken / OPERATOR_TOKEN, see operator-auth.ts) is a single
 * shared bearer secret with no role or permission concept at all — there is
 * no "administrator" distinct from "team member" anywhere in this codebase.
 * Rather than invent a new role system unasked, this module reuses that
 * exact mechanism, exactly as approval.ts does: any caller holding the
 * operator token may perform any of these operations, and the free-text
 * `operator` field in the request body (turned into `operator:<name>`) is
 * for audit attribution only, never for authorization. This is a known
 * limitation — see docs/repository-selection.md.
 *
 * Order is load-bearing, matching approval.ts: verify the bearer token
 * before reading or parsing the body.
 */

import type { IncomingMessage } from 'node:http';
import { ObjectId } from 'mongodb';

import {
  DuplicateActiveMappingError,
  RegistryEntryNotFoundError,
  RegistryValidationError,
  type RepositoryRegistryRepository,
} from '../repository-registry/repository.ts';
import type { Logger } from '../logging/logger.ts';
import { DEFAULT_MAX_BODY_BYTES, readRawBody } from './body.ts';
import { AUTHORIZATION_HEADER, verifyOperatorToken } from './operator-auth.ts';

export interface RepositoryRegistryDeps {
  readonly logger: Logger;
  /** OPERATOR_TOKEN. Absent means every request is refused. */
  readonly operatorToken: string | undefined;
  /** Absent while the database is unreachable. */
  readonly registry: RepositoryRegistryRepository | undefined;
  readonly maxBodyBytes?: number;
}

export interface RegistryApiResult {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
}

const UNAUTHORIZED: RegistryApiResult = { statusCode: 401, body: { error: 'unauthorized' } };
const INVALID: RegistryApiResult = { statusCode: 400, body: { error: 'invalid_request' } };
const NOT_FOUND: RegistryApiResult = { statusCode: 404, body: { error: 'not_found' } };
const UNAVAILABLE: RegistryApiResult = { statusCode: 503, body: { error: 'unavailable' } };

/** 8 KB: the largest body here is a create/update with a handful of branch strings. */
const REGISTRY_MAX_BODY_BYTES = 8 * 1024;

function serialize(entry: {
  _id?: ObjectId;
  projectIdentifier: string;
  repositoryId: string;
  repositoryUrl: string;
  defaultBranch: string;
  allowedBranches: string[];
  status: string;
  accessPolicy: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  updatedBy: string;
}): Record<string, unknown> {
  return {
    id: entry._id?.toHexString(),
    projectIdentifier: entry.projectIdentifier,
    repositoryId: entry.repositoryId,
    repositoryUrl: entry.repositoryUrl,
    defaultBranch: entry.defaultBranch,
    allowedBranches: entry.allowedBranches,
    status: entry.status,
    accessPolicy: entry.accessPolicy,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    createdBy: entry.createdBy,
    updatedBy: entry.updatedBy,
  };
}

function parseObjectId(value: string): ObjectId | null {
  if (!ObjectId.isValid(value)) return null;
  // ObjectId.isValid also accepts a 12-byte-string form; require the 24-hex form.
  if (!/^[0-9a-fA-F]{24}$/.test(value)) return null;
  return new ObjectId(value);
}

function requireOperator(record: Record<string, unknown>): string | null {
  const operator = record['operator'];
  if (typeof operator !== 'string' || operator.trim() === '') return null;
  return operator.trim();
}

function readStringArray(value: unknown): string[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return null;
  return value as string[];
}

interface CreateBody {
  readonly projectIdentifier: string;
  readonly repositoryId: string;
  readonly repositoryUrl: string;
  readonly defaultBranch: string;
  readonly allowedBranches: string[];
  readonly accessPolicy?: Record<string, unknown> | null;
  readonly operator: string;
}

function parseCreateBody(raw: Buffer): CreateBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;

  const operator = requireOperator(record);
  if (operator === null) return null;

  const projectIdentifier = record['projectIdentifier'];
  const repositoryId = record['repositoryId'];
  const repositoryUrl = record['repositoryUrl'];
  const defaultBranch = record['defaultBranch'];
  if (
    typeof projectIdentifier !== 'string' ||
    projectIdentifier.trim() === '' ||
    typeof repositoryId !== 'string' ||
    repositoryId.trim() === '' ||
    typeof repositoryUrl !== 'string' ||
    typeof defaultBranch !== 'string'
  ) {
    return null;
  }

  const allowedBranches = readStringArray(record['allowedBranches']);
  if (!allowedBranches) return null;

  const accessPolicy = record['accessPolicy'];
  if (accessPolicy !== undefined && accessPolicy !== null && typeof accessPolicy !== 'object') return null;

  return {
    projectIdentifier: projectIdentifier.trim(),
    repositoryId: repositoryId.trim(),
    repositoryUrl,
    defaultBranch,
    allowedBranches,
    ...(accessPolicy === undefined ? {} : { accessPolicy: accessPolicy as Record<string, unknown> | null }),
    operator,
  };
}

interface UpdateBody {
  readonly repositoryUrl?: string;
  readonly defaultBranch?: string;
  readonly allowedBranches?: string[];
  readonly accessPolicy?: Record<string, unknown> | null;
  readonly operator: string;
}

function parseUpdateBody(raw: Buffer): UpdateBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;

  const operator = requireOperator(record);
  if (operator === null) return null;

  const repositoryUrl = record['repositoryUrl'];
  if (repositoryUrl !== undefined && typeof repositoryUrl !== 'string') return null;

  const defaultBranch = record['defaultBranch'];
  if (defaultBranch !== undefined && typeof defaultBranch !== 'string') return null;

  const allowedBranches = readStringArray(record['allowedBranches']);
  if (allowedBranches === null) return null;

  const accessPolicy = record['accessPolicy'];
  if (accessPolicy !== undefined && accessPolicy !== null && typeof accessPolicy !== 'object') return null;

  return {
    ...(repositoryUrl === undefined ? {} : { repositoryUrl }),
    ...(defaultBranch === undefined ? {} : { defaultBranch }),
    ...(allowedBranches === undefined ? {} : { allowedBranches }),
    ...(accessPolicy === undefined ? {} : { accessPolicy: accessPolicy as Record<string, unknown> | null }),
    operator,
  };
}

function parseOperatorOnlyBody(raw: Buffer): { operator: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const operator = requireOperator(parsed as Record<string, unknown>);
  return operator === null ? null : { operator };
}

function checkAuth(req: IncomingMessage, deps: RepositoryRegistryDeps, logger: Logger): boolean {
  const auth = verifyOperatorToken({
    token: deps.operatorToken,
    header: req.headers[AUTHORIZATION_HEADER] as string | undefined,
  });
  if (!auth.valid) {
    logger.warn('repository registry request rejected: unauthorized', { reason: auth.reason });
    return false;
  }
  return true;
}

function mapRegistryError(error: unknown, logger: Logger): RegistryApiResult {
  if (error instanceof RegistryValidationError) {
    return { statusCode: 400, body: { error: 'invalid_request', field: error.field, detail: error.message } };
  }
  if (error instanceof RegistryEntryNotFoundError) {
    return NOT_FOUND;
  }
  if (error instanceof DuplicateActiveMappingError) {
    return { statusCode: 409, body: { error: 'conflict', detail: error.message } };
  }
  logger.error('repository registry request failed unexpectedly', { error });
  return { statusCode: 500, body: { error: 'internal_error' } };
}

export async function handleCreateRegistryEntry(
  req: IncomingMessage,
  deps: RepositoryRegistryDeps,
): Promise<RegistryApiResult> {
  const child = deps.logger.child({ route: 'repository-registry.create' });
  if (!checkAuth(req, deps, child)) return UNAUTHORIZED;
  if (deps.registry === undefined) return UNAVAILABLE;

  const read = await readRawBody(req, { maxBytes: deps.maxBodyBytes ?? REGISTRY_MAX_BODY_BYTES });
  if (!read.ok) {
    return read.reason === 'too_large' ? { statusCode: 413, body: { error: 'payload_too_large' } } : INVALID;
  }
  const parsedBody = parseCreateBody(read.body);
  if (parsedBody === null) return INVALID;

  const principal = `operator:${parsedBody.operator}`;
  try {
    const created = await deps.registry.create({
      projectIdentifier: parsedBody.projectIdentifier,
      repositoryId: parsedBody.repositoryId,
      repositoryUrl: parsedBody.repositoryUrl,
      defaultBranch: parsedBody.defaultBranch,
      allowedBranches: parsedBody.allowedBranches,
      ...(parsedBody.accessPolicy === undefined ? {} : { accessPolicy: parsedBody.accessPolicy }),
      actor: principal,
    });
    child.info('repository registry entry created via API', { repositoryId: created.repositoryId });
    return { statusCode: 201, body: serialize(created) };
  } catch (error) {
    return mapRegistryError(error, child);
  }
}

export async function handleListRegistryEntries(
  req: IncomingMessage,
  deps: RepositoryRegistryDeps,
  query: URLSearchParams,
): Promise<RegistryApiResult> {
  const child = deps.logger.child({ route: 'repository-registry.list' });
  if (!checkAuth(req, deps, child)) return UNAUTHORIZED;
  if (deps.registry === undefined) return UNAVAILABLE;

  const filter: Record<string, unknown> = {};
  const projectIdentifier = query.get('projectIdentifier');
  if (projectIdentifier !== null && projectIdentifier.trim() !== '') filter['projectIdentifier'] = projectIdentifier;
  const status = query.get('status');
  if (status === 'active' || status === 'inactive') filter['status'] = status;

  const entries = await deps.registry.list(filter);
  return { statusCode: 200, body: { entries: entries.map(serialize) } };
}

export async function handleGetRegistryEntry(
  req: IncomingMessage,
  deps: RepositoryRegistryDeps,
  id: string,
): Promise<RegistryApiResult> {
  const child = deps.logger.child({ route: 'repository-registry.get' });
  if (!checkAuth(req, deps, child)) return UNAUTHORIZED;
  if (deps.registry === undefined) return UNAVAILABLE;

  const objectId = parseObjectId(id);
  if (objectId === null) return INVALID;

  const found = await deps.registry.findById(objectId);
  if (found === null) return NOT_FOUND;
  return { statusCode: 200, body: serialize(found) };
}

export async function handleUpdateRegistryEntry(
  req: IncomingMessage,
  deps: RepositoryRegistryDeps,
  id: string,
): Promise<RegistryApiResult> {
  const child = deps.logger.child({ route: 'repository-registry.update' });
  if (!checkAuth(req, deps, child)) return UNAUTHORIZED;
  if (deps.registry === undefined) return UNAVAILABLE;

  const objectId = parseObjectId(id);
  if (objectId === null) return INVALID;

  const read = await readRawBody(req, { maxBytes: deps.maxBodyBytes ?? REGISTRY_MAX_BODY_BYTES });
  if (!read.ok) {
    return read.reason === 'too_large' ? { statusCode: 413, body: { error: 'payload_too_large' } } : INVALID;
  }
  const parsedBody = parseUpdateBody(read.body);
  if (parsedBody === null) return INVALID;

  const principal = `operator:${parsedBody.operator}`;
  try {
    const updated = await deps.registry.update(objectId, { ...parsedBody, actor: principal });
    child.info('repository registry entry updated via API', { repositoryId: updated.repositoryId });
    return { statusCode: 200, body: serialize(updated) };
  } catch (error) {
    return mapRegistryError(error, child);
  }
}

export async function handleSetRegistryEntryStatus(
  req: IncomingMessage,
  deps: RepositoryRegistryDeps,
  id: string,
  status: 'active' | 'inactive',
): Promise<RegistryApiResult> {
  const child = deps.logger.child({ route: `repository-registry.${status === 'active' ? 'reactivate' : 'deactivate'}` });
  if (!checkAuth(req, deps, child)) return UNAUTHORIZED;
  if (deps.registry === undefined) return UNAVAILABLE;

  const objectId = parseObjectId(id);
  if (objectId === null) return INVALID;

  const read = await readRawBody(req, { maxBytes: deps.maxBodyBytes ?? REGISTRY_MAX_BODY_BYTES });
  if (!read.ok) {
    return read.reason === 'too_large' ? { statusCode: 413, body: { error: 'payload_too_large' } } : INVALID;
  }
  const parsedBody = parseOperatorOnlyBody(read.body);
  if (parsedBody === null) return INVALID;

  const principal = `operator:${parsedBody.operator}`;
  try {
    const updated = await deps.registry.setStatus(objectId, status, principal);
    child.info('repository registry entry status changed via API', {
      repositoryId: updated.repositoryId,
      status,
    });
    return { statusCode: 200, body: serialize(updated) };
  } catch (error) {
    return mapRegistryError(error, child);
  }
}
