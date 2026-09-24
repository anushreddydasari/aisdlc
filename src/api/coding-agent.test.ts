import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import type { IncomingMessage } from 'node:http';
import { ObjectId } from 'mongodb';

import type { ChangeReviewDocument, ChangeReviewRepository, CreateChangeReviewInput } from '../change-execution/review-repository.ts';
import type { CodingAgentService } from '../coding-agent/service.ts';
import type { CodingAgentResult } from '../coding-agent/types.ts';
import type { ImplementationPlan } from '../change-execution/types.ts';
import { createMockGitHubAppClient, type MockRepository } from '../github-app/mock-client.ts';
import type { RepositoryRegistryDocument, RepositoryRegistryRepository } from '../repository-registry/repository.ts';
import type { RepositorySelectionDocument, RepositorySelectionRepository } from '../repository-selection/repository.ts';
import { createLogger } from '../logging/logger.ts';
import { BEARER_PREFIX } from './operator-auth.ts';
import { handleTriggerCodingAgent, type CodingAgentApiDeps } from './coding-agent.ts';

const TOKEN = 'op_test_token_value_not_real'; // pragma: fixture
const NOW = new Date('2026-09-23T00:00:00.000Z');
const RUN_ID = new ObjectId();
const INTAKE_ITEM_ID = new ObjectId();
const INSTALLATION_ID = 4242;

function request(body: Record<string, unknown> | Buffer | null, headers: Record<string, string | undefined> = {}): IncomingMessage {
  const buf = body === null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const stream = Readable.from([buf]) as unknown as IncomingMessage;
  stream.headers = { authorization: `${BEARER_PREFIX}${TOKEN}`, ...headers } as IncomingMessage['headers'];
  return stream;
}

const MOCK_REPO: MockRepository = {
  owner: 'cloudfuze',
  repo: 'aisdlc-service',
  installationId: INSTALLATION_ID,
  defaultBranch: 'main',
  branches: ['main'],
};

const PLAN: ImplementationPlan = {
  summary: 's',
  requirementsUnderstanding: 'u',
  relevantFiles: ['src/index.ts'],
  items: [{ id: 'item-1', filePath: 'src/index.ts', operation: 'modify', changeDescription: 'd' }],
  dependenciesAndImpact: [],
  testsRequired: [],
  assumptions: [],
  risks: [],
};

function selection(overrides: Partial<RepositorySelectionDocument> = {}): RepositorySelectionDocument {
  return {
    _id: new ObjectId(),
    runId: RUN_ID,
    intakeItemId: INTAKE_ITEM_ID,
    issueKey: 'CF-1',
    projectIdentifier: 'CF',
    candidateRepositoryIds: ['aisdlc-service'],
    selectedRepositoryId: 'aisdlc-service',
    selectedRepositoryUrl: 'https://github.com/cloudfuze/aisdlc-service',
    selectedDefaultBranch: 'main',
    selectedAllowedBranches: ['main'],
    selectedAccessPolicy: null,
    status: 'selected',
    failureReason: null,
    attempts: 0,
    nextAttemptAt: NOW,
    confirmedBy: 'operator:alice',
    confirmedAt: NOW,
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
    accessPolicy: { installationId: INSTALLATION_ID },
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: 'operator:alice',
    updatedBy: 'operator:alice',
    ...overrides,
  };
}

function fakeReviewRepository(): ChangeReviewRepository {
  return {
    async createIfAbsent(input: CreateChangeReviewInput) {
      const review: ChangeReviewDocument = {
        _id: new ObjectId(),
        runId: input.runId,
        intakeItemId: input.intakeItemId,
        repositoryId: input.repositoryId,
        owner: input.owner,
        repo: input.repo,
        branch: input.branch,
        plan: input.plan,
        proposedChanges: [...input.proposedChanges],
        proposalHash: 'a'.repeat(64),
        status: 'pending',
        reviewedBy: null,
        reviewedAt: null,
        reviewComment: null,
        createdAt: NOW,
        updatedAt: NOW,
      };
      return { review, created: true };
    },
    async findById() {
      throw new Error('not used');
    },
    async findLatestByRunId() {
      throw new Error('not used');
    },
    async approve() {
      throw new Error('not used');
    },
    async reject() {
      throw new Error('not used');
    },
    async findApproved() {
      throw new Error('not used');
    },
  };
}

function fakeSelectionRepository(sel: RepositorySelectionDocument | null): RepositorySelectionRepository {
  return {
    async findByRunId() {
      return sel;
    },
    async createInitial() {
      throw new Error('not used');
    },
    async recordMatchResult() {
      throw new Error('not used');
    },
    async confirm() {
      throw new Error('not used');
    },
    async findDueForRetry() {
      throw new Error('not used');
    },
  };
}

