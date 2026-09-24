import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createMockChangeValidationRunner } from './validation.ts';
import { isValidationSuccessful } from './types.ts';

describe('createMockChangeValidationRunner', () => {
  it('defaults to every step passing', async () => {
    const runner = createMockChangeValidationRunner();
    const summary = await runner.run({ runId: 'run-1', workingDirectory: '/tmp/whatever' });

    assert.ok(isValidationSuccessful(summary));
    assert.equal(summary.tests.ok, true);
    assert.equal(summary.typecheck.ok, true);
    assert.equal(summary.build.ok, true);
  });

  it('simulates a failing test step while leaving the others passing', async () => {
    const runner = createMockChangeValidationRunner({ tests: false });
    const summary = await runner.run({ runId: 'run-1', workingDirectory: '/tmp/whatever' });

    assert.equal(isValidationSuccessful(summary), false);
    assert.equal(summary.tests.ok, false);
    assert.equal(summary.typecheck.ok, true);
    assert.equal(summary.build.ok, true);
  });

  it('simulates a failing typecheck step', async () => {
    const runner = createMockChangeValidationRunner({ typecheck: false });
    const summary = await runner.run({ runId: 'run-1', workingDirectory: '/tmp/whatever' });

    assert.equal(isValidationSuccessful(summary), false);
    assert.equal(summary.typecheck.ok, false);
  });

  it('simulates a failing build step', async () => {
    const runner = createMockChangeValidationRunner({ build: false });
    const summary = await runner.run({ runId: 'run-1', workingDirectory: '/tmp/whatever' });

    assert.equal(isValidationSuccessful(summary), false);
    assert.equal(summary.build.ok, false);
  });

  it('is deterministic and offline: repeated calls give identical results', async () => {
    const runner = createMockChangeValidationRunner({ tests: false });
    const first = await runner.run({ runId: 'run-1', workingDirectory: '/tmp/a' });
    const second = await runner.run({ runId: 'run-1', workingDirectory: '/tmp/b' });

    assert.deepEqual(first, second);
  });
});
