import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId } from 'mongodb';

import { createLogger } from '../logging/logger.ts';
import type { DeploymentDocument, DeploymentRepository } from './deployment-repository.ts';
import type { DeploymentService } from './deployment-service.ts';
import type { DeploymentResult } from './types.ts';
import { runEligibleDeployments, type DeploymentQueueDeps } from './deployment-queue.ts';

const NOW = new Date('2026-09-24T12:00:00.000Z');
const RUN_ID = new ObjectId();

function eligibleDeployment(overrides: Partial<DeploymentDocument> = {}): DeploymentDocument {
  return {
    _id: new ObjectId(),
    runId: RUN_ID,
    executionId: new ObjectId(),
    publicationId: new ObjectId(),
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

function fakeDeploymentRepository(rows: DeploymentDocument[]): DeploymentRepository {
  return {
    async createIfAbsent() {
      throw new Error('not used');
    },
    async findByPublicationId() {
      throw new Error('not used');
    },
    async findEligible(limit = 25) {
      return rows.slice(0, limit);
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
}

function harness(
  options: { deployments?: DeploymentDocument[]; serviceResults?: Record<string, DeploymentResult> } = {},
): { deps: DeploymentQueueDeps; runCalls: string[] } {
  const runCalls: string[] = [];
  const deploymentService: DeploymentService = {
    async runDeployment(deployment: DeploymentDocument) {
      runCalls.push(deployment._id!.toHexString());
      const override = options.serviceResults?.[deployment._id!.toHexString()];
      if (override !== undefined) return override;
      return { ok: true, runId: deployment.runId, deploymentId: deployment._id!, deploymentIdentifier: 'mock-deployment-1', validation: { health: { ok: true, summary: 'ok' }, readiness: { ok: true, summary: 'ok' } } };
    },
  };

  return {
    deps: {
      deployments: fakeDeploymentRepository(options.deployments ?? [eligibleDeployment()]),
      deploymentService,
      logger: createLogger({ write: () => {} }),
    },
    runCalls,
  };
}

describe('runEligibleDeployments', () => {
  it('runs every eligible deployment', async () => {
    const h = harness();
    const summary = await runEligibleDeployments(h.deps);

    assert.equal(summary.examined, 1);
    assert.equal(summary.deployed, 1);
    assert.equal(h.runCalls.length, 1);
  });

  it('counts an already-claimed deployment separately from a genuine failure', async () => {
    const deployment = eligibleDeployment();
    const claimedElsewhere: DeploymentResult = {
      ok: false,
      runId: RUN_ID,
      deploymentId: deployment._id!,
      category: 'already_deployed',
      message: 'no longer eligible',
      retryable: false,
    };
    const h = harness({ deployments: [deployment], serviceResults: { [deployment._id!.toHexString()]: claimedElsewhere } });
    const summary = await runEligibleDeployments(h.deps);

    assert.equal(summary.alreadyClaimed, 1);
    assert.equal(summary.failed, 0);
  });

  it('counts a validation-only failure separately from a deployment failure', async () => {
    const deployment = eligibleDeployment();
    const validationFailed: DeploymentResult = {
      ok: false,
      runId: RUN_ID,
      deploymentId: deployment._id!,
      category: 'validation_failed',
      message: 'health check failed',
      retryable: false,
    };
    const h = harness({ deployments: [deployment], serviceResults: { [deployment._id!.toHexString()]: validationFailed } });
    const summary = await runEligibleDeployments(h.deps);

    assert.equal(summary.validationFailed, 1);
    assert.equal(summary.deployed, 0);
    assert.equal(summary.failed, 0);
  });

  it('one failing item does not stop the pass', async () => {
    const bad = eligibleDeployment();
    const good = eligibleDeployment();
    const failure: DeploymentResult = {
      ok: false,
      runId: RUN_ID,
      deploymentId: bad._id!,
      category: 'deployment_provider_failure',
      message: 'exploded',
      retryable: false,
    };
    const h = harness({ deployments: [bad, good], serviceResults: { [bad._id!.toHexString()]: failure } });
    const summary = await runEligibleDeployments(h.deps);

    assert.equal(summary.examined, 2);
    assert.equal(summary.deployed, 1);
    assert.equal(summary.failed, 1);
  });
});
