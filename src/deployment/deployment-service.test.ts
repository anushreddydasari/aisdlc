import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId } from 'mongodb';

import type { AuditEntryInput, AuditLog } from '../db/audit-log.ts';
import { createLogger } from '../logging/logger.ts';
import type { CreateDeploymentInput, DeploymentDocument, DeploymentRepository, MarkFailedInput, MarkSucceededInput } from './deployment-repository.ts';
import { createMockDeploymentProvider, type DeploymentProvider, type DeploymentRequest } from './deployment-provider.ts';
import { createMockPostDeploymentValidator, type PostDeploymentValidator } from './post-deployment-validator.ts';
import { createDeploymentService, type DeploymentServiceDeps } from './deployment-service.ts';

const NOW = new Date('2026-09-24T12:00:00.000Z');
const RUN_ID = new ObjectId();
const EXECUTION_ID = new ObjectId();
const PUBLICATION_ID = new ObjectId();

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

interface Harness {
  readonly deps: DeploymentServiceDeps;
  readonly auditEntries: AuditEntryInput[];
  readonly store: DeploymentDocument;
}

function harness(
  options: {
    deployment?: DeploymentDocument;
    provider?: DeploymentProvider;
    validator?: PostDeploymentValidator;
  } = {},
): Harness {
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
  const { repo: deployments, store } = fakeDeploymentRepository(options.deployment ?? eligibleDeployment());

  return {
    deps: {
      deployments,
      provider: options.provider ?? createMockDeploymentProvider(),
      validator: options.validator ?? createMockPostDeploymentValidator(),
      audit,
      logger: createLogger({ write: () => {} }),
    },
    auditEntries,
    store,
  };
}

describe('runDeployment — success', () => {
  it('claims, deploys, validates, and marks the row succeeded', async () => {
    const h = harness();
    const service = createDeploymentService(h.deps);
    const result = await service.runDeployment(h.store);

    assert.ok(result.ok);
    assert.equal(h.store.status, 'succeeded');
    assert.equal(h.store.provider, 'mock');
  });

  it('emits the expected audit sequence', async () => {
    const h = harness();
    const service = createDeploymentService(h.deps);
    await service.runDeployment(h.store);

    assert.deepEqual(h.auditEntries.map((e) => e.action), [
      'deployment.started',
      'deployment.validation.started',
      'deployment.validation.completed',
    ]);
  });

  it('uses a deterministic deployment identifier derived from run and execution ids', async () => {
    const seenIdentifiers: string[] = [];
    const provider: DeploymentProvider = {
      async validateDeployment() {
        return { ok: true };
      },
      async deploy(request: DeploymentRequest) {
        seenIdentifiers.push(request.deploymentIdentifier);
        return { ok: true };
      },
      async getDeploymentStatus() {
        return { status: 'succeeded' };
      },
    };
    // Two SEPARATE deployment rows (and therefore separate fake
    // repositories, each supporting one claim/complete lifecycle) sharing
    // the same runId/executionId — the identifier must depend only on
    // those ids, not on which row instance carries them.
    const first = harness({ provider, deployment: eligibleDeployment({ _id: new ObjectId() }) });
    const second = harness({ provider, deployment: eligibleDeployment({ _id: new ObjectId() }) });
    const service1 = createDeploymentService(first.deps);
    const service2 = createDeploymentService(second.deps);
    await service1.runDeployment(first.store);
    await service2.runDeployment(second.store);

    assert.equal(seenIdentifiers[0], seenIdentifiers[1], 'the same run/execution always derives the same identifier');
  });
});

describe('runDeployment — eligibility (Section 6)', () => {
  it('refuses a deployment that is no longer eligible (already claimed)', async () => {
    const h = harness({ deployment: eligibleDeployment({ status: 'running' }) });
    const service = createDeploymentService(h.deps);
    const result = await service.runDeployment(h.store);

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'already_deployed');
  });
});

describe('runDeployment — provider failures', () => {
  it('marks the deployment failed when validateDeployment refuses', async () => {
    const provider = createMockDeploymentProvider({ validateResult: { ok: false, message: 'bad target' } });
    const h = harness({ provider });
    const service = createDeploymentService(h.deps);
    const result = await service.runDeployment(h.store);

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'configuration_invalid');
    assert.equal(h.store.status, 'failed');
  });

  it('marks the deployment failed when deploy() genuinely fails and reconciliation finds nothing', async () => {
    const provider = createMockDeploymentProvider({ deployResult: { ok: false, message: 'exploded', retryable: false } });
    // Override reconciliation to report the deploy never landed.
    const wrapped: DeploymentProvider = { ...provider, async getDeploymentStatus() { return { status: 'unknown' }; } };
    const h = harness({ provider: wrapped });
    const service = createDeploymentService(h.deps);
    const result = await service.runDeployment(h.store);

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'deployment_provider_failure');
    assert.equal(h.store.status, 'failed');
  });

  it('recovers a deployment that actually landed despite an ambiguous deploy() failure', async () => {
    const provider = createMockDeploymentProvider({ deployResult: { ok: false, message: 'timed out (simulated)', retryable: true } });
    const h = harness({ provider });
    const service = createDeploymentService(h.deps);
    const result = await service.runDeployment(h.store);

    assert.ok(result.ok, 'reconciliation should find the deployment that actually landed');
    assert.equal(h.store.status, 'succeeded');
  });
});

describe('runDeployment — post-deployment validation (Section 14)', () => {
  it('records the deployment as succeeded even when validation fails — no automatic rollback', async () => {
    const validator = createMockPostDeploymentValidator({ health: false });
    const h = harness({ validator });
    const service = createDeploymentService(h.deps);
    const result = await service.runDeployment(h.store);

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'validation_failed');
    // The persisted row shows the deployment SUCCEEDED — validation is a separate fact.
    assert.equal(h.store.status, 'succeeded');
    assert.equal(h.store.validation!.health.ok, false);
  });

  it('emits deployment.validation.failed, never deployment.failed, for a validation-only failure', async () => {
    const validator = createMockPostDeploymentValidator({ readiness: false });
    const h = harness({ validator });
    const service = createDeploymentService(h.deps);
    await service.runDeployment(h.store);

    assert.deepEqual(h.auditEntries.map((e) => e.action), [
      'deployment.started',
      'deployment.validation.started',
      'deployment.validation.failed',
    ]);
  });
});

describe('security: no secrets in the audit trail', () => {
  it('never records a token, key, or Authorization-shaped value', async () => {
    const h = harness();
    const service = createDeploymentService(h.deps);
    await service.runDeployment(h.store);

    for (const entry of h.auditEntries) {
      const serialized = JSON.stringify(entry.detail ?? {}).toLowerCase();
      assert.ok(!serialized.includes('token'));
      assert.ok(!serialized.includes('authorization'));
    }
  });
});
