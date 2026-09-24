import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId, type Db } from 'mongodb';

import type { AuditEntryInput, AuditLog } from '../db/audit-log.ts';
import { createLogger } from '../logging/logger.ts';
import {
  DeploymentNotFoundError,
  createDeploymentRepository,
  type CreateDeploymentInput,
  type DeploymentDocument,
} from './deployment-repository.ts';

const RUN_ID = new ObjectId();
const EXECUTION_ID = new ObjectId();
const PUBLICATION_ID = new ObjectId();

const ELIGIBLE_INPUT: CreateDeploymentInput = {
  runId: RUN_ID,
  executionId: EXECUTION_ID,
  publicationId: PUBLICATION_ID,
  owner: 'cloudfuze',
  repo: 'aisdlc-service',
  pullRequestNumber: 42,
  mergeCommitSha: 'deadbeef',
  status: 'eligible',
};

interface Harness {
  readonly db: Db;
  readonly audit: AuditLog;
  readonly auditEntries: AuditEntryInput[];
  readonly store: DeploymentDocument[];
}

function harness(seed: DeploymentDocument[] = []): Harness {
  const store = [...seed];
  const auditEntries: AuditEntryInput[] = [];

  const matches = (doc: DeploymentDocument, filter: Record<string, unknown>): boolean =>
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
    async insertOne(document: DeploymentDocument) {
      if (store.some((doc) => doc.publicationId.equals(document.publicationId))) {
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
    async findOneAndUpdate(filter: Record<string, unknown>, update: { $set?: Partial<DeploymentDocument> }) {
      const found = store.find((doc) => matches(doc, filter));
      if (!found) return null;
      Object.assign(found, update.$set ?? {});
      return { ...found };
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
  it('records an eligible deployment and audits github.pr.merge.detected', async () => {
    const h = harness();
    const repo = createDeploymentRepository(h.db, h.audit, logger);
    const { deployment, created } = await repo.createIfAbsent(ELIGIBLE_INPUT);

    assert.equal(created, true);
    assert.equal(deployment.status, 'eligible');
    assert.equal(deployment.mergeCommitSha, 'deadbeef');
    assert.equal(h.auditEntries.length, 1);
    assert.equal(h.auditEntries[0]!.action, 'github.pr.merge.detected');
  });

  it('records a closed_unmerged deployment and audits github.pr.closed_without_merge.detected, never deployment.eligible', async () => {
    const h = harness();
    const repo = createDeploymentRepository(h.db, h.audit, logger);
    const { deployment } = await repo.createIfAbsent({
      ...ELIGIBLE_INPUT,
      mergeCommitSha: null,
      status: 'closed_unmerged',
    });

    assert.equal(deployment.status, 'closed_unmerged');
    assert.equal(deployment.mergeCommitSha, null);
    assert.ok(deployment.completedAt !== null, 'closed_unmerged is terminal on creation');
    assert.equal(h.auditEntries[0]!.action, 'github.pr.closed_without_merge.detected');
  });

  it('is idempotent on publicationId: a second observation returns the first recorded row unchanged', async () => {
    const h = harness();
    const repo = createDeploymentRepository(h.db, h.audit, logger);
    const first = await repo.createIfAbsent(ELIGIBLE_INPUT);
    const second = await repo.createIfAbsent({ ...ELIGIBLE_INPUT, mergeCommitSha: null, status: 'closed_unmerged' });

    assert.equal(second.created, false);
    assert.equal(second.deployment.status, 'eligible');
    assert.ok(second.deployment._id!.equals(first.deployment._id!));
    assert.equal(h.store.length, 1);
    assert.equal(h.auditEntries.length, 1, 'no audit entry for a duplicate observation');
  });
});

describe('findByPublicationId / findEligible', () => {
  it('returns null for an unknown publication', async () => {
    const h = harness();
    const repo = createDeploymentRepository(h.db, h.audit, logger);
    assert.equal(await repo.findByPublicationId(new ObjectId()), null);
  });

  it('findEligible returns only eligible rows', async () => {
    const h = harness();
    const repo = createDeploymentRepository(h.db, h.audit, logger);
    const { deployment } = await repo.createIfAbsent(ELIGIBLE_INPUT);
    await repo.createIfAbsent({ ...ELIGIBLE_INPUT, publicationId: new ObjectId(), mergeCommitSha: null, status: 'closed_unmerged' });

    const eligible = await repo.findEligible();
    assert.equal(eligible.length, 1);
    assert.ok(eligible[0]!._id!.equals(deployment._id!));
  });
});

describe('claim', () => {
  it('transitions eligible -> running', async () => {
    const h = harness();
    const repo = createDeploymentRepository(h.db, h.audit, logger);
    const { deployment } = await repo.createIfAbsent(ELIGIBLE_INPUT);

    const claimed = await repo.claim(deployment._id!);
    assert.ok(claimed !== null);
    assert.equal(claimed.status, 'running');
    assert.ok(claimed.startedAt !== null);
  });

  it('returns null (a harmless no-op) for a row that is no longer eligible', async () => {
    const h = harness();
    const repo = createDeploymentRepository(h.db, h.audit, logger);
    const { deployment } = await repo.createIfAbsent(ELIGIBLE_INPUT);
    await repo.claim(deployment._id!);

    const secondClaim = await repo.claim(deployment._id!);
    assert.equal(secondClaim, null);
  });

  it('a race between two concurrent claims: exactly one wins', async () => {
    const h = harness();
    const repo = createDeploymentRepository(h.db, h.audit, logger);
    const { deployment } = await repo.createIfAbsent(ELIGIBLE_INPUT);

    const [a, b] = await Promise.all([repo.claim(deployment._id!), repo.claim(deployment._id!)]);
    const winners = [a, b].filter((r) => r !== null);
    assert.equal(winners.length, 1, 'exactly one concurrent claim should win');
  });
});

describe('markSucceeded / markFailed', () => {
  it('marks a running deployment succeeded and audits deployment.completed', async () => {
    const h = harness();
    const repo = createDeploymentRepository(h.db, h.audit, logger);
    const { deployment } = await repo.createIfAbsent(ELIGIBLE_INPUT);
    await repo.claim(deployment._id!);

    const succeeded = await repo.markSucceeded(deployment._id!, {
      provider: 'mock',
      target: 'mock-environment',
      deploymentIdentifier: 'mock-deployment-1',
      validation: { health: { ok: true, summary: 'ok' }, readiness: { ok: true, summary: 'ok' } },
    });

    assert.equal(succeeded.status, 'succeeded');
    assert.equal(succeeded.deploymentIdentifier, 'mock-deployment-1');
    assert.equal(h.auditEntries.at(-1)!.action, 'deployment.completed');
  });

  it('marks a deployment failed and audits deployment.failed', async () => {
    const h = harness();
    const repo = createDeploymentRepository(h.db, h.audit, logger);
    const { deployment } = await repo.createIfAbsent(ELIGIBLE_INPUT);
    await repo.claim(deployment._id!);

    const failed = await repo.markFailed(deployment._id!, { category: 'deployment_provider_failure', message: 'provider exploded' });

    assert.equal(failed.status, 'failed');
    assert.equal(failed.failureCategory, 'deployment_provider_failure');
    assert.equal(h.auditEntries.at(-1)!.action, 'deployment.failed');
  });

  it('throws DeploymentNotFoundError for an unknown id', async () => {
    const h = harness();
    const repo = createDeploymentRepository(h.db, h.audit, logger);
    await assert.rejects(
      () => repo.markSucceeded(new ObjectId(), { provider: 'mock', target: 't', deploymentIdentifier: 'x', validation: { health: { ok: true, summary: 'ok' }, readiness: { ok: true, summary: 'ok' } } }),
      DeploymentNotFoundError,
    );
  });

  it('never records credentials in the audit detail', async () => {
    const h = harness();
    const repo = createDeploymentRepository(h.db, h.audit, logger);
    const { deployment } = await repo.createIfAbsent(ELIGIBLE_INPUT);
    await repo.claim(deployment._id!);
    await repo.markSucceeded(deployment._id!, { provider: 'mock', target: 'mock-environment', deploymentIdentifier: 'x', validation: { health: { ok: true, summary: 'ok' }, readiness: { ok: true, summary: 'ok' } } });

    for (const entry of h.auditEntries) {
      const serialized = JSON.stringify(entry.detail ?? {}).toLowerCase();
      assert.ok(!serialized.includes('token'));
      assert.ok(!serialized.includes('authorization'));
      assert.ok(!serialized.includes('key'));
    }
  });
});
