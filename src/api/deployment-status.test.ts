import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import type { IncomingMessage } from 'node:http';
import { ObjectId } from 'mongodb';

import type { RunDocument, RunsRepository } from '../orchestrator/repository.ts';
import type { ChangeReviewDocument, ChangeReviewRepository } from '../change-execution/review-repository.ts';
import type { ChangeExecutionDocument, ChangeExecutionRepository } from '../change-execution/execution-repository.ts';
import type { GithubPublicationDocument, GithubPublicationRepository } from '../github-publish/publish-repository.ts';
import type { DeploymentDocument, DeploymentRepository } from '../deployment/deployment-repository.ts';
import { createLogger } from '../logging/logger.ts';
import { BEARER_PREFIX } from './operator-auth.ts';
import { handleGetDeploymentStatus, type DeploymentStatusDeps } from './deployment-status.ts';

const TOKEN = 'op_test_token_value_not_real'; // pragma: fixture
const NOW = new Date('2026-09-23T00:00:00.000Z');
const RUN_ID = new ObjectId();
const REVIEW_ID = new ObjectId();
const EXECUTION_ID = new ObjectId();
const PUBLICATION_ID = new ObjectId();
const DEPLOYMENT_ID = new ObjectId();

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

function review(overrides: Partial<ChangeReviewDocument> = {}): ChangeReviewDocument {
  return {
    _id: REVIEW_ID,
    runId: RUN_ID,
    intakeItemId: new ObjectId(),
    repositoryId: 'aisdlc-service',
    owner: 'cloudfuze',
    repo: 'aisdlc-service',
    branch: 'main',
    plan: {
      summary: 's',
      requirementsUnderstanding: 'u',
      relevantFiles: [],
      items: [],
      dependenciesAndImpact: [],
      testsRequired: [],
      assumptions: [],
      risks: [],
    },
    proposedChanges: [],
    proposalHash: 'a'.repeat(64),
    status: 'approved',
    reviewedBy: 'operator:test',
    reviewedAt: NOW,
    reviewComment: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function execution(overrides: Partial<ChangeExecutionDocument> = {}): ChangeExecutionDocument {
  return {
    _id: EXECUTION_ID,
    runId: RUN_ID,
    reviewId: REVIEW_ID,
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

function publication(overrides: Partial<GithubPublicationDocument> = {}): GithubPublicationDocument {
  return {
    _id: PUBLICATION_ID,
    runId: RUN_ID,
    reviewId: REVIEW_ID,
    executionId: EXECUTION_ID,
    owner: 'cloudfuze',
    repo: 'aisdlc-service',
    baseBranch: 'main',
    branch: 'aisdlc/x/y',
    baseSha: 's1',
    commitSha: 's2',
    status: 'published',
    pullRequestNumber: 1,
    pullRequestUrl: 'https://github.com/cloudfuze/aisdlc-service/pull/1',
    failureCategory: null,
    failureMessage: null,
    createdAt: NOW,
    completedAt: NOW,
    ...overrides,
  };
}

function deployment(overrides: Partial<DeploymentDocument> = {}): DeploymentDocument {
  return {
    _id: DEPLOYMENT_ID,
    runId: RUN_ID,
    executionId: EXECUTION_ID,
    publicationId: PUBLICATION_ID,
    owner: 'cloudfuze',
    repo: 'aisdlc-service',
    pullRequestNumber: 1,
    mergeCommitSha: 'c'.repeat(40),
    status: 'succeeded',
    provider: 'mock',
    target: 'mock-environment',
    deploymentIdentifier: `deployment-${RUN_ID.toHexString()}-${EXECUTION_ID.toHexString()}`,
    validation: { health: { ok: true, summary: 'ok' }, readiness: { ok: true, summary: 'ok' } },
    failureCategory: null,
    failureMessage: null,
    createdAt: NOW,
    startedAt: NOW,
    completedAt: NOW,
    ...overrides,
  };
}

interface HarnessOptions {
  token?: string | undefined;
  noDatabase?: boolean;
  run?: RunDocument | null;
  review?: ChangeReviewDocument | null;
  execution?: ChangeExecutionDocument | null;
  publication?: GithubPublicationDocument | null;
  deployment?: DeploymentDocument | null;
}

function harness(options: HarnessOptions = {}): { deps: DeploymentStatusDeps } {
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

  const reviews = {
    async findLatestByRunId() {
      return 'review' in options ? options.review! : review();
    },
  } as unknown as ChangeReviewRepository;

  const executions = {
    async findByReviewId() {
      return 'execution' in options ? options.execution! : execution();
    },
  } as unknown as ChangeExecutionRepository;

  const publications = {
    async findByExecutionId() {
      return 'publication' in options ? options.publication! : publication();
    },
  } as unknown as GithubPublicationRepository;

  const deployments = {
    async findByPublicationId() {
      return 'deployment' in options ? options.deployment! : deployment();
    },
  } as unknown as DeploymentRepository;

  return {
    deps: {
      logger: createLogger({ write: () => {} }),
      operatorToken: 'token' in options ? options.token : TOKEN,
      runs: options.noDatabase ? undefined : runs,
      reviews: options.noDatabase ? undefined : reviews,
      executions: options.noDatabase ? undefined : executions,
      publications: options.noDatabase ? undefined : publications,
      deployments: options.noDatabase ? undefined : deployments,
    },
  };
}

describe('handleGetDeploymentStatus', () => {
  it('rejects a request with no bearer token', async () => {
    const h = harness();
    const result = await handleGetDeploymentStatus(request({ authorization: '' }), h.deps, RUN_ID.toHexString());
    assert.equal(result.statusCode, 401);
  });

  it('rejects a request when OPERATOR_TOKEN is not configured', async () => {
    const h = harness({ token: undefined });
    const result = await handleGetDeploymentStatus(request(), h.deps, RUN_ID.toHexString());
    assert.equal(result.statusCode, 401);
  });

  it('returns the deployment detail for a run with a recorded deployment', async () => {
    const h = harness();
    const result = await handleGetDeploymentStatus(request(), h.deps, RUN_ID.toHexString());

    assert.equal(result.statusCode, 200);
    assert.equal(result.body['runId'], RUN_ID.toHexString());
    assert.equal(result.body['deploymentId'], DEPLOYMENT_ID.toHexString());
    assert.equal(result.body['status'], 'succeeded');
    assert.equal(result.body['mergeCommitSha'], 'c'.repeat(40));
  });

  it('returns 404 for an unknown run', async () => {
    const h = harness({ run: null });
    const result = await handleGetDeploymentStatus(request(), h.deps, RUN_ID.toHexString());
    assert.equal(result.statusCode, 404);
  });

  it('returns 404 when no review exists yet', async () => {
    const h = harness({ review: null });
    const result = await handleGetDeploymentStatus(request(), h.deps, RUN_ID.toHexString());
    assert.equal(result.statusCode, 404);
  });

  it('returns 404 when no execution exists yet', async () => {
    const h = harness({ execution: null });
    const result = await handleGetDeploymentStatus(request(), h.deps, RUN_ID.toHexString());
    assert.equal(result.statusCode, 404);
  });

  it('returns 404 when no publication exists yet', async () => {
    const h = harness({ publication: null });
    const result = await handleGetDeploymentStatus(request(), h.deps, RUN_ID.toHexString());
    assert.equal(result.statusCode, 404);
  });

  it('returns 404 when no deployment has been recorded yet (PR not yet merged)', async () => {
    const h = harness({ deployment: null });
    const result = await handleGetDeploymentStatus(request(), h.deps, RUN_ID.toHexString());
    assert.equal(result.statusCode, 404);
  });

  it('rejects an invalid runId', async () => {
    const h = harness();
    const result = await handleGetDeploymentStatus(request(), h.deps, 'not-an-object-id');
    assert.equal(result.statusCode, 400);
  });

  it('returns 503 when the database is unavailable', async () => {
    const h = harness({ noDatabase: true });
    const result = await handleGetDeploymentStatus(request(), h.deps, RUN_ID.toHexString());
    assert.equal(result.statusCode, 503);
  });

  it('never returns a token, key, or Authorization-shaped field', async () => {
    const h = harness();
    const result = await handleGetDeploymentStatus(request(), h.deps, RUN_ID.toHexString());
    const serialized = JSON.stringify(result.body).toLowerCase();
    assert.ok(!serialized.includes('token'));
    assert.ok(!serialized.includes('authorization'));
  });
});
