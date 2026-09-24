import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RequirementsResult } from '../requirements/analyzer.ts';
import { generateProposedChanges, hashFileContent } from './changes.ts';
import type { CodingAgentProvider, GenerateChangesResult, ProviderProposedChange } from './provider.ts';
import type { ImplementationPlan, RepositoryContext } from './types.ts';

const REQUIREMENTS: RequirementsResult = {
  summary: 's',
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

const PLAN: ImplementationPlan = {
  summary: 'Add the field',
  requirementsUnderstanding: 'Understood',
  relevantFiles: ['src/index.ts', 'src/new-file.ts'],
  items: [
    { id: 'item-1', filePath: 'src/index.ts', operation: 'modify', changeDescription: 'Modify it' },
    { id: 'item-2', filePath: 'src/new-file.ts', operation: 'create', changeDescription: 'Create it' },
  ],
  dependenciesAndImpact: [],
  testsRequired: [],
  assumptions: [],
  risks: [],
};

function providerWith(changesResult: GenerateChangesResult): CodingAgentProvider {
  return {
    async generateImplementationPlan() {
      throw new Error('must not be called');
    },
    async generateProposedChanges() {
      return changesResult;
    },
  };
}

function change(overrides: Partial<ProviderProposedChange> = {}): ProviderProposedChange {
  return {
    filePath: 'src/index.ts',
    operation: 'modify',
    proposedContent: 'export const x = 1;',
    reason: 'because',
    relatedPlanItemId: 'item-1',
    ...overrides,
  };
}

describe('generateProposedChanges', () => {
  it('accepts well-formed changes and computes the original content hash for a modify', async () => {
    const result = await generateProposedChanges(
      { provider: providerWith({ ok: true, changes: [change()] }) },
      REQUIREMENTS,
      CONTEXT,
      PLAN,
    );

    assert.ok(result.ok);
    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0]!.originalContentHash, hashFileContent('export {};'));
  });

  it('leaves originalContentHash null for a create', async () => {
    const result = await generateProposedChanges(
      {
        provider: providerWith({
          ok: true,
          changes: [change({ filePath: 'src/new-file.ts', operation: 'create', relatedPlanItemId: 'item-2' })],
        }),
      },
      REQUIREMENTS,
      CONTEXT,
      PLAN,
    );

    assert.ok(result.ok);
    assert.equal(result.changes[0]!.originalContentHash, null);
  });

  it('supports multiple changes in one result', async () => {
    const result = await generateProposedChanges(
      {
        provider: providerWith({
          ok: true,
          changes: [change(), change({ filePath: 'src/new-file.ts', operation: 'create', relatedPlanItemId: 'item-2' })],
        }),
      },
      REQUIREMENTS,
      CONTEXT,
      PLAN,
    );
    assert.ok(result.ok);
    assert.equal(result.changes.length, 2);
  });

  it('propagates a provider failure', async () => {
    const result = await generateProposedChanges(
      { provider: providerWith({ ok: false, kind: 'timeout', message: 'timed out' }) },
      REQUIREMENTS,
      CONTEXT,
      PLAN,
    );
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'provider_failure');
  });

  it('rejects an empty changes array as malformed', async () => {
    const result = await generateProposedChanges({ provider: providerWith({ ok: true, changes: [] }) }, REQUIREMENTS, CONTEXT, PLAN);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'malformed_model_output');
  });

  it('rejects a change missing a required field as malformed', async () => {
    const malformed = { filePath: 'src/index.ts', operation: 'modify' } as unknown as ProviderProposedChange;
    const result = await generateProposedChanges({ provider: providerWith({ ok: true, changes: [malformed] }) }, REQUIREMENTS, CONTEXT, PLAN);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'malformed_model_output');
  });

  it('rejects a change referencing an unknown plan item as a validation failure', async () => {
    const result = await generateProposedChanges(
      { provider: providerWith({ ok: true, changes: [change({ relatedPlanItemId: 'no-such-item' })] }) },
      REQUIREMENTS,
      CONTEXT,
      PLAN,
    );
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'validation_failure');
  });

  describe('unsafe proposed changes', () => {
    it('rejects an absolute path', async () => {
      const result = await generateProposedChanges(
        { provider: providerWith({ ok: true, changes: [change({ filePath: '/etc/passwd', operation: 'create', relatedPlanItemId: 'item-2' })] }) },
        REQUIREMENTS,
        CONTEXT,
        PLAN,
      );
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.kind, 'unsafe_proposed_change');
    });

    it('rejects path traversal', async () => {
      const result = await generateProposedChanges(
        { provider: providerWith({ ok: true, changes: [change({ filePath: '../secret.txt', operation: 'create', relatedPlanItemId: 'item-2' })] }) },
        REQUIREMENTS,
        CONTEXT,
        PLAN,
      );
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.kind, 'unsafe_proposed_change');
    });

    it('rejects a credential/secret file target', async () => {
      const result = await generateProposedChanges(
        { provider: providerWith({ ok: true, changes: [change({ filePath: '.env', operation: 'create', relatedPlanItemId: 'item-2' })] }) },
        REQUIREMENTS,
        CONTEXT,
        PLAN,
      );
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.kind, 'unsafe_proposed_change');
    });

    it('rejects an unauthorized (CI/CD) configuration target', async () => {
      const result = await generateProposedChanges(
        {
          provider: providerWith({
            ok: true,
            changes: [change({ filePath: '.github/workflows/ci.yml', operation: 'create', relatedPlanItemId: 'item-2' })],
          }),
        },
        REQUIREMENTS,
        CONTEXT,
        PLAN,
      );
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.kind, 'unsafe_proposed_change');
    });

    it('rejects a modify targeting a file outside repository context (unrelated file)', async () => {
      const result = await generateProposedChanges(
        {
          provider: providerWith({
            ok: true,
            changes: [change({ filePath: 'src/unrelated.ts', operation: 'modify', relatedPlanItemId: 'item-1' })],
          }),
        },
        REQUIREMENTS,
        CONTEXT,
        PLAN,
      );
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.kind, 'unsafe_proposed_change');
    });

    it('rejects a create targeting a file that already exists', async () => {
      const result = await generateProposedChanges(
        { provider: providerWith({ ok: true, changes: [change({ operation: 'create' })] }) },
        REQUIREMENTS,
        CONTEXT,
        PLAN,
      );
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.kind, 'unsafe_proposed_change');
    });

    it('rejects an invalid operation value at the shape layer, before file-reference checks run', async () => {
      const invalid = change({ operation: 'delete' as never });
      const result = await generateProposedChanges({ provider: providerWith({ ok: true, changes: [invalid] }) }, REQUIREMENTS, CONTEXT, PLAN);
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.kind, 'malformed_model_output');
    });
  });

  it('preserves reason and relatedPlanItemId for later human review', async () => {
    const result = await generateProposedChanges(
      { provider: providerWith({ ok: true, changes: [change({ reason: 'fixes the bug', relatedPlanItemId: 'item-1' })] }) },
      REQUIREMENTS,
      CONTEXT,
      PLAN,
    );
    assert.ok(result.ok);
    assert.equal(result.changes[0]!.reason, 'fixes the bug');
    assert.equal(result.changes[0]!.relatedPlanItemId, 'item-1');
  });
});

describe('hashFileContent', () => {
  it('is deterministic', () => {
    assert.equal(hashFileContent('hello'), hashFileContent('hello'));
  });

  it('differs for different content', () => {
    assert.notEqual(hashFileContent('hello'), hashFileContent('world'));
  });

  it('produces a 64-character lowercase hex sha256 digest', () => {
    assert.match(hashFileContent('hello'), /^[0-9a-f]{64}$/);
  });
});
