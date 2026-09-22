/**
 * Repository registry — the domain layer for `repositoryRegistry`.
 *
 * This is the sole source of truth for which GitHub repositories a run may
 * ever be pointed at. Nothing in this module, or in repository-selection/,
 * ever accepts a repository URL from anywhere else — not from a ticket, not
 * from a webhook payload, not from user input outside this collection.
 * "URL format validation is not authorization": the shape checks below only
 * run at write time, so an operator gets a clear error for a typo — they
 * are never consulted again once an entry exists. From then on,
 * authorization is simply "this value came from a document in this
 * collection."
 *
 * `_id` is an ObjectId (decision D1, consistent with every other collection
 * in this codebase) — `repositoryId` is a separate, admin-chosen stable
 * name and is deliberately NOT the primary key, because the same
 * repository may legitimately be mapped into more than one project (a
 * shared or mono-repo serving several Neutara spaces). Uniqueness that
 * actually matters — "this exact repository is not already the active
 * mapping for this exact project" — is enforced by the partial unique
 * index on (projectIdentifier, repositoryId), not by repositoryId alone.
 *
 * Write access is deliberately not exposed to the pipeline: nothing in
 * enrichment/, requirements/, orchestrator/, or repository-selection/ ever
 * calls create/update/deactivate/reactivate here — only the operator-gated
 * HTTP handlers in src/api/repository-registry.ts do.
 */

import type { Collection, Db, Filter, ObjectId } from 'mongodb';

import type { AuditLog } from '../db/audit-log.ts';
import type { Logger } from '../logging/logger.ts';
import { COLLECTIONS, type RepositoryRegistryStatus } from '../db/collections.ts';

export interface RepositoryRegistryDocument {
  _id?: ObjectId;
  projectIdentifier: string;
  repositoryId: string;
  repositoryUrl: string;
  defaultBranch: string;
  allowedBranches: string[];
  status: RepositoryRegistryStatus;
  /** Non-secret GitHub App metadata only. Never a credential or private key. */
  accessPolicy: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  updatedBy: string;
}

export interface CreateRegistryEntryInput {
  readonly projectIdentifier: string;
  readonly repositoryId: string;
  readonly repositoryUrl: string;
  readonly defaultBranch: string;
  readonly allowedBranches: readonly string[];
  readonly accessPolicy?: Record<string, unknown> | null;
  readonly actor: string;
}

export interface UpdateRegistryEntryInput {
  readonly repositoryUrl?: string;
  readonly defaultBranch?: string;
  readonly allowedBranches?: readonly string[];
  readonly accessPolicy?: Record<string, unknown> | null;
  readonly actor: string;
}

export class RegistryValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'RegistryValidationError';
    this.field = field;
  }
}

export class RegistryEntryNotFoundError extends Error {
  constructor(id: string) {
    super(`no repository registry entry for id '${id}'`);
    this.name = 'RegistryEntryNotFoundError';
  }
}

export class DuplicateActiveMappingError extends Error {
  constructor(projectIdentifier: string, repositoryId: string) {
    super(
      `an active mapping already exists for projectIdentifier '${projectIdentifier}' and ` +
        `repositoryId '${repositoryId}'`,
    );
    this.name = 'DuplicateActiveMappingError';
  }
}

/**
 * GitHub HTTPS URLs only, for this phase. SSH (`git@github.com:...`) is a
 * documented limitation, not an oversight — see docs/repository-selection.md.
 */
const GITHUB_HTTPS_URL_PATTERN =
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/;

export function isValidGitHubRepositoryUrl(url: string): boolean {
  return GITHUB_HTTPS_URL_PATTERN.test(url.trim());
}

/**
 * A conservative subset of valid git ref-name characters: no spaces, no
 * control characters, no `..`, no leading/trailing slash. Deliberately
 * stricter than git actually allows — this only needs to safely represent
 * branch names we expect to see, not the full ref-name grammar.
 */
const BRANCH_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

