import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId, type Db } from 'mongodb';

import type { AuditEntryInput, AuditLog } from '../db/audit-log.ts';
import { createLogger } from '../logging/logger.ts';
import {
  DuplicateActiveMappingError,
  RegistryEntryNotFoundError,
  RegistryValidationError,
  createRepositoryRegistryRepository,
  isValidBranchName,
  isValidBranchNameOrPattern,
  isValidBranchPattern,
  isValidGitHubRepositoryUrl,
  matchesAllowedBranch,
  type RepositoryRegistryDocument,
} from './repository.ts';

const logger = createLogger({ write: () => {} });

const VALID_INPUT = {
  projectIdentifier: 'CF',
  repositoryId: 'aisdlc-service',
  repositoryUrl: 'https://github.com/cloudfuze/aisdlc-service',
  defaultBranch: 'main',
  allowedBranches: ['main', 'feature/*'],
  actor: 'operator:alice',
};

interface Harness {
  readonly db: Db;
  readonly audit: AuditLog;
  readonly store: RepositoryRegistryDocument[];
  readonly auditEntries: AuditEntryInput[];
  failNextWriteWithDuplicate(): void;
}

function harness(seed: RepositoryRegistryDocument[] = []): Harness {
  const store = [...seed];
  let duplicateNext = false;

  const matches = (doc: RepositoryRegistryDocument, filter: Record<string, unknown>): boolean =>
    Object.entries(filter).every(([key, value]) => {
      const actual = (doc as unknown as Record<string, unknown>)[key];
      if (value instanceof ObjectId) return actual instanceof ObjectId && actual.equals(value);
      return actual === value;
    });

  const collection = {
    async findOne(filter: Record<string, unknown>) {
      const found = store.find((doc) => matches(doc, filter));
      return found ? { ...found } : null;
    },
    find(filter: Record<string, unknown> = {}) {
      const results = store.filter((doc) => matches(doc, filter)).map((doc) => ({ ...doc }));
      return {
        sort() {
          return this;
        },
        async toArray() {
          return results;
        },
      };
    },
    async insertOne(document: RepositoryRegistryDocument) {
      if (duplicateNext) {
        duplicateNext = false;
        throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      }
      const _id = new ObjectId();
      store.push({ ...document, _id });
      return { insertedId: _id, acknowledged: true };
    },
    async findOneAndUpdate(
      filter: Record<string, unknown>,
      update: { $set: Partial<RepositoryRegistryDocument> },
    ) {
      const found = store.find((doc) => matches(doc, filter));
      if (!found) return null;
      if (duplicateNext) {
        duplicateNext = false;
        throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      }
      Object.assign(found, update.$set);
      return { ...found };
    },
  };

  const db = { collection: () => collection } as unknown as Db;

  const auditEntries: AuditEntryInput[] = [];
  const audit: AuditLog = {
    async append(entry: AuditEntryInput) {
      auditEntries.push(entry);
      return new ObjectId();
    },
    async query() {
      return [];
    },
  };

  return {
    db,
    audit,
    store,
    auditEntries,
    failNextWriteWithDuplicate(): void {
      duplicateNext = true;
    },
  };
}

describe('isValidGitHubRepositoryUrl', () => {
  it('accepts a plain https://github.com/<org>/<repo> URL', () => {
    assert.equal(isValidGitHubRepositoryUrl('https://github.com/cloudfuze/aisdlc-service'), true);
  });

  it('accepts a trailing .git suffix and trailing slash', () => {
    assert.equal(isValidGitHubRepositoryUrl('https://github.com/cloudfuze/aisdlc-service.git'), true);
    assert.equal(isValidGitHubRepositoryUrl('https://github.com/cloudfuze/aisdlc-service/'), true);
  });

  it('rejects an SSH URL', () => {
    assert.equal(isValidGitHubRepositoryUrl('git@github.com:cloudfuze/aisdlc-service.git'), false);
  });

  it('rejects a non-github host', () => {
    assert.equal(isValidGitHubRepositoryUrl('https://gitlab.com/cloudfuze/aisdlc-service'), false);
  });

  it('rejects a URL missing the repo segment', () => {
    assert.equal(isValidGitHubRepositoryUrl('https://github.com/cloudfuze'), false);
  });
});

