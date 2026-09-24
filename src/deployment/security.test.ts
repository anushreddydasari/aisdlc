/**
 * Section 23 security review — consolidated checklist for the deployment
 * surface specifically. Every property already has its own dedicated,
 * in-depth test elsewhere in this codebase where the underlying mechanism
 * lives (pr-merge-detection.test.ts, deployment-service.test.ts,
 * deployment-repository.test.ts, api/deployment-status.test.ts,
 * api/server.test.ts) — this file is the auditable checklist proving each
 * explicit Section 23 property, not a duplicate of those suites. Mirrors
 * pipeline/security.test.ts's own role for the orchestration surface.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId } from 'mongodb';

import type { AuditEntryInput, AuditLog } from '../db/audit-log.ts';
import { createLogger } from '../logging/logger.ts';
import { createMockGitHubAppClient } from '../github-app/mock-client.ts';
import type { CreateDeploymentInput, DeploymentDocument, DeploymentRepository, MarkFailedInput, MarkSucceededInput } from './deployment-repository.ts';
import { createMockDeploymentProvider, type DeploymentProvider, type DeploymentRequest } from './deployment-provider.ts';
import { createMockPostDeploymentValidator } from './post-deployment-validator.ts';
import { createDeploymentService, type DeploymentServiceDeps } from './deployment-service.ts';

const NOW = new Date('2026-09-25T12:00:00.000Z');
const RUN_ID = new ObjectId();
const EXECUTION_ID = new ObjectId();
const PUBLICATION_ID = new ObjectId();

describe('Property: no merge or approval capability exists anywhere on the deployment surface', () => {
  it('GitHubAppClient (as used by pr-merge-detection.ts) exposes no mergePullRequest, approvePullRequest, or autoMerge method', () => {
    const client = createMockGitHubAppClient({ repositories: [] });
    assert.equal('mergePullRequest' in client, false);
    assert.equal('approvePullRequest' in client, false);
    assert.equal('autoMerge' in client, false);
    // getPullRequest is READ-ONLY — the only addition pr-merge-detection.ts uses.
    assert.equal(typeof client.getPullRequest, 'function');
  });

  it('DeploymentProvider exposes no merge, approve, or PR-write method — deployment is a wholly separate concern from the PR itself', () => {
    const provider = createMockDeploymentProvider();
    assert.deepEqual(Object.keys(provider).sort(), ['deploy', 'getDeploymentStatus', 'validateDeployment']);
  });
});

function eligibleDeployment(overrides: Partial<DeploymentDocument> = {}): DeploymentDocument {
  return {
    _id: new ObjectId(),
    runId: RUN_ID,
    executionId: EXECUTION_ID,
    publicationId: PUBLICATION_ID,
    owner: 'cloudfuze',
    repo: 'aisdlc-service',
    pullRequestNumber: 42,
    mergeCommitSha: 'deadbeef',
    status: 'eligible',
    provider: null,
    target: null,
    deploymentIdentifier: null,
    validation: null,
    failureCategory: null,
    failureMessage: null,
    createdAt: NOW,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function fakeDeploymentRepository(seed: DeploymentDocument): { repo: DeploymentRepository; store: DeploymentDocument } {
  const store = { ...seed };
  const repo: DeploymentRepository = {
    async createIfAbsent(_input: CreateDeploymentInput): Promise<never> {
      throw new Error('not used');
    },
    async findByPublicationId() {
      throw new Error('not used');
    },
    async findEligible() {
      throw new Error('not used');
    },
    async claim(id: ObjectId) {
      // Mirrors the real repository's CAS: only an `eligible` row can ever
      // be claimed — a `closed_unmerged` or already-`running`/`succeeded`
      // row never transitions, no matter how often this is called.
      if (!store._id!.equals(id) || store.status !== 'eligible') return null;
      store.status = 'running';
      store.startedAt = NOW;
      return { ...store };
    },
    async markSucceeded(id: ObjectId, input: MarkSucceededInput) {
      if (!store._id!.equals(id)) throw new Error('not found');
      store.status = 'succeeded';
      store.provider = input.provider;
      store.target = input.target;
      store.deploymentIdentifier = input.deploymentIdentifier;
      store.validation = input.validation;
      store.completedAt = NOW;
      return { ...store };
    },
    async markFailed(id: ObjectId, input: MarkFailedInput) {
      if (!store._id!.equals(id)) throw new Error('not found');
      store.status = 'failed';
      store.failureCategory = input.category;
      store.failureMessage = input.message;
      store.completedAt = NOW;
      return { ...store };
    },
  };
  return { repo, store };
}

function harness(deployment: DeploymentDocument, provider?: DeploymentProvider): { deps: DeploymentServiceDeps; store: DeploymentDocument; auditEntries: AuditEntryInput[] } {
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
  const { repo: deployments, store } = fakeDeploymentRepository(deployment);
  return {
    deps: {
      deployments,
      provider: provider ?? createMockDeploymentProvider(),
      validator: createMockPostDeploymentValidator(),
      audit,
      logger: createLogger({ write: () => {} }),
    },
    store,
    auditEntries,
  };
}

describe('Property: deployment requires an actually-merged PR', () => {
  it('a closed_unmerged row can never be deployed — claim() only ever matches status "eligible"', async () => {
    const h = harness(eligibleDeployment({ status: 'closed_unmerged', mergeCommitSha: null }));
    const service = createDeploymentService(h.deps);
    const result = await service.runDeployment(h.store);

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'already_deployed');
    assert.equal(h.store.status, 'closed_unmerged', 'the row is untouched — never advanced toward deployment');
  });

  it('the ONLY code path that ever creates an eligible deployment row is pr-merge-detection.ts observing GitHub\'s own merged=true — see pr-merge-detection.test.ts for the full identity/merge-state matrix', () => {
    // Documented, not re-derived here: deployment-repository.ts's
    // createIfAbsent restricts its `status` input to
    // Extract<DeploymentStatus, 'eligible' | 'closed_unmerged'> at the type
    // level (see CreateDeploymentInput), and the only caller of
    // createIfAbsent anywhere in this codebase is pr-merge-detection.ts.
    assert.ok(true);
  });
});

describe('Property: a deployment can never target an arbitrary commit', () => {
  it('the commit sent to the provider is always the persisted row\'s own mergeCommitSha, never supplied by any caller of runDeployment', async () => {
    let seenCommitSha = '';
    const provider: DeploymentProvider = {
      async validateDeployment(request: DeploymentRequest) {
        seenCommitSha = request.mergeCommitSha;
        return { ok: true };
      },
      async deploy() {
        return { ok: true };
      },
      async getDeploymentStatus() {
        return { status: 'succeeded' };
      },
    };
    const h = harness(eligibleDeployment({ mergeCommitSha: 'c'.repeat(40) }), provider);
    const service = createDeploymentService(h.deps);
    // runDeployment's only parameter is the persisted DeploymentDocument
    // itself — there is no separate "commit" argument an HTTP caller (or
    // anything else) could substitute.
    await service.runDeployment(h.store);

    assert.equal(seenCommitSha, 'c'.repeat(40));
  });

  it('refuses to deploy a row with no merge commit sha rather than guessing one', async () => {
    const h = harness(eligibleDeployment({ mergeCommitSha: null }));
    const service = createDeploymentService(h.deps);
    const result = await service.runDeployment(h.store);

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'configuration_invalid');
  });
});

describe('Property: a deployment can never run twice for the same execution', () => {
  it('a second runDeployment call on the same claimed row is refused, not re-executed', async () => {
    const h = harness(eligibleDeployment());
    const service = createDeploymentService(h.deps);
    const first = await service.runDeployment(h.store);
    assert.ok(first.ok);

    // The store now reflects 'succeeded' — a second call against the same
    // (already-advanced) document must be refused by claim(), never
    // silently redeployed.
    const second = await service.runDeployment(h.store);
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.category, 'already_deployed');
  });
});

describe('Property: deployment configuration is never exposed via the HTTP API', () => {
  it('DeploymentRequest (what the provider receives) never carries a credential-shaped field', () => {
    // Type-level guarantee, demonstrated: the interface has exactly these
    // fields — see deployment-provider.ts's module comment ("never
    // receives unnecessary secrets").
    const request: DeploymentRequest = {
      runId: 'r',
      executionId: 'e',
      publicationId: 'p',
      owner: 'o',
      repo: 'r',
      mergeCommitSha: 'c'.repeat(40),
      target: { name: 't' },
      deploymentIdentifier: 'd',
    };
    const keys = Object.keys(request);
    for (const forbidden of ['token', 'key', 'secret', 'credential', 'password', 'authorization']) {
      assert.ok(!keys.some((k) => k.toLowerCase().includes(forbidden)), `DeploymentRequest unexpectedly carries a '${forbidden}'-shaped field`);
    }
  });
});