/** An exact branch name: one or more `/`-separated segments, each matching BRANCH_SEGMENT_PATTERN. */
export function isValidBranchName(value: string): boolean {
  if (value.trim() === '' || value !== value.trim()) return false;
  if (value.startsWith('/') || value.endsWith('/') || value.includes('..')) return false;
  return value.split('/').every((segment) => BRANCH_SEGMENT_PATTERN.test(segment));
}

/**
 * A branch pattern is an exact-name prefix followed by a single trailing
 * `/*` wildcard segment (e.g. `feature/*`, `bugfix/*`) — deliberately not a
 * general glob grammar. This is a chosen, minimal pattern shape matching
 * exactly the examples the business decision named; it is not an inference
 * about what git or GitHub itself supports.
 */
export function isValidBranchPattern(value: string): boolean {
  if (!value.endsWith('/*')) return false;
  const prefix = value.slice(0, -2);
  return prefix !== '' && isValidBranchName(prefix);
}

/** Either an exact name or a `prefix/*` pattern. */
export function isValidBranchNameOrPattern(value: string): boolean {
  return isValidBranchName(value) || isValidBranchPattern(value);
}

/** Whether `branch` is authorized by any entry in `allowedBranches` (exact match or prefix-wildcard match). */
export function matchesAllowedBranch(branch: string, allowedBranches: readonly string[]): boolean {
  return allowedBranches.some((allowed) => {
    if (allowed.endsWith('/*')) return branch.startsWith(allowed.slice(0, -1));
    return branch === allowed;
  });
}

function validateEntryShape(input: {
  repositoryUrl: string;
  defaultBranch: string;
  allowedBranches: readonly string[];
}): void {
  if (!isValidGitHubRepositoryUrl(input.repositoryUrl)) {
    throw new RegistryValidationError(
      'repositoryUrl',
      `'${input.repositoryUrl}' is not a supported GitHub repository URL ` +
        '(expected https://github.com/<org>/<repo>)',
    );
  }
  if (input.allowedBranches.length === 0) {
    throw new RegistryValidationError('allowedBranches', 'at least one allowed branch or pattern is required');
  }
  for (const branch of input.allowedBranches) {
    if (!isValidBranchNameOrPattern(branch)) {
      throw new RegistryValidationError(
        'allowedBranches',
        `'${branch}' is not a valid branch name or pattern (e.g. 'main' or 'feature/*')`,
      );
    }
  }
  if (!isValidBranchName(input.defaultBranch)) {
    throw new RegistryValidationError('defaultBranch', `'${input.defaultBranch}' is not a valid branch name`);
  }
  // Requirement: "ensure the default branch is authorized."
  if (!matchesAllowedBranch(input.defaultBranch, input.allowedBranches)) {
    throw new RegistryValidationError(
      'defaultBranch',
      `defaultBranch '${input.defaultBranch}' is not covered by allowedBranches`,
    );
  }
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;
}

export interface RepositoryRegistryRepository {
  create(input: CreateRegistryEntryInput): Promise<RepositoryRegistryDocument>;
  findById(id: ObjectId): Promise<RepositoryRegistryDocument | null>;
  list(filter?: Filter<RepositoryRegistryDocument>): Promise<RepositoryRegistryDocument[]>;
  findActiveByProjectIdentifier(projectIdentifier: string): Promise<RepositoryRegistryDocument[]>;
  update(id: ObjectId, input: UpdateRegistryEntryInput): Promise<RepositoryRegistryDocument>;
  setStatus(id: ObjectId, status: RepositoryRegistryStatus, actor: string): Promise<RepositoryRegistryDocument>;
}

