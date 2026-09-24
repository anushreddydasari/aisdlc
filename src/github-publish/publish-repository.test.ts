import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId, type Db } from 'mongodb';

import type { AuditEntryInput, AuditLog } from '../db/audit-log.ts';
import { createLogger } from '../logging/logger.ts';
import { createGithubPublicationRepository, type GithubPublicationDocument, type RecordPublicationInput } from './publish-repository.ts';

const RUN_ID = new ObjectId();
const REVIEW_ID = new ObjectId();
const EXECUTION_ID = new ObjectId();

const SUCCESS_INPUT: RecordPublicationInput = {
  runId: RUN_ID,
  reviewId: REVIEW_ID,
  executionId: EXECUTION_ID,
  owner: 'cloudfuze',
  repo: 'aisdlc-service',
  baseBranch: 'main',
  branch: 'aisdlc/run-1/exec-1',
  baseSha: 'base-sha',
  commitSha: 'commit-sha',
  status: 'published',
  pullRequestNumber: 42,
  pullRequestUrl: 'https://github.com/cloudfuze/aisdlc-service/pull/42',
  failureCategory: null,
  failureMessage: null,
};

interface Harness {
  readonly db: Db;
  readonly audit: AuditLog;
  readonly auditEntries: AuditEntryInput[];
  readonly store: GithubPublicationDocument[];
}

function harness(seed: GithubPublicationDocument[] = []): Harness {
  const store = [...seed];
  const auditEntries: AuditEntryInput[] = [];

  const matches = (doc: GithubPublicationDocument, filter: Record<string, unknown>): boolean =>
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
    async insertOne(document: GithubPublicationDocument) {
      if (store.some((doc) => doc.executionId.equals(document.executionId))) {
        throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      }
      const _id = document._id ?? new ObjectId();
      store.push({ ...document, _id });
      return { insertedId: _id };
    },
    find(filter: Record<string, unknown> = {}) {
      let results = store.filter((doc) => matches(doc, filter)).map((doc) => ({ ...doc }));
      const cursor = {
        sort(spec: Record<string, 1 | -1>) {
          const [field, direction] = Object.entries(spec)[0] as [string, 1 | -1];
          results = [...results].sort((a, b) => {
            const av = (a as unknown as Record<string, Date>)[field]!.getTime();
            const bv = (b as unknown as Record<string, Date>)[field]!.getTime();
            return direction === 1 ? av - bv : bv - av;
          });
          return cursor;
        },
        limit(n: number) {
          results = results.slice(0, n);
          return cursor;
        },
        async toArray() {
          return results;
        },
      };
      return cursor;
    },
  };

  const db = { collection: () => collection } as unknown as Db;

  const audit: AuditLog = {
    async append(entry: AuditEntryInput) {
      auditEntries.push(entry);
      return new ObjectId();
    },
    async query() {
      return [];
    },
  };

  return { db, audit, auditEntries, store };
}

const logger = createLogger({ write: () => {} });

describe('createIfAbsent', () => {
  it('records a successful publication and audits github.write.completed', async () => {
    const h = harness();
    const repo = createGithubPublicationRepository(h.db, h.audit, logger);
    const { publication, created } = await repo.createIfAbsent(SUCCESS_INPUT);

    assert.equal(created, true);
    assert.equal(publication.status, 'published');
    assert.equal(publication.pullRequestNumber, 42);
    assert.equal(h.auditEntries.length, 1);
    assert.equal(h.auditEntries[0]!.action, 'github.write.completed');
  });

  it('records a failed publication and audits github.write.failed', async () => {
    const h = harness();
    const repo = createGithubPublicationRepository(h.db, h.audit, logger);
    const { publication } = await repo.createIfAbsent({
      ...SUCCESS_INPUT,
      status: 'failed',
      commitSha: null,
      pullRequestNumber: null,
      pullRequestUrl: null,
      failureCategory: 'stale_file',
      failureMessage: "'src/index.ts' changed since execution",
    });

    assert.equal(publication.status, 'failed');
    assert.equal(publication.failureCategory, 'stale_file');
    assert.equal(h.auditEntries[0]!.action, 'github.write.failed');
  });

  it('is idempotent on executionId: a second attempt returns the first recorded row unchanged', async () => {
    const h = harness();
    const repo = createGithubPublicationRepository(h.db, h.audit, logger);
    const first = await repo.createIfAbsent(SUCCESS_INPUT);
    const second = await repo.createIfAbsent({
      ...SUCCESS_INPUT,
      status: 'failed',
      pullRequestNumber: null,
      pullRequestUrl: null,
      failureCategory: 'unexpected_error',
      failureMessage: 'should never be recorded',
    });

    assert.equal(second.created, false);
    assert.equal(second.publication.status, 'published');
    assert.ok(second.publication._id!.equals(first.publication._id!));
    assert.equal(h.store.length, 1);
    assert.equal(h.auditEntries.length, 1, 'no audit entry for a duplicate publish attempt');
  });

  it('never records a token, key, or file content in the audit detail', async () => {
    const h = harness();
    const repo = createGithubPublicationRepository(h.db, h.audit, logger);
    await repo.createIfAbsent(SUCCESS_INPUT);

    const serialized = JSON.stringify(h.auditEntries[0]!.detail ?? {});
    assert.ok(!serialized.toLowerCase().includes('token'));
    assert.ok(!serialized.toLowerCase().includes('authorization'));
  });
});

describe('findByExecutionId', () => {
  it('returns null when no publication has been recorded', async () => {
    const h = harness();
    const repo = createGithubPublicationRepository(h.db, h.audit, logger);
    assert.equal(await repo.findByExecutionId(new ObjectId()), null);
  });

  it('returns the recorded publication for an execution', async () => {
    const h = harness();
    const repo = createGithubPublicationRepository(h.db, h.audit, logger);
    const { publication } = await repo.createIfAbsent(SUCCESS_INPUT);

    const found = await repo.findByExecutionId(EXECUTION_ID);
    assert.ok(found !== null);
    assert.ok(found._id!.equals(publication._id!));
  });
});

describe('findPublished', () => {
  it('returns only publications currently in the published status', async () => {
    const h = harness();
    const repo = createGithubPublicationRepository(h.db, h.audit, logger);
    const { publication } = await repo.createIfAbsent(SUCCESS_INPUT);
    await repo.createIfAbsent({
      ...SUCCESS_INPUT,
      executionId: new ObjectId(),
      status: 'failed',
      commitSha: null,
      pullRequestNumber: null,
      pullRequestUrl: null,
      failureCategory: 'branch_conflict',
      failureMessage: 'x',
    });

    const published = await repo.findPublished();
    assert.equal(published.length, 1);
    assert.ok(published[0]!._id!.equals(publication._id!));
  });

  it('returns an empty array when nothing has been published', async () => {
    const h = harness();
    const repo = createGithubPublicationRepository(h.db, h.audit, logger);
    await repo.createIfAbsent({ ...SUCCESS_INPUT, status: 'failed', commitSha: null, pullRequestNumber: null, pullRequestUrl: null, failureCategory: 'branch_conflict', failureMessage: 'x' });
    assert.deepEqual(await repo.findPublished(), []);
  });
});
