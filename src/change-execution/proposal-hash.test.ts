import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { computeProposalHash } from './proposal-hash.ts';
import type { ImplementationPlan, ProposedChange } from './types.ts';

const PLAN: ImplementationPlan = {
  summary: 'Add a health field',
  requirementsUnderstanding: 'u',
  relevantFiles: ['src/index.ts'],
  items: [{ id: 'item-1', filePath: 'src/index.ts', operation: 'modify', changeDescription: 'd' }],
  dependenciesAndImpact: [],
  testsRequired: [],
  assumptions: [],
  risks: [],
};

const CHANGES: ProposedChange[] = [
  {
    filePath: 'src/index.ts',
    operation: 'modify',
    originalContentHash: 'abc123',
    proposedContent: 'export {};',
    reason: 'r',
    relatedPlanItemId: 'item-1',
  },
];

describe('computeProposalHash', () => {
  it('is deterministic for identical content', () => {
    assert.equal(computeProposalHash(PLAN, CHANGES), computeProposalHash(PLAN, CHANGES));
  });

  it('is unaffected by object key insertion order', () => {
    const reorderedPlan: ImplementationPlan = {
      risks: PLAN.risks,
      assumptions: PLAN.assumptions,
      testsRequired: PLAN.testsRequired,
      dependenciesAndImpact: PLAN.dependenciesAndImpact,
      items: PLAN.items,
      relevantFiles: PLAN.relevantFiles,
      requirementsUnderstanding: PLAN.requirementsUnderstanding,
      summary: PLAN.summary,
    };
    assert.equal(computeProposalHash(PLAN, CHANGES), computeProposalHash(reorderedPlan, CHANGES));
  });

  it('changes when the plan summary changes', () => {
    const other: ImplementationPlan = { ...PLAN, summary: 'A different summary' };
    assert.notEqual(computeProposalHash(PLAN, CHANGES), computeProposalHash(other, CHANGES));
  });

  it('changes when a proposed change differs', () => {
    const other: ProposedChange[] = [{ ...CHANGES[0]!, proposedContent: 'export const x = 1;' }];
    assert.notEqual(computeProposalHash(PLAN, CHANGES), computeProposalHash(PLAN, other));
  });

  it('changes when proposed-change array order differs, even with identical items', () => {
    const second: ProposedChange = {
      filePath: 'src/other.ts',
      operation: 'create',
      originalContentHash: null,
      proposedContent: 'export {};',
      reason: 'r2',
      relatedPlanItemId: 'item-1',
    };
    const forward = [CHANGES[0]!, second];
    const reversed = [second, CHANGES[0]!];
    assert.notEqual(computeProposalHash(PLAN, forward), computeProposalHash(PLAN, reversed));
  });

  it('produces a 64-character lowercase hex digest', () => {
    assert.match(computeProposalHash(PLAN, CHANGES), /^[0-9a-f]{64}$/);
  });
});
