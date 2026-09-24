import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createMockDeploymentProvider, type DeploymentRequest } from './deployment-provider.ts';

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

describe('createMockDeploymentProvider', () => {
  it('validates successfully by default', async () => {
    const provider = createMockDeploymentProvider();
    assert.deepEqual(await provider.validateDeployment(REQUEST), { ok: true });
  });

  it('deploys successfully by default', async () => {
    const provider = createMockDeploymentProvider();
    assert.deepEqual(await provider.deploy(REQUEST), { ok: true });
  });

  it('reports a successful deployment as succeeded via getDeploymentStatus, keyed by the caller-supplied identifier', async () => {
    const provider = createMockDeploymentProvider();
    await provider.deploy(REQUEST);
    const status = await provider.getDeploymentStatus(REQUEST.deploymentIdentifier);
    assert.equal(status.status, 'succeeded');
  });

  it('reports unknown for an identifier that was never deployed', async () => {
    const provider = createMockDeploymentProvider();
    const status = await provider.getDeploymentStatus('never-deployed');
    assert.equal(status.status, 'unknown');
  });

  it('can be configured to fail validation', async () => {
    const provider = createMockDeploymentProvider({ validateResult: { ok: false, message: 'bad config' } });
    const result = await provider.validateDeployment(REQUEST);
    assert.deepEqual(result, { ok: false, message: 'bad config' });
  });

  it('records the deploy as having landed even when configured to report a failure — enables reconciliation testing', async () => {
    const provider = createMockDeploymentProvider({ deployResult: { ok: false, message: 'timed out', retryable: true } });
    const result = await provider.deploy(REQUEST);
    assert.equal(result.ok, false);

    // The deploy is still tracked internally, simulating "the response was
    // lost, but the deployment actually landed" — see the module comment.
    const status = await provider.getDeploymentStatus(REQUEST.deploymentIdentifier);
    assert.equal(status.status, 'succeeded');
  });

  it('is deterministic and offline: repeated calls with the same request behave identically', async () => {
    const provider = createMockDeploymentProvider();
    const first = await provider.deploy(REQUEST);
    const second = await provider.deploy({ ...REQUEST, deploymentIdentifier: 'deployment-run-2-exec-2' });
    assert.deepEqual(first, second);
  });
});
