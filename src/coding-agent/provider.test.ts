import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RequirementsResult } from '../requirements/analyzer.ts';
import { createMockCodingAgentProvider, isProviderFailureRetryable } from './provider.ts';
import type { ImplementationPlan, RepositoryContext } from './types.ts';

const REQUIREMENTS: RequirementsResult = {
  summary: 'Add a field',
  problemStatement: 'p',
  functionalRequirements: [],
  acceptanceCriteria: [],
  assumptions: [],
  risks: [],
  suggestedArea: null,
};

const CONTEXT: RepositoryContext = {
  repositoryId: 'aisdlc-service',
  owner: 'cloudfuze',
  repo: 'aisdlc-service',
  branch: 'main',
  defaultBranch: 'main',
  visibility: 'private',
  files: [{ path: 'src/index.ts', content: 'export {};' }],
};

describe('createMockCodingAgentProvider', () => {
  it('is deterministic by default: produces a valid plan referencing the given context', async () => {
    const provider = createMockCodingAgentProvider();
    const result = await provider.generateImplementationPlan({ requirements: REQUIREMENTS, context: CONTEXT });
    assert.ok(result.ok);
    assert.equal(result.plan.items[0]!.filePath, 'src/index.ts');
  });

  it('is deterministic by default: produces proposed changes matching the plan items', async () => {
    const provider = createMockCodingAgentProvider();
    const planResult = await provider.generateImplementationPlan({ requirements: REQUIREMENTS, context: CONTEXT });
    assert.ok(planResult.ok);
    const changesResult = await provider.generateProposedChanges({
      requirements: REQUIREMENTS,
      context: CONTEXT,
      plan: planResult.plan,
    });
    assert.ok(changesResult.ok);
    assert.equal(changesResult.changes[0]!.relatedPlanItemId, planResult.plan.items[0]!.id);
  });

  it('returns exactly the configured planResult when provided', async () => {
    const forcedPlan: ImplementationPlan = {
      summary: 'forced',
      requirementsUnderstanding: 'u',
      relevantFiles: [],
      items: [],
      dependenciesAndImpact: [],
      testsRequired: [],
      assumptions: [],
      risks: [],
    };
    const provider = createMockCodingAgentProvider({ planResult: { ok: true, plan: forcedPlan } });
    const result = await provider.generateImplementationPlan({ requirements: REQUIREMENTS, context: CONTEXT });
    assert.ok(result.ok);
    assert.equal(result.plan.summary, 'forced');
  });

  it('returns exactly the configured failure when provided', async () => {
    const provider = createMockCodingAgentProvider({ planResult: { ok: false, kind: 'rate_limited', message: 'nope' } });
    const result = await provider.generateImplementationPlan({ requirements: REQUIREMENTS, context: CONTEXT });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'rate_limited');
  });

  it('returns an empty plan (no items) when the context has no files', async () => {
    const provider = createMockCodingAgentProvider();
    const result = await provider.generateImplementationPlan({
      requirements: REQUIREMENTS,
      context: { ...CONTEXT, files: [] },
    });
    assert.ok(result.ok);
    assert.deepEqual(result.plan.items, []);
  });
});

describe('isProviderFailureRetryable', () => {
  it('is true for rate_limited, timeout, and transient', () => {
    assert.equal(isProviderFailureRetryable('rate_limited'), true);
    assert.equal(isProviderFailureRetryable('timeout'), true);
    assert.equal(isProviderFailureRetryable('transient'), true);
  });

  it('is false for authentication_failed, malformed, and unexpected_error', () => {
    assert.equal(isProviderFailureRetryable('authentication_failed'), false);
    assert.equal(isProviderFailureRetryable('malformed'), false);
    assert.equal(isProviderFailureRetryable('unexpected_error'), false);
  });
});