export function createRepositoryRegistryRepository(
  db: Db,
  audit: AuditLog,
  logger: Logger,
): RepositoryRegistryRepository {
  const collection: Collection<RepositoryRegistryDocument> = db.collection(COLLECTIONS.repositoryRegistry);

  return {
    async create(input: CreateRegistryEntryInput): Promise<RepositoryRegistryDocument> {
      validateEntryShape(input);

      const now = new Date();
      const document: RepositoryRegistryDocument = {
        projectIdentifier: input.projectIdentifier,
        repositoryId: input.repositoryId,
        repositoryUrl: input.repositoryUrl,
        defaultBranch: input.defaultBranch,
        allowedBranches: [...input.allowedBranches],
        status: 'active',
        accessPolicy: input.accessPolicy ?? null,
        createdAt: now,
        updatedAt: now,
        createdBy: input.actor,
        updatedBy: input.actor,
      };

      let insertedId: ObjectId;
      try {
        insertedId = (await collection.insertOne(document)).insertedId;
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        throw new DuplicateActiveMappingError(input.projectIdentifier, input.repositoryId);
      }

      await audit.append({
        actor: input.actor,
        action: 'repository-registry.created',
        subjectType: 'repositoryRegistryEntry',
        subjectId: insertedId,
        detail: { projectIdentifier: input.projectIdentifier, repositoryId: input.repositoryId },
      });

      logger.info('repository registry entry created', {
        projectIdentifier: input.projectIdentifier,
        repositoryId: input.repositoryId,
      });
      return { ...document, _id: insertedId };
    },

    async findById(id: ObjectId): Promise<RepositoryRegistryDocument | null> {
      return collection.findOne({ _id: id });
    },

    async list(filter: Filter<RepositoryRegistryDocument> = {}): Promise<RepositoryRegistryDocument[]> {
      return collection.find(filter).sort({ createdAt: -1 }).toArray();
    },

    async findActiveByProjectIdentifier(projectIdentifier: string): Promise<RepositoryRegistryDocument[]> {
      return collection.find({ projectIdentifier, status: 'active' }).toArray();
    },

    async update(id: ObjectId, input: UpdateRegistryEntryInput): Promise<RepositoryRegistryDocument> {
      const existing = await collection.findOne({ _id: id });
      if (existing === null) throw new RegistryEntryNotFoundError(id.toHexString());

      const merged = {
        repositoryUrl: input.repositoryUrl ?? existing.repositoryUrl,
        defaultBranch: input.defaultBranch ?? existing.defaultBranch,
        allowedBranches: input.allowedBranches ? [...input.allowedBranches] : existing.allowedBranches,
      };
      validateEntryShape(merged);

      const now = new Date();
      const updated = await collection.findOneAndUpdate(
        { _id: id },
        {
          $set: {
            ...merged,
            accessPolicy: input.accessPolicy === undefined ? existing.accessPolicy : input.accessPolicy,
            updatedAt: now,
            updatedBy: input.actor,
          },
        },
        { returnDocument: 'after' },
      );
      if (updated === null) throw new RegistryEntryNotFoundError(id.toHexString());

      await audit.append({
        actor: input.actor,
        action: 'repository-registry.updated',
        subjectType: 'repositoryRegistryEntry',
        subjectId: id,
        detail: { repositoryId: updated.repositoryId },
      });

      logger.info('repository registry entry updated', { repositoryId: updated.repositoryId });
      return updated;
    },

    async setStatus(
      id: ObjectId,
      status: RepositoryRegistryStatus,
      actor: string,
    ): Promise<RepositoryRegistryDocument> {
      const now = new Date();
      let updated;
      try {
        updated = await collection.findOneAndUpdate(
          { _id: id },
          { $set: { status, updatedAt: now, updatedBy: actor } },
          { returnDocument: 'after' },
        );
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        // Reactivating this entry would collide with the partial unique
        // index: another entry is already the active mapping for the same
        // (projectIdentifier, repositoryId) pair.
        const current = await collection.findOne({ _id: id });
        throw new DuplicateActiveMappingError(
          current?.projectIdentifier ?? '(unknown)',
          current?.repositoryId ?? '(unknown)',
        );
      }
      if (updated === null) throw new RegistryEntryNotFoundError(id.toHexString());

      await audit.append({
        actor,
        action: 'repository-registry.status-changed',
        subjectType: 'repositoryRegistryEntry',
        subjectId: id,
        detail: { repositoryId: updated.repositoryId, status },
      });

      logger.info('repository registry entry status changed', { repositoryId: updated.repositoryId, status });
      return updated;
    },
  };
}
