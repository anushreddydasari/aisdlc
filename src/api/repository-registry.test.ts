import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import type { IncomingMessage } from 'node:http';
import { ObjectId } from 'mongodb';

import {
  DuplicateActiveMappingError,
  RegistryEntryNotFoundError,
  RegistryValidationError,
  type RepositoryRegistryDocument,
  type RepositoryRegistryRepository,
} from '../repository-registry/repository.ts';
import { createLogger } from '../logging/logger.ts';
import { BEARER_PREFIX } from './operator-auth.ts';
import {
  handleCreateRegistryEntry,
  handleGetRegistryEntry,
  handleListRegistryEntries,
  handleSetRegistryEntryStatus,
  handleUpdateRegistryEntry,
  type RepositoryRegistryDeps,
} from './repository-registry.ts';

const TOKEN = 'op_test_token_value_not_real'; // pragma: fixture

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

function entry(overrides: Partial<RepositoryRegistryDocument> = {}): RepositoryRegistryDocument {
  const now = new Date('2026-09-22T00:00:00.000Z');
  return {
    _id: new ObjectId(),
    projectIdentifier: 'CF',
    repositoryId: 'aisdlc-service',
    repositoryUrl: 'https://github.com/cloudfuze/aisdlc-service',
    defaultBranch: 'main',
    allowedBranches: ['main', 'feature/*'],
    status: 'active',
    accessPolicy: null,
    createdAt: now,
    updatedAt: now,
    createdBy: 'operator:alice',
    updatedBy: 'operator:alice',
    ...overrides,
  };
}

interface Harness {
  readonly deps: RepositoryRegistryDeps;
  readonly store: RepositoryRegistryDocument[];
  readonly calls: { method: string; args: unknown[] }[];
}

function harness(
  options: {
    token?: string | undefined;
    noDatabase?: boolean;
    seed?: RepositoryRegistryDocument[];
    throwOn?: 'validation' | 'not_found' | 'duplicate' | 'unexpected';
  } = {},
): Harness {
  const store = options.seed ?? [entry()];
  const calls: Harness['calls'] = [];

  function maybeThrow(): void {
    if (options.throwOn === 'validation') throw new RegistryValidationError('repositoryUrl', 'bad url');
    if (options.throwOn === 'not_found') throw new RegistryEntryNotFoundError('missing');
    if (options.throwOn === 'duplicate') throw new DuplicateActiveMappingError('CF', 'aisdlc-service');
    if (options.throwOn === 'unexpected') throw new Error('mongo exploded');
  }

  const registry: RepositoryRegistryRepository = {
    async create(input) {
      calls.push({ method: 'create', args: [input] });
      maybeThrow();
      const created = entry({
        _id: new ObjectId(),
        projectIdentifier: input.projectIdentifier,
        repositoryId: input.repositoryId,
        repositoryUrl: input.repositoryUrl,
        defaultBranch: input.defaultBranch,
        allowedBranches: [...input.allowedBranches],
        accessPolicy: input.accessPolicy ?? null,
        createdBy: input.actor,
        updatedBy: input.actor,
      });
      store.push(created);
      return created;
    },
    async findById(id) {
      calls.push({ method: 'findById', args: [id] });
      return store.find((e) => e._id?.equals(id)) ?? null;
    },
    async list(filter = {}) {
      calls.push({ method: 'list', args: [filter] });
      return store.filter((e) =>
        Object.entries(filter).every(
          ([key, value]) => (e as unknown as Record<string, unknown>)[key] === value,
        ),
      );
    },
    async findActiveByProjectIdentifier(projectIdentifier) {
      calls.push({ method: 'findActiveByProjectIdentifier', args: [projectIdentifier] });
      return store.filter((e) => e.projectIdentifier === projectIdentifier && e.status === 'active');
    },
    async update(id, input) {
      calls.push({ method: 'update', args: [id, input] });
      maybeThrow();
      const found = store.find((e) => e._id?.equals(id));
      if (!found) throw new RegistryEntryNotFoundError(id.toHexString());
      Object.assign(found, {
        ...(input.repositoryUrl === undefined ? {} : { repositoryUrl: input.repositoryUrl }),
        ...(input.defaultBranch === undefined ? {} : { defaultBranch: input.defaultBranch }),
        ...(input.allowedBranches === undefined ? {} : { allowedBranches: [...input.allowedBranches] }),
        updatedBy: input.actor,
      });
      return found;
    },
    async setStatus(id, status, actor) {
      calls.push({ method: 'setStatus', args: [id, status, actor] });
      maybeThrow();
      const found = store.find((e) => e._id?.equals(id));
      if (!found) throw new RegistryEntryNotFoundError(id.toHexString());
      found.status = status;
      found.updatedBy = actor;
      return found;
    },
  };

  return {
    deps: {
      logger: createLogger({ write: () => {} }),
      operatorToken: 'token' in options ? options.token : TOKEN,
      registry: options.noDatabase ? undefined : registry,
    },
    store,
    calls,
  };
}

