import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RequirementsResult } from '../requirements/analyzer.ts';
import { generateImplementationPlan } from './plan.ts';
import type { CodingAgentProvider, GeneratePlanResult } from './provider.ts';
import type { ImplementationPlan, RepositoryContext } from './types.ts';

const REQUIREMENTS: RequirementsResult = {
  summary: 'Add a health field',
  problemStatement: 'The status endpoint is missing a field.',
  functionalRequirements: ['The endpoint shall include the field.'],
  acceptanceCriteria: ['Given a request, when handled, then the field is present.'],
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

function validPlan(overrides: Partial<ImplementationPlan> = {}): ImplementationPlan {
  return {
    summary: 'Add the field',
    requirementsUnderstanding: 'Understood',
    relevantFiles: ['src/index.ts'],
    items: [{ id: 'item-1', filePath: 'src/index.ts', operation: 'modify', changeDescription: 'Add the field' }],
    dependenciesAndImpact: [],
    testsRequired: [],
    assumptions: [],
    risks: [],
    ...overrides,
  };
}

function providerWith(planResult: GeneratePlanResult): CodingAgentProvider {
  return {
    async generateImplementationPlan() {
      return planResult;
    },
    async generateProposedChanges() {
      throw new Error('must not be called');
    },
  };
}

describe('generateImplementationPlan', () => {
  it('accepts a well-formed, self-consistent plan', async () => {
    const result = await generateImplementationPlan(
      { provider: providerWith({ ok: true, plan: validPlan() }) },
      REQUIREMENTS,
      CONTEXT,
    );
    assert.ok(result.ok);
    assert.equal(result.plan.items.length, 1);
  });

  it('propagates a provider failure', async () => {
    const result = await generateImplementationPlan(
      { provider: providerWith({ ok: false, kind: 'rate_limited', message: 'rate limited' }) },
      REQUIREMENTS,
      CONTEXT,
    );
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'provider_failure');
  });

  describe('malformed shape', () => {
    for (const [name, plan] of Object.entries({
      'missing summary': { ...validPlan(), summary: '' },
      'missing items array': { ...validPlan(), items: 'not-an-array' as never },
      'item missing id': { ...validPlan(), items: [{ filePath: 'x', operation: 'modify', changeDescription: 'd' }] as never },
      'item with invalid operation': {
        ...validPlan(),
        items: [{ id: 'i', filePath: 'x', operation: 'delete', changeDescription: 'd' }] as never,
      },
      'relevantFiles not an array of strings': { ...validPlan(), relevantFiles: [1, 2] as never },
    })) {
      it(`rejects ${name} as malformed_model_output`, async () => {
        const result = await generateImplementationPlan(
          { provider: providerWith({ ok: true, plan: plan as ImplementationPlan }) },
          REQUIREMENTS,
          CONTEXT,
        );
        assert.equal(result.ok, false);
        assert.equal(result.ok === false && result.kind, 'malformed_model_output');
      });
    }
  });

  describe('content validation', () => {
    it('rejects a plan with zero items', async () => {
      const result = await generateImplementationPlan(
        { provider: providerWith({ ok: true, plan: validPlan({ items: [] }) }) },
        REQUIREMENTS,
        CONTEXT,
      );
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.kind, 'validation_failure');
    });

    it('rejects duplicate item ids', async () => {
      const plan = validPlan({
        items: [
          { id: 'item-1', filePath: 'src/index.ts', operation: 'modify', changeDescription: 'a' },
          { id: 'item-1', filePath: 'src/other.ts', operation: 'create', changeDescription: 'b' },
        ],
        relevantFiles: ['src/index.ts', 'src/other.ts'],
      });
      const result = await generateImplementationPlan({ provider: providerWith({ ok: true, plan }) }, REQUIREMENTS, CONTEXT);
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.kind, 'validation_failure');
    });

    it('rejects a modify item referencing a file not in the repository context', async () => {
      const plan = validPlan({
        items: [{ id: 'item-1', filePath: 'src/missing.ts', operation: 'modify', changeDescription: 'a' }],
        relevantFiles: ['src/missing.ts'],
      });
      const result = await generateImplementationPlan({ provider: providerWith({ ok: true, plan }) }, REQUIREMENTS, CONTEXT);
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.kind, 'validation_failure');
    });

    it('rejects a create item for a file that already exists in context', async () => {
      const plan = validPlan({
        items: [{ id: 'item-1', filePath: 'src/index.ts', operation: 'create', changeDescription: 'a' }],
      });
      const result = await generateImplementationPlan({ provider: providerWith({ ok: true, plan }) }, REQUIREMENTS, CONTEXT);
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.kind, 'validation_failure');
    });

    it('rejects a create item for a path neither in context nor declared relevant by the plan', async () => {
      // src/new-file.ts is not in CONTEXT.files (so create is structurally
      // allowed) but the plan never lists it in relevantFiles either — an
      // LLM free-associating an unrelated new file, which the structural
      // scope check catches even though it cannot judge semantic relevance.
      const plan = validPlan({
        relevantFiles: ['src/index.ts'], // does not mention src/new-file.ts
        items: [{ id: 'item-1', filePath: 'src/new-file.ts', operation: 'create', changeDescription: 'a' }],
      });
      const result = await generateImplementationPlan({ provider: providerWith({ ok: true, plan }) }, REQUIREMENTS, CONTEXT);
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.kind, 'validation_failure');
    });

    it('rejects an item referencing an unsafe path (e.g. traversal)', async () => {
      const plan = validPlan({
        relevantFiles: ['../secret.txt'],
        items: [{ id: 'item-1', filePath: '../secret.txt', operation: 'create', changeDescription: 'a' }],
      });
      const result = await generateImplementationPlan({ provider: providerWith({ ok: true, plan }) }, REQUIREMENTS, CONTEXT);
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.kind, 'validation_failure');
    });

    it('accepts a create item whose path is declared relevant even though it is not yet in context', async () => {
      const plan = validPlan({
        relevantFiles: ['src/index.ts', 'src/new-file.ts'],
        items: [
          { id: 'item-1', filePath: 'src/index.ts', operation: 'modify', changeDescription: 'a' },
          { id: 'item-2', filePath: 'src/new-file.ts', operation: 'create', changeDescription: 'b' },
        ],
      });
      const result = await generateImplementationPlan({ provider: providerWith({ ok: true, plan }) }, REQUIREMENTS, CONTEXT);
      assert.ok(result.ok);
    });
  });
});
