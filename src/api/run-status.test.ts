import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import type { IncomingMessage } from 'node:http';
import { ObjectId } from 'mongodb';

import type { RunDocument, RunsRepository } from '../orchestrator/repository.ts';
import type { RepositorySelectionRepository } from '../repository-selection/repository.ts';
import type { ChangeReviewRepository } from '../change-execution/review-repository.ts';
import type { ChangeExecutionRepository } from '../change-execution/execution-repository.ts';
import type { GithubPublicationRepository } from '../github-publish/publish-repository.ts';
import type { DeploymentRepository } from '../deployment/deployment-repository.ts';
import { createLogger } from '../logging/logger.ts';
import { BEARER_PREFIX } from './operator-auth.ts';
import { handleGetRunStatus, type RunStatusDeps } from './run-status.ts';

const TOKEN = 'op_test_token_value_not_real'; // pragma: fixture
const NOW = new Date('2026-09-23T00:00:00.000Z');
const RUN_ID = new ObjectId();

function request(headers: Record<string, string | undefined> = {}): IncomingMessage {
  const stream = Readable.from([Buffer.alloc(0)]) as unknown as IncomingMessage;
  stream.headers = { authorization: `${BEARER_PREFIX}${TOKEN}`, ...headers } as IncomingMessage['headers'];
  return stream;
}

function run(overrides: Partial<RunDocument> = {}): RunDocument {
  return {
    _id: RUN_ID,
    intakeItemId: new ObjectId(),
    issueKey: 'CF-1',
    status: 'queued',
    trigger: 'approval',
    createdAt: NOW,
    startedAt: null,
    completedAt: null,
    updatedAt: NOW,
    ...overrides,
  };
}

function harness(options: { token?: string | undefined; noDatabase?: boolean; run?: RunDocument | null } = {}): { deps: RunStatusDeps } {
  const runs: RunsRepository = {
    async createIfAbsent() {
      throw new Error('not used');
    },
    async findByIntakeItemId() {
      throw new Error('not used');
    },
    async findById() {
      return 'run' in options ? options.run! : run();
    },
    async list() {
      throw new Error('not used');
    },
  };

  const selections = { async findByRunId() { return null; } } as unknown as RepositorySelectionRepository;
  const reviews = { async findLatestByRunId() { return null; } } as unknown as ChangeReviewRepository;
  const executions = { async findByReviewId() { return null; } } as unknown as ChangeExecutionRepository;
  const publications = { async findByExecutionId() { return null; } } as unknown as GithubPublicationRepository;
  const deployments = { async findByPublicationId() { return null; } } as unknown as DeploymentRepository;

  return {
    deps: {
      logger: createLogger({ write: () => {} }),
      operatorToken: 'token' in options ? options.token : TOKEN,
      runs: options.noDatabase ? undefined : runs,
      selections: options.noDatabase ? undefined : selections,
      reviews: options.noDatabase ? undefined : reviews,
      executions: options.noDatabase ? undefined : executions,
      publications: options.noDatabase ? undefined : publications,
      deployments: options.noDatabase ? undefined : deployments,
    },
  };
}

describe('handleGetRunStatus', () => {
  it('rejects a request with no bearer token', async () => {
    const h = harness();
    const result = await handleGetRunStatus(request({ authorization: '' }), h.deps, RUN_ID.toHexString());
    assert.equal(result.statusCode, 401);
  });

  it('rejects a request when OPERATOR_TOKEN is not configured', async () => {
    const h = harness({ token: undefined });
    const result = await handleGetRunStatus(request(), h.deps, RUN_ID.toHexString());
    assert.equal(result.statusCode, 401);
  });

  it('returns the composed status view for a known run', async () => {
    const h = harness();
    const result = await handleGetRunStatus(request(), h.deps, RUN_ID.toHexString());

    assert.equal(result.statusCode, 200);
    assert.equal(result.body['runId'], RUN_ID.toHexString());
    assert.equal(result.body['stage'], 'queued');
  });

  it('returns 404 for an unknown run', async () => {
    const h = harness({ run: null });
    const result = await handleGetRunStatus(request(), h.deps, RUN_ID.toHexString());
    assert.equal(result.statusCode, 404);
  });

  it('rejects an invalid runId', async () => {
    const h = harness();
    const result = await handleGetRunStatus(request(), h.deps, 'not-an-object-id');
    assert.equal(result.statusCode, 400);
  });

  it('returns 503 when the database is unavailable', async () => {
    const h = harness({ noDatabase: true });
    const result = await handleGetRunStatus(request(), h.deps, RUN_ID.toHexString());
    assert.equal(result.statusCode, 503);
  });

  it('never returns a token, key, or Authorization-shaped field', async () => {
    const h = harness();
    const result = await handleGetRunStatus(request(), h.deps, RUN_ID.toHexString());
    const serialized = JSON.stringify(result.body).toLowerCase();
    assert.ok(!serialized.includes('token'));
    assert.ok(!serialized.includes('authorization'));
  });
});
