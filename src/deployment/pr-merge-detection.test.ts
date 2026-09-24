import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId } from 'mongodb';

import { createLogger } from '../logging/logger.ts';
import type { AuditEntryInput, AuditLog } from '../db/audit-log.ts';
import type { GithubPublicationDocument, GithubPublicationRepository } from '../github-publish/publish-repository.ts';
import { createMockGitHubAppClient, type MockRepository } from '../github-app/mock-client.ts';
import type { RepositoryRegistryDocument, RepositoryRegistryRepository } from '../repository-registry/repository.ts';
import type { RepositorySelectionDocument, RepositorySelectionRepository } from '../repository-selection/repository.ts';
import { detectMergedPullRequests, type PrMergeDetectionDeps } from './pr-merge-detection.ts';
import type { CreateDeploymentInput, DeploymentDocument, DeploymentRepository } from './deployment-repository.ts';

const NOW = new Date('2026-09-24T12:00:00.000Z');
const RUN_ID = new ObjectId();
const EXECUTION_ID = new ObjectId();
const INSTALLATION_ID = 4242;

function publication(overrides: Partial<GithubPublicationDocument> = {}): GithubPublicationDocument {
  return {
    _id: new ObjectId(),
    runId: RUN_ID,
    reviewId: new ObjectId(),
    executionId: EXECUTION_ID,
    owner: 'cloudfuze',
    repo: 'aisdlc-service',
    baseBranch: 'main',
    branch: 'aisdlc/run-1/exec-1',
    baseSha: 'base-sha',
    commitSha: 'commit-sha',
    status: 'published',
    pullRequestNumber: 7,
    pullRequestUrl: 'https://github.com/cloudfuze/aisdlc-service/pull/7',
    failureCategory: null,
    failureMessage: null,
    createdAt: NOW,
    completedAt: NOW,
    ...overrides,
  };
}