describe('authentication', () => {
  it('refuses create with no operator token configured', async () => {
    const h = harness({ token: undefined });
    const result = await handleCreateRegistryEntry(request({ operator: 'alice' }), h.deps);
    assert.equal(result.statusCode, 401);
  });

  it('refuses list with a wrong bearer token', async () => {
    const h = harness();
    const req = request(null, { authorization: `${BEARER_PREFIX}wrong` });
    const result = await handleListRegistryEntries(req, h.deps, new URLSearchParams());
    assert.equal(result.statusCode, 401);
  });

  it('answers 503 when the database is unavailable, even with a valid token', async () => {
    const h = harness({ noDatabase: true });
    const result = await handleCreateRegistryEntry(request({ operator: 'alice' }), h.deps);
    assert.equal(result.statusCode, 503);
  });
});

describe('handleCreateRegistryEntry', () => {
  const VALID_BODY = {
    projectIdentifier: 'CF',
    repositoryId: 'aisdlc-service',
    repositoryUrl: 'https://github.com/cloudfuze/aisdlc-service',
    defaultBranch: 'main',
    allowedBranches: ['main', 'feature/*'],
    operator: 'alice',
  };

  it('creates an entry and returns 201 with the operator: prefix applied to actor', async () => {
    const h = harness({ seed: [] });
    const result = await handleCreateRegistryEntry(request(VALID_BODY), h.deps);

    assert.equal(result.statusCode, 201);
    assert.equal(result.body['projectIdentifier'], 'CF');
    assert.equal(h.calls[0]!.args[0] && (h.calls[0]!.args[0] as { actor: string }).actor, 'operator:alice');
  });

  it('rejects a body missing the operator field', async () => {
    const h = harness({ seed: [] });
    const { operator: _drop, ...rest } = VALID_BODY;
    const result = await handleCreateRegistryEntry(request(rest), h.deps);
    assert.equal(result.statusCode, 400);
  });

  it('rejects malformed JSON', async () => {
    const h = harness({ seed: [] });
    const result = await handleCreateRegistryEntry(request(Buffer.from('{not json')), h.deps);
    assert.equal(result.statusCode, 400);
  });

  it('maps RegistryValidationError to 400 with the offending field named', async () => {
    const h = harness({ seed: [], throwOn: 'validation' });
    const result = await handleCreateRegistryEntry(request(VALID_BODY), h.deps);
    assert.equal(result.statusCode, 400);
    assert.equal(result.body['field'], 'repositoryUrl');
  });

  it('maps DuplicateActiveMappingError to 409', async () => {
    const h = harness({ seed: [], throwOn: 'duplicate' });
    const result = await handleCreateRegistryEntry(request(VALID_BODY), h.deps);
    assert.equal(result.statusCode, 409);
  });

  it('maps an unexpected error to 500', async () => {
    const h = harness({ seed: [], throwOn: 'unexpected' });
    const result = await handleCreateRegistryEntry(request(VALID_BODY), h.deps);
    assert.equal(result.statusCode, 500);
  });
});