describe('isValidBranchName / isValidBranchPattern', () => {
  it('accepts simple exact names', () => {
    assert.equal(isValidBranchName('main'), true);
    assert.equal(isValidBranchName('develop'), true);
    assert.equal(isValidBranchName('release/1.0'), true);
  });

  it('rejects an empty string, whitespace, or a leading/trailing slash', () => {
    assert.equal(isValidBranchName(''), false);
    assert.equal(isValidBranchName('  main  '), false);
    assert.equal(isValidBranchName('/main'), false);
    assert.equal(isValidBranchName('main/'), false);
  });

  it('rejects a path-traversal-like `..` segment', () => {
    assert.equal(isValidBranchName('feature/../main'), false);
  });

  it('accepts feature/* and bugfix/* as patterns, not exact names', () => {
    assert.equal(isValidBranchPattern('feature/*'), true);
    assert.equal(isValidBranchPattern('bugfix/*'), true);
    assert.equal(isValidBranchName('feature/*'), false);
  });

  it('rejects a bare `*` or a pattern with no prefix', () => {
    assert.equal(isValidBranchPattern('*'), false);
    assert.equal(isValidBranchPattern('/*'), false);
  });

  it('rejects a wildcard anywhere other than a trailing /* segment', () => {
    assert.equal(isValidBranchPattern('feature/*/extra'), false);
    assert.equal(isValidBranchNameOrPattern('fea*ture'), false);
  });
});

describe('matchesAllowedBranch', () => {
  it('matches an exact name', () => {
    assert.equal(matchesAllowedBranch('main', ['main', 'develop']), true);
    assert.equal(matchesAllowedBranch('staging', ['main', 'develop']), false);
  });

  it('matches a prefix wildcard', () => {
    assert.equal(matchesAllowedBranch('feature/login', ['feature/*']), true);
    assert.equal(matchesAllowedBranch('feature', ['feature/*']), false, 'the prefix itself is not a match');
    assert.equal(matchesAllowedBranch('bugfix/login', ['feature/*']), false);
  });
});

