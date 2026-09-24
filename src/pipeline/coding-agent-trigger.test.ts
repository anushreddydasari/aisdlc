/**
 * Every test here fakes CodingAgentService and ChangeReviewRepository
 * directly — each has its own exhaustive test suite elsewhere — but uses
 * the REAL `authorizeRepositoryAccess` against a mocked `GitHubAppClient`
 * and simple registry/selection fakes, since that reuse (not
 * reimplementation) is exactly the thing under test here.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId } from 'mongodb';

import { createLogger } from '../logging/logger.ts';
import type { ChangeReviewDocument, ChangeReviewRepository, CreateChangeReviewInput, CreateChangeReviewResult } from '../change-execution/review-repository.ts';
import type { CodingAgentService } from '../coding-agent/service.ts';
import type { CodingAgentResult } from '../coding-agent/types.ts';
import type { ImplementationPlan } from '../change-execution/types.ts';
import { createMockGitHubAppClient, type MockRepository } from '../github-app/mock-client.ts';
import type { RepositoryRegistryDocument, RepositoryRegistryRepository } from '../repository-registry/repository.ts';
import type { RepositorySelectionDocument, RepositorySelectionRepository } from '../repository-selection/repository.ts';
import { triggerCodingAgent, type TriggerCodingAgentDeps } from './coding-agent-trigger.ts';

const NOW = new Date('2026-09-23T12:00:00.000Z');
const RUN_ID = new ObjectId();
const INTAKE_ITEM_ID = new ObjectId();
const INSTALLATION_ID = 4242;

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

function codingAgentSuccess(): CodingAgentResult {
  return {
    ok: true,
    runId: RUN_ID,
    intakeItemId: INTAKE_ITEM_ID,
    repositoryId: 'aisdlc-service',
    plan: PLAN,
    proposedChanges: [
      {
        filePath: 'src/index.ts',
        operation: 'modify',
        originalContentHash: 'a'.repeat(64),
        proposedContent: 'export const x = 1;',
        reason: 'r',
        relatedPlanItemId: 'item-1',
      },
    ],
  };
}

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

function fakeSelectionRepository(sel: RepositorySelectionDocument | null): RepositorySelectionRepository {
  return {
    async findByRunId() {
      return sel;
    },
    async createInitial() {
      throw new Error('must not be called');
    },
    async recordMatchResult() {
      throw new Error('must not be called');
    },
    async confirm() {
      throw new Error('must not be called');
    },
    async findDueForRetry() {
      throw new Error('must not be called');
    },
  };
}

function fakeRegistryRepository(entries: RepositoryRegistryDocument[]): RepositoryRegistryRepository {
  return {
    async create() {
      throw new Error('must not be called');
    },
    async findById() {
      throw new Error('must not be called');
    },
    async list() {
      throw new Error('must not be called');
    },
    async findActiveByProjectIdentifier(projectIdentifier) {
      return entries.filter((e) => e.projectIdentifier === projectIdentifier && e.status === 'active');
    },
    async update() {
      throw new Error('must not be called');
    },
    async setStatus() {
      throw new Error('must not be called');
    },
  };
}

function fakeReviewRepository(): { repo: ChangeReviewRepository; calls: CreateChangeReviewInput[] } {
  const calls: CreateChangeReviewInput[] = [];
  const repo: ChangeReviewRepository = {
    async createIfAbsent(input: CreateChangeReviewInput): Promise<CreateChangeReviewResult> {
      calls.push(input);
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
      throw new Error('must not be called');
    },
    async findLatestByRunId() {
      throw new Error('must not be called');
    },
    async approve() {
      throw new Error('must not be called');
    },
    async reject() {
      throw new Error('must not be called');
    },
    async findApproved() {
      throw new Error('must not be called');
    },
  };
  return { repo, calls };
}

function harness(
  options: {
    selection?: RepositorySelectionDocument | null;
    registryEntries?: RepositoryRegistryDocument[];
    codingAgentResult?: CodingAgentResult;
  } = {},
): { deps: TriggerCodingAgentDeps; reviewCalls: CreateChangeReviewInput[]; codingAgentCalls: number } {
  let codingAgentCalls = 0;
  const codingAgent: CodingAgentService = {
    async run() {
      codingAgentCalls += 1;
      return options.codingAgentResult ?? codingAgentSuccess();
    },
  };
  const { repo: reviews, calls: reviewCalls } = fakeReviewRepository();

  return {
    deps: {
      codingAgent,
      reviews,
      selections: fakeSelectionRepository('selection' in options ? options.selection! : selection()),
      registry: fakeRegistryRepository(options.registryEntries ?? [registryEntry()]),
      client: createMockGitHubAppClient({ repositories: [MOCK_REPO] }),
      logger: createLogger({ write: () => {} }),
    },
    reviewCalls,
    get codingAgentCalls() {
      return codingAgentCalls;
    },
  };
}

describe('triggerCodingAgent', () => {
  it('runs the coding agent and records a pending review with the authorized repository identity', async () => {
    const h = harness();
    const result = await triggerCodingAgent(h.deps, RUN_ID, ['src/index.ts']);

    assert.ok(result.ok);
    assert.equal(result.review.owner, 'cloudfuze');
    assert.equal(result.review.repo, 'aisdlc-service');
    assert.equal(result.review.branch, 'main');
    assert.equal(result.review.status, 'pending');
    assert.equal(h.reviewCalls.length, 1);
  });

  it('refuses when the repository selection is missing, without ever calling the coding agent', async () => {
    const h = harness({ selection: null });
    const result = await triggerCodingAgent(h.deps, RUN_ID, ['src/index.ts']);

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'repository_access_failure');
    assert.equal(h.codingAgentCalls, 0);
  });

  it('refuses when the repository selection is not confirmed', async () => {
    const h = harness({ selection: selection({ status: 'pending', confirmedBy: null }) });
    const result = await triggerCodingAgent(h.deps, RUN_ID, ['src/index.ts']);

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'repository_access_failure');
  });

  it('propagates a coding agent failure without creating a review', async () => {
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
    const result = await triggerCodingAgent(h.deps, RUN_ID, ['src/index.ts']);

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'coding_agent_failure');
    assert.equal(h.reviewCalls.length, 0);
  });
});
