import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import type { IncomingMessage } from 'node:http';
import { ObjectId } from 'mongodb';

import {
  SelectionConflictError,
  SelectionNotFoundError,
  SelectionValidationError,
  type RepositorySelectionDocument,
  type RepositorySelectionRepository,
} from '../repository-selection/repository.ts';
import type { RepositoryRegistryDocument, RepositoryRegistryRepository } from '../repository-registry/repository.ts';
import { createLogger } from '../logging/logger.ts';
import { BEARER_PREFIX } from './operator-auth.ts';
import { handleConfirmRepositorySelection, type RepositorySelectionDeps } from './repository-selection.ts';

const TOKEN = 'op_test_token_value_not_real'; // pragma: fixture
const NOW = new Date('2026-09-22T00:00:00.000Z');

function request(
  body: Record<string, unknown> | Buffer | null,
  headers: Record<string, string | undefined> = {},
): IncomingMessage {
  const buf = body === null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const stream = Readable.from([buf]) as unknown as IncomingMessage;
  stream.headers = {
    authorization: `${BEARER_PREFIX}${TOKEN}`,
    ...headers,
  } as IncomingMessage['headers'];
  return stream;
}

function selectionDoc(overrides: Partial<RepositorySelectionDocument> = {}): RepositorySelectionDocument {
  return {
    _id: new ObjectId(),
    runId: new ObjectId(),
    intakeItemId: new ObjectId(),
    issueKey: 'CF-1',
    projectIdentifier: 'CF',
    candidateRepositoryIds: ['aisdlc-service'],
    selectedRepositoryId: null,
    selectedRepositoryUrl: null,
    selectedDefaultBranch: null,
    selectedAllowedBranches: null,
    selectedAccessPolicy: null,
    status: 'pending',
    failureReason: null,
    attempts: 0,
    nextAttemptAt: NOW,
    confirmedBy: null,
    confirmedAt: null,
    lastNotifiedStatus: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function registryEntry(overrides: Partial<RepositoryRegistryDocument> = {}): RepositoryRegistryDocument {
  return {
    _id: new ObjectId(),
    projectIdentifier: 'CF',
    repositoryId: 'aisdlc-service',
    repositoryUrl: 'https://github.com/cloudfuze/aisdlc-service',
    defaultBranch: 'main',
    allowedBranches: ['main'],
    status: 'active',
    accessPolicy: null,
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: 'operator:alice',
    updatedBy: 'operator:alice',
    ...overrides,
  };
}

interface Harness {
  readonly deps: RepositorySelectionDeps;
  readonly confirmCalls: unknown[];
}

function harness(
  options: {
    token?: string | undefined;
    noDatabase?: boolean;
    selection?: RepositorySelectionDocument | null;
    activeEntries?: RepositoryRegistryDocument[];
    throwOn?: 'not_found' | 'conflict' | 'validation' | 'unexpected';
  } = {},
): Harness {
  const stored = 'selection' in options ? options.selection : selectionDoc();
  const confirmCalls: unknown[] = [];

  const selections: RepositorySelectionRepository = {
    async findByRunId() {
      return stored ?? null;
    },
    async createInitial() {
      throw new Error('must not be called');
    },
    async recordMatchResult() {
      throw new Error('must not be called');
    },
    async confirm(runId, input) {
      confirmCalls.push({ runId, input });
      if (options.throwOn === 'not_found') throw new SelectionNotFoundError(runId);
      if (options.throwOn === 'conflict') throw new SelectionConflictError(runId, "is 'selected', not pending or ambiguous");
      if (options.throwOn === 'validation') {
        throw new SelectionValidationError('repositoryId', 'not among candidates');
      }
      if (options.throwOn === 'unexpected') throw new Error('mongo exploded');
      return {
        ...(stored ?? selectionDoc()),
        status: 'selected',
        selectedRepositoryId: input.repositoryId,
        selectedRepositoryUrl: input.repositoryUrl,
        selectedDefaultBranch: input.defaultBranch,
        selectedAllowedBranches: [...input.allowedBranches],
        selectedAccessPolicy: input.accessPolicy,
        confirmedBy: input.confirmedBy,
        confirmedAt: NOW,
      };
    },
    async findDueForRetry() {
      return [];
    },
  };

  const registry: RepositoryRegistryRepository = {
    async create() {
      throw new Error('must not be called');
    },
    async findById() {
      throw new Error('must not be called');
    },
    async list() {
      throw new Error('must not be called');
    },
    async findActiveByProjectIdentifier() {
      return options.activeEntries ?? [registryEntry()];
    },
    async update() {
      throw new Error('must not be called');
    },
    async setStatus() {
      throw new Error('must not be called');
    },
  };

  return {
    deps: {
      logger: createLogger({ write: () => {} }),
      operatorToken: 'token' in options ? options.token : TOKEN,
      selections: options.noDatabase ? undefined : selections,
      registry: options.noDatabase ? undefined : registry,
    },
    confirmCalls,
  };
}

const VALID_BODY = { repositoryId: 'aisdlc-service', operator: 'alice' };

describe('authentication', () => {
  it('refuses a request with no operator token configured', async () => {
    const h = harness({ token: undefined });
    const result = await handleConfirmRepositorySelection(request(VALID_BODY), h.deps, new ObjectId().toHexString());
    assert.equal(result.statusCode, 401);
  });

  it('refuses a wrong bearer token', async () => {
    const h = harness();
    const req = request(VALID_BODY, { authorization: `${BEARER_PREFIX}wrong` });
    const result = await handleConfirmRepositorySelection(req, h.deps, new ObjectId().toHexString());
    assert.equal(result.statusCode, 401);
  });

  it('answers 503 when the database is unavailable, even with a valid token', async () => {
    const h = harness({ noDatabase: true });
    const result = await handleConfirmRepositorySelection(request(VALID_BODY), h.deps, new ObjectId().toHexString());
    assert.equal(result.statusCode, 503);
  });
});

describe('handleConfirmRepositorySelection', () => {
  it('confirms using the CURRENT registry entry, not stale request data', async () => {
    const h = harness();
    const runId = new ObjectId().toHexString();
    const result = await handleConfirmRepositorySelection(request(VALID_BODY), h.deps, runId);

    assert.equal(result.statusCode, 200);
    assert.equal(result.body['status'], 'selected');
    assert.equal(result.body['selectedRepositoryId'], 'aisdlc-service');
    assert.equal(
      (h.confirmCalls[0] as { input: { repositoryUrl: string } }).input.repositoryUrl,
      'https://github.com/cloudfuze/aisdlc-service',
    );
  });

  it('returns 400 for a malformed runId', async () => {
    const h = harness();
    const result = await handleConfirmRepositorySelection(request(VALID_BODY), h.deps, 'not-an-object-id');
    assert.equal(result.statusCode, 400);
  });

  it('returns 404 when no selection exists for the runId', async () => {
    const h = harness({ selection: null });
    const result = await handleConfirmRepositorySelection(request(VALID_BODY), h.deps, new ObjectId().toHexString());
    assert.equal(result.statusCode, 404);
  });

  it('rejects a body missing repositoryId', async () => {
    const h = harness();
    const result = await handleConfirmRepositorySelection(
      request({ operator: 'alice' }),
      h.deps,
      new ObjectId().toHexString(),
    );
    assert.equal(result.statusCode, 400);
  });

  it('rejects malformed JSON', async () => {
    const h = harness();
    const result = await handleConfirmRepositorySelection(
      request(Buffer.from('{not json')),
      h.deps,
      new ObjectId().toHexString(),
    );
    assert.equal(result.statusCode, 400);
  });

  it('returns 409 when the chosen repositoryId is not currently an active mapping', async () => {
    const h = harness({ activeEntries: [registryEntry({ repositoryId: 'some-other-repo' })] });
    const result = await handleConfirmRepositorySelection(request(VALID_BODY), h.deps, new ObjectId().toHexString());
    assert.equal(result.statusCode, 409);
  });

  it('maps SelectionConflictError to 409', async () => {
    const h = harness({ throwOn: 'conflict' });
    const result = await handleConfirmRepositorySelection(request(VALID_BODY), h.deps, new ObjectId().toHexString());
    assert.equal(result.statusCode, 409);
  });

  it('maps SelectionValidationError to 400', async () => {
    const h = harness({ throwOn: 'validation' });
    const result = await handleConfirmRepositorySelection(request(VALID_BODY), h.deps, new ObjectId().toHexString());
    assert.equal(result.statusCode, 400);
  });

  it('maps an unexpected error to 500', async () => {
    const h = harness({ throwOn: 'unexpected' });
    const result = await handleConfirmRepositorySelection(request(VALID_BODY), h.deps, new ObjectId().toHexString());
    assert.equal(result.statusCode, 500);
  });
});
