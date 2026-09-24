import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isPostDeploymentValidationSuccessful } from './types.ts';
import { createMockPostDeploymentValidator } from './post-deployment-validator.ts';
import type { DeploymentRequest } from './deployment-provider.ts';

const REQUEST: DeploymentRequest = {
  runId: 'run-1',
  executionId: 'exec-1',
  publicationId: 'pub-1',
  owner: 'cloudfuze',
  repo: 'aisdlc-service',
  mergeCommitSha: 'deadbeef',
  target: { name: 'mock-environment' },
  deploymentIdentifier: 'deployment-run-1-exec-1',
};

describe('createMockPostDeploymentValidator', () => {
  it('defaults to both checks passing', async () => {
    const validator = createMockPostDeploymentValidator();
    const summary = await validator.validate(REQUEST, 'deployment-run-1-exec-1');
    assert.ok(isPostDeploymentValidationSuccessful(summary));
  });

  it('simulates a failing health check while readiness still passes', async () => {
    const validator = createMockPostDeploymentValidator({ health: false });
    const summary = await validator.validate(REQUEST, 'deployment-run-1-exec-1');
    assert.equal(isPostDeploymentValidationSuccessful(summary), false);
    assert.equal(summary.health.ok, false);
    assert.equal(summary.readiness.ok, true);
  });

  it('simulates a failing readiness check', async () => {
    const validator = createMockPostDeploymentValidator({ readiness: false });
    const summary = await validator.validate(REQUEST, 'deployment-run-1-exec-1');
    assert.equal(isPostDeploymentValidationSuccessful(summary), false);
    assert.equal(summary.readiness.ok, false);
  });

  it('is deterministic and offline', async () => {
    const validator = createMockPostDeploymentValidator({ health: false });
    const first = await validator.validate(REQUEST, 'a');
    const second = await validator.validate(REQUEST, 'b');
    assert.deepEqual(first, second);
  });
});