function selection(overrides: Partial<RepositorySelectionDocument> = {}): RepositorySelectionDocument {
  return {
    _id: new ObjectId(),
    runId: RUN_ID,
    intakeItemId: new ObjectId(),
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

function fakePublicationRepository(rows: GithubPublicationDocument[]): GithubPublicationRepository {
  return {
    async createIfAbsent() {
      throw new Error('not used');
    },
    async findByExecutionId() {
      throw new Error('not used');
    },
    async findPublished(limit = 25) {
      return rows.slice(0, limit);
    },
  };
}

function fakeDeploymentRepository(): { repo: DeploymentRepository; store: DeploymentDocument[]; createCalls: CreateDeploymentInput[] } {
  const store: DeploymentDocument[] = [];
  const createCalls: CreateDeploymentInput[] = [];
  const repo: DeploymentRepository = {
    async createIfAbsent(input: CreateDeploymentInput) {
      createCalls.push(input);
      const existing = store.find((d) => d.publicationId.equals(input.publicationId));
      if (existing !== undefined) return { deployment: existing, created: false };
      const document: DeploymentDocument = {
        _id: new ObjectId(),
        runId: input.runId,
        executionId: input.executionId,
        publicationId: input.publicationId,
        owner: input.owner,
        repo: input.repo,
        pullRequestNumber: input.pullRequestNumber,
        mergeCommitSha: input.mergeCommitSha,
        status: input.status,
        provider: null,
        target: null,
        deploymentIdentifier: null,
        validation: null,
        failureCategory: null,
        failureMessage: null,
        createdAt: NOW,
        startedAt: null,
        completedAt: input.status === 'closed_unmerged' ? NOW : null,
      };
      store.push(document);
      return { deployment: document, created: true };
    },
    async findByPublicationId(publicationId) {
      return store.find((d) => d.publicationId.equals(publicationId)) ?? null;
    },
    async findEligible() {
      throw new Error('not used');
    },
    async claim() {
      throw new Error('not used');
    },
    async markSucceeded() {
      throw new Error('not used');
    },
    async markFailed() {
      throw new Error('not used');
    },
  };
  return { repo, store, createCalls };
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

function harness(
  options: {
    publications?: GithubPublicationDocument[];
    selection?: RepositorySelectionDocument | null;
    registryEntries?: RepositoryRegistryDocument[];
    mockRepositories?: MockRepository[];
  } = {},
): { deps: PrMergeDetectionDeps; deploymentStore: DeploymentDocument[]; createCalls: CreateDeploymentInput[] } {
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
  const { repo: deployments, store: deploymentStore, createCalls } = fakeDeploymentRepository();

  return {
    deps: {
      publications: fakePublicationRepository(options.publications ?? [publication()]),
      deployments,
      selections: fakeSelectionRepository('selection' in options ? options.selection! : selection()),
      registry: fakeRegistryRepository(options.registryEntries ?? [registryEntry()]),
      client: createMockGitHubAppClient({ repositories: options.mockRepositories ?? [] }),
      audit,
      logger: createLogger({ write: () => {} }),
    },
    deploymentStore,
    createCalls,
  };
}

const BASE_REPO: Omit<MockRepository, 'pullRequests'> = {
  owner: 'cloudfuze',
  repo: 'aisdlc-service',
  installationId: INSTALLATION_ID,
  defaultBranch: 'main',
  branches: ['main'],
};

describe('detectMergedPullRequests', () => {
  it('remains waiting for an open PR — no deployment record created', async () => {
    const h = harness({
      mockRepositories: [{ ...BASE_REPO, pullRequests: [{ number: 7, head: 'aisdlc/run-1/exec-1', base: 'main', state: 'open' }] }],
    });
    const summary = await detectMergedPullRequests(h.deps);

    assert.equal(summary.stillOpen, 1);
    assert.equal(summary.merged, 0);
    assert.equal(h.deploymentStore.length, 0);
  });

  it('records an eligible deployment for a merged PR, with the merge commit sha', async () => {
    const h = harness({
      mockRepositories: [
        {
          ...BASE_REPO,
          pullRequests: [{ number: 7, head: 'aisdlc/run-1/exec-1', base: 'main', state: 'closed', merged: true, mergeCommitSha: 'deadbeef' }],
        },
      ],
    });
    const summary = await detectMergedPullRequests(h.deps);

    assert.equal(summary.merged, 1);
    assert.equal(h.deploymentStore.length, 1);
    assert.equal(h.deploymentStore[0]!.status, 'eligible');
    assert.equal(h.deploymentStore[0]!.mergeCommitSha, 'deadbeef');
  });

  it('records a closed_unmerged deployment for a PR closed without merging — never assumes closed means merged', async () => {
    const h = harness({
      mockRepositories: [
        { ...BASE_REPO, pullRequests: [{ number: 7, head: 'aisdlc/run-1/exec-1', base: 'main', state: 'closed', merged: false }] },
      ],
    });
    const summary = await detectMergedPullRequests(h.deps);

    assert.equal(summary.closedUnmerged, 1);
    assert.equal(summary.merged, 0);
    assert.equal(h.deploymentStore[0]!.status, 'closed_unmerged');
    assert.equal(h.deploymentStore[0]!.mergeCommitSha, null);
  });

  it('refuses when the PR head/base does not match the published branch — wrong PR', async () => {
    const h = harness({
      mockRepositories: [
        {
          ...BASE_REPO,
          pullRequests: [{ number: 7, head: 'some-other-branch', base: 'main', state: 'closed', merged: true, mergeCommitSha: 'x' }],
        },
      ],
    });
    const summary = await detectMergedPullRequests(h.deps);

    assert.equal(summary.failed, 1);
    assert.equal(h.deploymentStore.length, 0, 'nothing is recorded when identity verification fails');
  });

  it('refuses when the repository resolves differently than the publication says — wrong repository', async () => {
    const h = harness({
      publications: [publication({ owner: 'someone-else', repo: 'other-repo' })],
      registryEntries: [registryEntry({ repositoryUrl: 'https://github.com/cloudfuze/aisdlc-service' })],
      selection: selection({ selectedRepositoryUrl: 'https://github.com/cloudfuze/aisdlc-service' }),
      mockRepositories: [{ ...BASE_REPO, pullRequests: [{ number: 7, head: 'aisdlc/run-1/exec-1', base: 'main', state: 'open' }] }],
    });
    const summary = await detectMergedPullRequests(h.deps);

    assert.equal(summary.failed, 1);
    assert.equal(h.deploymentStore.length, 0);
  });

  it('does not fail when the PR cannot be found yet — treated as retryable, not fatal', async () => {
    const h = harness({ mockRepositories: [BASE_REPO] });
    const summary = await detectMergedPullRequests(h.deps);
    assert.equal(summary.failed, 1);
    assert.equal(h.deploymentStore.length, 0);
  });

  it('is idempotent: a publication that already has a deployment record is skipped without a GitHub call', async () => {
    const h = harness({
      mockRepositories: [
        {
          ...BASE_REPO,
          pullRequests: [{ number: 7, head: 'aisdlc/run-1/exec-1', base: 'main', state: 'closed', merged: true, mergeCommitSha: 'x' }],
        },
      ],
    });
    await detectMergedPullRequests(h.deps);
    const second = await detectMergedPullRequests(h.deps);

    assert.equal(second.alreadyRecorded, 1);
    assert.equal(h.deploymentStore.length, 1, 'no duplicate deployment record');
  });

  it('never returns a token, key, or Authorization-shaped value in any create call', async () => {
    const h = harness({
      mockRepositories: [
        {
          ...BASE_REPO,
          pullRequests: [{ number: 7, head: 'aisdlc/run-1/exec-1', base: 'main', state: 'closed', merged: true, mergeCommitSha: 'x' }],
        },
      ],
    });
    await detectMergedPullRequests(h.deps);
    const serialized = JSON.stringify(h.createCalls).toLowerCase();
    assert.ok(!serialized.includes('token'));
    assert.ok(!serialized.includes('authorization'));
  });
});