describe('handleListRegistryEntries', () => {
  it('lists every entry with no query filters', async () => {
    const h = harness({ seed: [entry(), entry({ _id: new ObjectId(), repositoryId: 'other' })] });
    const result = await handleListRegistryEntries(request(null), h.deps, new URLSearchParams());
    assert.equal(result.statusCode, 200);
    assert.equal((result.body['entries'] as unknown[]).length, 2);
  });

  it('filters by projectIdentifier and status query params', async () => {
    const h = harness({
      seed: [
        entry({ projectIdentifier: 'CF', status: 'active' }),
        entry({ _id: new ObjectId(), projectIdentifier: 'OTHER', status: 'active' }),
      ],
    });
    const result = await handleListRegistryEntries(
      request(null),
      h.deps,
      new URLSearchParams({ projectIdentifier: 'CF', status: 'active' }),
    );
    assert.equal((result.body['entries'] as { projectIdentifier: string }[]).length, 1);
  });
});

describe('handleGetRegistryEntry', () => {
  it('returns 200 with the serialized entry when found', async () => {
    const h = harness();
    const id = h.store[0]!._id!.toHexString();
    const result = await handleGetRegistryEntry(request(null), h.deps, id);
    assert.equal(result.statusCode, 200);
    assert.equal(result.body['id'], id);
  });

  it('returns 404 for an id that does not exist', async () => {
    const h = harness();
    const result = await handleGetRegistryEntry(request(null), h.deps, new ObjectId().toHexString());
    assert.equal(result.statusCode, 404);
  });

  it('returns 400 for a malformed id', async () => {
    const h = harness();
    const result = await handleGetRegistryEntry(request(null), h.deps, 'not-an-object-id');
    assert.equal(result.statusCode, 400);
  });
});

describe('handleUpdateRegistryEntry', () => {
  it('updates fields and returns 200', async () => {
    const h = harness();
    const id = h.store[0]!._id!.toHexString();
    const result = await handleUpdateRegistryEntry(
      request({ defaultBranch: 'main', allowedBranches: ['main'], operator: 'bob' }),
      h.deps,
      id,
    );
    assert.equal(result.statusCode, 200);
    assert.equal(result.body['updatedBy'], 'operator:bob');
  });

  it('returns 404 via RegistryEntryNotFoundError for an unknown id', async () => {
    const h = harness({ throwOn: 'not_found' });
    const result = await handleUpdateRegistryEntry(
      request({ operator: 'bob' }),
      h.deps,
      h.store[0]!._id!.toHexString(),
    );
    assert.equal(result.statusCode, 404);
  });

  it('rejects a body missing operator', async () => {
    const h = harness();
    const result = await handleUpdateRegistryEntry(
      request({ defaultBranch: 'main' }),
      h.deps,
      h.store[0]!._id!.toHexString(),
    );
    assert.equal(result.statusCode, 400);
  });
});

describe('handleSetRegistryEntryStatus', () => {
  it('deactivates an entry', async () => {
    const h = harness();
    const id = h.store[0]!._id!.toHexString();
    const result = await handleSetRegistryEntryStatus(request({ operator: 'bob' }), h.deps, id, 'inactive');
    assert.equal(result.statusCode, 200);
    assert.equal(result.body['status'], 'inactive');
  });

  it('reactivates an entry', async () => {
    const h = harness({ seed: [entry({ status: 'inactive' })] });
    const id = h.store[0]!._id!.toHexString();
    const result = await handleSetRegistryEntryStatus(request({ operator: 'bob' }), h.deps, id, 'active');
    assert.equal(result.statusCode, 200);
    assert.equal(result.body['status'], 'active');
  });

  it('maps DuplicateActiveMappingError to 409 on reactivation conflict', async () => {
    const h = harness({ throwOn: 'duplicate' });
    const id = h.store[0]!._id!.toHexString();
    const result = await handleSetRegistryEntryStatus(request({ operator: 'bob' }), h.deps, id, 'active');
    assert.equal(result.statusCode, 409);
  });
});