describe('create', () => {
  it('creates an active entry, returns it with an ObjectId _id, and appends an audit entry', async () => {
    const { db, audit, store, auditEntries } = harness();
    const repo = createRepositoryRegistryRepository(db, audit, logger);

    const created = await repo.create(VALID_INPUT);

    assert.ok(created._id instanceof ObjectId);
    assert.equal(created.status, 'active');
    assert.equal(created.createdBy, 'operator:alice');
    assert.equal(created.updatedBy, 'operator:alice');
    assert.equal(store.length, 1);

    assert.equal(auditEntries.length, 1);
    assert.equal(auditEntries[0]!.action, 'repository-registry.created');
    assert.equal(auditEntries[0]!.actor, 'operator:alice');
    assert.equal(auditEntries[0]!.subjectType, 'repositoryRegistryEntry');
    assert.ok(auditEntries[0]!.subjectId.equals(created._id!));
  });

  it('rejects a non-GitHub-HTTPS repositoryUrl', async () => {
    const { db, audit } = harness();
    const repo = createRepositoryRegistryRepository(db, audit, logger);

    await assert.rejects(
      () => repo.create({ ...VALID_INPUT, repositoryUrl: 'git@github.com:cloudfuze/aisdlc-service.git' }),
      (error: unknown) => error instanceof RegistryValidationError && error.field === 'repositoryUrl',
    );
  });

  it('rejects empty allowedBranches', async () => {
    const { db, audit } = harness();
    const repo = createRepositoryRegistryRepository(db, audit, logger);

    await assert.rejects(
      () => repo.create({ ...VALID_INPUT, allowedBranches: [] }),
      (error: unknown) => error instanceof RegistryValidationError && error.field === 'allowedBranches',
    );
  });

  it('rejects an invalid entry inside allowedBranches', async () => {
    const { db, audit } = harness();
    const repo = createRepositoryRegistryRepository(db, audit, logger);

    await assert.rejects(
      () => repo.create({ ...VALID_INPUT, allowedBranches: ['main', 'fea*ture'] }),
      (error: unknown) => error instanceof RegistryValidationError && error.field === 'allowedBranches',
    );
  });

  it('rejects a defaultBranch not covered by allowedBranches', async () => {
    const { db, audit } = harness();
    const repo = createRepositoryRegistryRepository(db, audit, logger);

    await assert.rejects(
      () => repo.create({ ...VALID_INPUT, defaultBranch: 'staging' }),
      (error: unknown) => error instanceof RegistryValidationError && error.field === 'defaultBranch',
    );
  });

  it('accepts a defaultBranch covered only by a wildcard pattern', async () => {
    const { db, audit } = harness();
    const repo = createRepositoryRegistryRepository(db, audit, logger);

    const created = await repo.create({
      ...VALID_INPUT,
      defaultBranch: 'feature/main',
      allowedBranches: ['feature/*'],
    });

    assert.equal(created.defaultBranch, 'feature/main');
  });

  it('throws DuplicateActiveMappingError on a concurrent duplicate active mapping', async () => {
    const { db, audit, failNextWriteWithDuplicate } = harness();
    const repo = createRepositoryRegistryRepository(db, audit, logger);

    failNextWriteWithDuplicate();
    await assert.rejects(() => repo.create(VALID_INPUT), DuplicateActiveMappingError);
  });
});

describe('findById', () => {
  it('returns null when nothing has been created', async () => {
    const { db, audit } = harness();
    const repo = createRepositoryRegistryRepository(db, audit, logger);
    assert.equal(await repo.findById(new ObjectId()), null);
  });

  it('returns the stored entry', async () => {
    const { db, audit } = harness();
    const repo = createRepositoryRegistryRepository(db, audit, logger);
    const created = await repo.create(VALID_INPUT);

    const found = await repo.findById(created._id!);
    assert.equal(found?.repositoryId, 'aisdlc-service');
  });
});

describe('list / findActiveByProjectIdentifier', () => {
  it('list returns every entry regardless of status', async () => {
    const { db, audit } = harness();
    const repo = createRepositoryRegistryRepository(db, audit, logger);
    const first = await repo.create(VALID_INPUT);
    await repo.setStatus(first._id!, 'inactive', 'operator:alice');
    await repo.create({ ...VALID_INPUT, repositoryId: 'other-repo' });

    const all = await repo.list();
    assert.equal(all.length, 2);
  });

  it('findActiveByProjectIdentifier returns only active entries for that project', async () => {
    const { db, audit } = harness();
    const repo = createRepositoryRegistryRepository(db, audit, logger);
    const inactive = await repo.create(VALID_INPUT);
    await repo.setStatus(inactive._id!, 'inactive', 'operator:alice');
    await repo.create({ ...VALID_INPUT, repositoryId: 'other-repo' });
    await repo.create({ ...VALID_INPUT, projectIdentifier: 'OTHER', repositoryId: 'unrelated-repo' });

    const active = await repo.findActiveByProjectIdentifier('CF');
    assert.equal(active.length, 1);
    assert.equal(active[0]!.repositoryId, 'other-repo');
  });

  it('allows the same repositoryId to be active for two different projects', async () => {
    const { db, audit } = harness();
    const repo = createRepositoryRegistryRepository(db, audit, logger);
    await repo.create(VALID_INPUT);
    await repo.create({ ...VALID_INPUT, projectIdentifier: 'OTHER' });

    assert.equal((await repo.findActiveByProjectIdentifier('CF')).length, 1);
    assert.equal((await repo.findActiveByProjectIdentifier('OTHER')).length, 1);
  });
});

