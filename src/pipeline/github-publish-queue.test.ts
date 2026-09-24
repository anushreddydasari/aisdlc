import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId } from 'mongodb';

import { createLogger } from '../logging/logger.ts';
import type { ChangeExecutionDocument, ChangeExecutionRepository } from '../change-execution/execution-repository.ts';
import type { GithubPublicationDocument, GithubPublicationRepository } from '../github-publish/publish-repository.ts';
import type { GithubPublishService } from '../github-publish/publish-service.ts';
import type { PublishResult } from '../github-publish/types.ts';
import { publishSucceededExecutions, type GithubPublishQueueDeps } from './github-publish-queue.ts';

const NOW = new Date('2026-09-23T12:00:00.000Z');
const RUN_ID = new ObjectId();

function executionDoc(overrides: Partial<ChangeExecutionDocument> = {}): ChangeExecutionDocument {
  return {
    _id: new ObjectId(),
    runId: RUN_ID,
    reviewId: new ObjectId(),
    proposalHash: 'a'.repeat(64),
    status: 'succeeded',
    appliedChanges: [],
    validation: { tests: { ok: true, summary: 'ok' }, typecheck: { ok: true, summary: 'ok' }, build: { ok: true, summary: 'ok' } },
    failureCategory: null,
    failureMessage: null,
    createdAt: NOW,
    completedAt: NOW,
    ...overrides,
  };
}

function fakeExecutionRepository(executions: ChangeExecutionDocument[]): ChangeExecutionRepository {
  return {
    async createIfAbsent() {
      throw new Error('must not be called');
    },
    async findByReviewId() {
      throw new Error('must not be called');
    },
    async findById() {
      throw new Error('must not be called');
    },
    async findSucceeded(limit = 25) {
      return executions.slice(0, limit);
    },
  };
}

function fakePublicationRepository(existing: GithubPublicationDocument[]): GithubPublicationRepository {
  return {
    async createIfAbsent() {
      throw new Error('must not be called');
    },
    async findByExecutionId(executionId) {
      return existing.find((p) => p.executionId.equals(executionId)) ?? null;
    },
    async findPublished() {
      throw new Error('must not be called');
    },
  };
}

function publicationDoc(executionId: ObjectId): GithubPublicationDocument {
  return {
    _id: new ObjectId(),
    runId: RUN_ID,
    reviewId: new ObjectId(),
    executionId,
    owner: 'cloudfuze',
    repo: 'aisdlc-service',
    baseBranch: 'main',
    branch: 'aisdlc/x/y',
    baseSha: 'sha1',
    commitSha: 'sha2',
    status: 'published',
    pullRequestNumber: 1,
    pullRequestUrl: 'https://github.com/cloudfuze/aisdlc-service/pull/1',
    failureCategory: null,
    failureMessage: null,
    createdAt: NOW,
    completedAt: NOW,
  };
}

function harness(
  options: { executions?: ChangeExecutionDocument[]; existingPublications?: GithubPublicationDocument[]; serviceResults?: Record<string, PublishResult> } = {},
): { deps: GithubPublishQueueDeps; publishCalls: string[] } {
  const publishCalls: string[] = [];
  const publishService: GithubPublishService = {
    async publishApprovedChanges(runId, executionId) {
      publishCalls.push(executionId.toHexString());
      const override = options.serviceResults?.[executionId.toHexString()];
      if (override !== undefined) return override;
      return {
        ok: true,
        runId,
        executionId,
        reviewId: new ObjectId(),
        owner: 'cloudfuze',
        repo: 'aisdlc-service',
        baseBranch: 'main',
        branch: 'aisdlc/x/y',
        commitSha: 'sha2',
        pullRequestNumber: 1,
        pullRequestUrl: 'https://github.com/cloudfuze/aisdlc-service/pull/1',
      };
    },
  };

  return {
    deps: {
      executions: fakeExecutionRepository(options.executions ?? [executionDoc()]),
      publications: fakePublicationRepository(options.existingPublications ?? []),
      publishService,
      logger: createLogger({ write: () => {} }),
    },
    publishCalls,
  };
}

describe('publishSucceededExecutions', () => {
  it('publishes a succeeded execution with no publication yet', async () => {
    const h = harness();
    const summary = await publishSucceededExecutions(h.deps);

    assert.equal(summary.examined, 1);
    assert.equal(summary.published, 1);
    assert.equal(h.publishCalls.length, 1);
  });

  it('skips an execution that already has a publication recorded, without calling the service', async () => {
    const exec = executionDoc();
    const h = harness({ executions: [exec], existingPublications: [publicationDoc(exec._id!)] });
    const summary = await publishSucceededExecutions(h.deps);

    assert.equal(summary.alreadyPublished, 1);
    assert.equal(summary.published, 0);
    assert.equal(h.publishCalls.length, 0);
  });

  it('counts a failed publish attempt without stopping the pass', async () => {
    const good = executionDoc({ _id: new ObjectId() });
    const bad = executionDoc({ _id: new ObjectId() });
    const failure: PublishResult = {
      ok: false,
      runId: RUN_ID,
      executionId: bad._id!,
      reviewId: new ObjectId(),
      category: 'branch_conflict',
      message: 'already exists',
      retryable: false,
    };
    const h = harness({ executions: [bad, good], serviceResults: { [bad._id!.toHexString()]: failure } });
    const summary = await publishSucceededExecutions(h.deps);

    assert.equal(summary.examined, 2);
    assert.equal(summary.published, 1);
    assert.equal(summary.failed, 1);
  });
});
