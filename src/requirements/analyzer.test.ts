import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { IntakeSnapshot } from '../intake/repository.ts';
import { analyzeRequirements } from './analyzer.ts';

const SNAPSHOT: IntakeSnapshot = {
  title: 'Login fails for SSO users',
  description: '<p>Users see a blank page. Refreshing does not help.</p>',
  issueType: 'bug',
  priority: 'high',
  project: 'AISDLC',
  labels: ['sso', 'auth'],
  parentKey: 'AIS-0',
};

describe('analyzeRequirements', () => {
  it('is deterministic: the same snapshot produces the same result', () => {
    assert.deepEqual(analyzeRequirements(SNAPSHOT), analyzeRequirements(SNAPSHOT));
  });

  it('uses the trimmed title as the summary', () => {
    const result = analyzeRequirements({ ...SNAPSHOT, title: '  Login fails  ' });
    assert.equal(result.summary, 'Login fails');
  });

  it('strips HTML out of the description for the problem statement', () => {
    const result = analyzeRequirements(SNAPSHOT);
    assert.doesNotMatch(result.problemStatement, /<[^>]+>/);
    assert.match(result.problemStatement, /Users see a blank page/);
  });

  it('derives one functional requirement per sentence, capped at 5', () => {
    const manySentences: IntakeSnapshot = {
      ...SNAPSHOT,
      description: Array.from({ length: 8 }, (_, i) => `Sentence ${i}.`).join(' '),
    };
    const result = analyzeRequirements(manySentences);
    assert.equal(result.functionalRequirements.length, 5);
  });

  it('falls back to a title-derived requirement when the description is empty', () => {
    const result = analyzeRequirements({ ...SNAPSHOT, description: '' });
    assert.equal(result.functionalRequirements.length, 1);
    assert.match(result.functionalRequirements[0]!, /Login fails for SSO users/);
  });

  it('produces one acceptance criterion per functional requirement', () => {
    const result = analyzeRequirements(SNAPSHOT);
    assert.equal(result.acceptanceCriteria.length, result.functionalRequirements.length);
  });

  it('prefers project over labels for the suggested area', () => {
    const result = analyzeRequirements(SNAPSHOT);
    assert.equal(result.suggestedArea, 'AISDLC');
  });

  it('falls back to the first label when project is absent', () => {
    const result = analyzeRequirements({ ...SNAPSHOT, project: null });
    assert.equal(result.suggestedArea, 'sso');
  });

  it('is null when neither project nor labels are present', () => {
    const result = analyzeRequirements({ ...SNAPSHOT, project: null, labels: null });
    assert.equal(result.suggestedArea, null);
  });

  it('flags missing labels, missing parent and a short description as risks', () => {
    const result = analyzeRequirements({
      ...SNAPSHOT,
      labels: [],
      parentKey: null,
      description: 'short',
    });
    assert.ok(result.risks.some((r) => /labels/.test(r)));
    assert.ok(result.risks.some((r) => /parent/.test(r)));
    assert.ok(result.risks.some((r) => /short/.test(r)));
  });

  it('reports no open questions when nothing is missing', () => {
    const result = analyzeRequirements({
      ...SNAPSHOT,
      description: '<p>' + 'A well described ticket with plenty of detail. '.repeat(3) + '</p>',
    });
    assert.deepEqual(result.risks, ['No open questions identified from the available ticket data.']);
  });

  it('never calls fetch or reads the network', () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error('analyzer must not access the network');
    }) as typeof fetch;
    try {
      analyzeRequirements(SNAPSHOT);
    } finally {
      globalThis.fetch = original;
    }
  });
});