function fakeRegistryRepository(entries: RepositoryRegistryDocument[]): RepositoryRegistryRepository {
  return {
    async create() {
      throw new Error('not used');
    },
    async findById() {
      throw new Error('not used');
    },
    async list() {
      throw new Error('not used');
    },
    async findActiveByProjectIdentifier(projectIdentifier) {
      return entries.filter((e) => e.projectIdentifier === projectIdentifier && e.status === 'active');
    },
    async update() {
      throw new Error('not used');
    },
    async setStatus() {
      throw new Error('not used');
    },
  };
}

function codingAgentSuccess(): CodingAgentResult {
  return {
    ok: true,
    runId: RUN_ID,
    intakeItemId: INTAKE_ITEM_ID,
    repositoryId: 'aisdlc-service',
    plan: PLAN,
    proposedChanges: [],
  };
}

function harness(
  options: {
    token?: string | undefined;
    noDatabase?: boolean;
    selection?: RepositorySelectionDocument | null;
    codingAgentResult?: CodingAgentResult;
  } = {},
): { deps: CodingAgentApiDeps } {
  const codingAgent: CodingAgentService = {
    async run() {
      return options.codingAgentResult ?? codingAgentSuccess();
    },
  };

  return {
    deps: {
      logger: createLogger({ write: () => {} }),
      operatorToken: 'token' in options ? options.token : TOKEN,
      trigger: options.noDatabase
        ? undefined
        : {
            codingAgent,
            reviews: fakeReviewRepository(),
            selections: fakeSelectionRepository('selection' in options ? options.selection! : selection()),
            registry: fakeRegistryRepository([registryEntry()]),
            client: createMockGitHubAppClient({ repositories: [MOCK_REPO] }),
          },
    },
  };
}

describe('handleTriggerCodingAgent — authorization', () => {
  it('rejects a request with no bearer token', async () => {
    const h = harness();
    const result = await handleTriggerCodingAgent(request({ candidateFilePaths: ['src/index.ts'], operator: 'alice' }, { authorization: '' }), h.deps, RUN_ID.toHexString());
    assert.equal(result.statusCode, 401);
  });

  it('rejects a request when OPERATOR_TOKEN is not configured', async () => {
    const h = harness({ token: undefined });
    const result = await handleTriggerCodingAgent(request({ candidateFilePaths: ['src/index.ts'], operator: 'alice' }), h.deps, RUN_ID.toHexString());
    assert.equal(result.statusCode, 401);
  });
});

describe('handleTriggerCodingAgent', () => {
  it('triggers the coding agent and creates a pending review', async () => {
    const h = harness();
    const result = await handleTriggerCodingAgent(request({ candidateFilePaths: ['src/index.ts'], operator: 'alice' }), h.deps, RUN_ID.toHexString());

    assert.equal(result.statusCode, 201);
    assert.equal(result.body['status'], 'pending');
    assert.equal(result.body['created'], true);
  });

  it('rejects a body with an empty candidateFilePaths array', async () => {
    const h = harness();
    const result = await handleTriggerCodingAgent(request({ candidateFilePaths: [], operator: 'alice' }), h.deps, RUN_ID.toHexString());
    assert.equal(result.statusCode, 400);
  });

  it('rejects a body with no operator field', async () => {
    const h = harness();
    const result = await handleTriggerCodingAgent(request({ candidateFilePaths: ['src/index.ts'] }), h.deps, RUN_ID.toHexString());
    assert.equal(result.statusCode, 400);
  });

  it('rejects an invalid runId', async () => {
    const h = harness();
    const result = await handleTriggerCodingAgent(request({ candidateFilePaths: ['src/index.ts'], operator: 'alice' }), h.deps, 'not-an-object-id');
    assert.equal(result.statusCode, 400);
  });

  it('returns 409 when the repository is not confirmed', async () => {
    const h = harness({ selection: selection({ status: 'pending', confirmedBy: null }) });
    const result = await handleTriggerCodingAgent(request({ candidateFilePaths: ['src/index.ts'], operator: 'alice' }), h.deps, RUN_ID.toHexString());
    assert.equal(result.statusCode, 409);
  });

  it('returns 422 when the coding agent itself fails', async () => {
    const h = harness({
      codingAgentResult: {
        ok: false,
        runId: RUN_ID,
        intakeItemId: INTAKE_ITEM_ID,
        repositoryId: 'aisdlc-service',
        category: 'malformed_model_output',
        message: 'no proposed changes were returned',
        retryable: false,
      },
    });
    const result = await handleTriggerCodingAgent(request({ candidateFilePaths: ['src/index.ts'], operator: 'alice' }), h.deps, RUN_ID.toHexString());
    assert.equal(result.statusCode, 422);
  });

  it('returns 503 when the underlying trigger dependencies are unavailable', async () => {
    const h = harness({ noDatabase: true });
    const result = await handleTriggerCodingAgent(request({ candidateFilePaths: ['src/index.ts'], operator: 'alice' }), h.deps, RUN_ID.toHexString());
    assert.equal(result.statusCode, 503);
  });
});