describe('update', () => {
  it('merges provided fields, re-validates the resulting shape, and appends an audit entry', async () => {
    const { db, audit, auditEntries } = harness();
    const repo = createRepositoryRegistryRepository(db, audit, logger);
    const created = await repo.create(VALID_INPUT);

    const updated = await repo.update(created._id!, {
      allowedBranches: ['main', 'develop'],
      defaultBranch: 'develop',
      actor: 'operator:bob',
    });

    assert.deepEqual(updated.allowedBranches, ['main', 'develop']);
    assert.equal(updated.defaultBranch, 'develop');
    assert.equal(updated.repositoryUrl, VALID_INPUT.repositoryUrl, 'untouched fields are preserved');
    assert.equal(updated.updatedBy, 'operator:bob');

    const updateEntry = auditEntries.find((e) => e.action === 'repository-registry.updated');
    assert.equal(updateEntry?.actor, 'operator:bob');
  });

  it('rejects an update that would leave defaultBranch uncovered by the new allowedBranches', async () => {
    const { db, audit } = harness();
    const repo = createRepositoryRegistryRepository(db, audit, logger);
    const created = await repo.create(VALID_INPUT);

    await assert.rejects(
      () => repo.update(created._id!, { allowedBranches: ['develop'], actor: 'operator:bob' }),
      (error: unknown) => error instanceof RegistryValidationError && error.field === 'defaultBranch',
    );
  });

  it('throws RegistryEntryNotFoundError for an unknown id', async () => {
    const { db, audit } = harness();
    const repo = createRepositoryRegistryRepository(db, audit, logger);

    await assert.rejects(
      () => repo.update(new ObjectId(), { actor: 'operator:bob' }),
      RegistryEntryNotFoundError,
    );
  });
});

describe('setStatus', () => {
  it('deactivates an active entry and appends an audit entry', async () => {
    const { db, audit, auditEntries } = harness();
    const repo = createRepositoryRegistryRepository(db, audit, logger);
    const created = await repo.create(VALID_INPUT);

    const deactivated = await repo.setStatus(created._id!, 'inactive', 'operator:bob');
    assert.equal(deactivated.status, 'inactive');
    assert.equal(deactivated.updatedBy, 'operator:bob');

    const statusEntry = auditEntries.find((e) => e.action === 'repository-registry.status-changed');
    assert.equal(statusEntry?.actor, 'operator:bob');
    assert.equal(statusEntry?.detail?.['status'], 'inactive');
  });

  it('reactivates an inactive entry when nothing else is active for that project', async () => {
    const { db, audit } = harness();
    const repo = createRepositoryRegistryRepository(db, audit, logger);
    const created = await repo.create(VALID_INPUT);
    await repo.setStatus(created._id!, 'inactive', 'operator:bob');

    const reactivated = await repo.setStatus(created._id!, 'active', 'operator:bob');
    assert.equal(reactivated.status, 'active');
  });

  it('surfaces DuplicateActiveMappingError when reactivating would collide with the unique index', async () => {
    const { db, audit, failNextWriteWithDuplicate } = harness();
    const repo = createRepositoryRegistryRepository(db, audit, logger);
    const created = await repo.create(VALID_INPUT);
    await repo.setStatus(created._id!, 'inactive', 'operator:bob');

    failNextWriteWithDuplicate();
    await assert.rejects(
      () => repo.setStatus(created._id!, 'active', 'operator:bob'),
      DuplicateActiveMappingError,
    );
  });

  it('throws RegistryEntryNotFoundError for an unknown id', async () => {
    const { db, audit } = harness();
    const repo = createRepositoryRegistryRepository(db, audit, logger);

    await assert.rejects(
      () => repo.setStatus(new ObjectId(), 'inactive', 'operator:bob'),
      RegistryEntryNotFoundError,
    );
  });
});
