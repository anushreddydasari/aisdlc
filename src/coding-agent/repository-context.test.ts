import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId } from 'mongodb';

import type { RequirementsResult } from '../requirements/analyzer.ts';
import type { GitHubAccessResult, GitHubAccessService } from '../github-access/service.ts';
import {
  buildRepositoryContext,
  createDefaultFileSelectionPolicy,
  DEFAULT_MAX_CONTEXT_FILES,
  type RepositoryContextDeps,
} from './repository-context.ts';

const REQUIREMENTS: RequirementsResult = {
  summary: 's',
  problemStatement: 'p',
  functionalRequirements: [],
  acceptanceCriteria: [],
  assumptions: [],
  risks: [],
  suggestedArea: null,
};

describe('createDefaultFileSelectionPolicy', () => {
  it('deduplicates and sorts candidate paths', () => {
    const policy = createDefaultFileSelectionPolicy();
    const result = policy.selectFiles({
      requirements: REQUIREMENTS,
      candidatePaths: ['b.ts', 'a.ts', 'b.ts', 'c.ts'],
    });
    assert.deepEqual(result, ['a.ts', 'b.ts', 'c.ts']);
  });

  it('drops blank entries', () => {
    const policy = createDefaultFileSelectionPolicy();
    const result = policy.selectFiles({ requirements: REQUIREMENTS, candidatePaths: ['a.ts', '', '   '] });
    assert.deepEqual(result, ['a.ts']);
  });

  it('bounds the result to maxFiles', () => {
    const policy = createDefaultFileSelectionPolicy({ maxFiles: 2 });
    const result = policy.selectFiles({
      requirements: REQUIREMENTS,
      candidatePaths: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
    });
    assert.equal(result.length, 2);
    assert.deepEqual(result, ['a.ts', 'b.ts']);
  });

  it('defaults to DEFAULT_MAX_CONTEXT_FILES', () => {
    const policy = createDefaultFileSelectionPolicy();
    const many = Array.from({ length: DEFAULT_MAX_CONTEXT_FILES + 10 }, (_, i) => `file-${i}.ts`);
    const result = policy.selectFiles({ requirements: REQUIREMENTS, candidatePaths: many });
    assert.equal(result.length, DEFAULT_MAX_CONTEXT_FILES);
  });

  it('is deterministic: the same input always produces the same output', () => {
    const policy = createDefaultFileSelectionPolicy();
    const input = { requirements: REQUIREMENTS, candidatePaths: ['z.ts', 'a.ts', 'm.ts'] };
    assert.deepEqual(policy.selectFiles(input), policy.selectFiles(input));
  });
});

describe('buildRepositoryContext', () => {
  const RUN_ID = new ObjectId();

  function githubAccessStub(result: GitHubAccessResult): GitHubAccessService {
    return {
      async accessRepositoryForRun() {
        return result;
      },
    };
  }

  function successResult(overrides: Partial<GitHubAccessResult & { ok: true }> = {}): GitHubAccessResult {
    return {
      ok: true,
      runId: RUN_ID,
      intakeItemId: new ObjectId(),
      repositoryId: 'aisdlc-service',
      owner: 'cloudfuze',
      repo: 'aisdlc-service',
      branch: 'main',
      defaultBranch: 'main',
      visibility: 'private',
      files: [{ path: 'README.md', content: '# hi' }],
      ...overrides,
    };
  }

  it('builds a RepositoryContext from a successful GitHub access result', async () => {
    const deps: RepositoryContextDeps = {
      githubAccess: githubAccessStub(successResult()),
      fileSelectionPolicy: createDefaultFileSelectionPolicy(),
    };
    const result = await buildRepositoryContext(deps, RUN_ID, REQUIREMENTS, ['README.md']);

    assert.ok(result.ok);
    assert.equal(result.context.owner, 'cloudfuze');
    assert.equal(result.context.repositoryId, 'aisdlc-service');
    assert.deepEqual(result.context.files, [{ path: 'README.md', content: '# hi' }]);
  });

  it('propagates a GitHub access failure', async () => {
    const failureResult: GitHubAccessResult = {
      ok: false,
      runId: RUN_ID,
      intakeItemId: null,
      repositoryId: null,
      category: 'run_not_found',
      message: 'no such run',
      retryable: false,
    };
    const deps: RepositoryContextDeps = {
      githubAccess: githubAccessStub(failureResult),
      fileSelectionPolicy: createDefaultFileSelectionPolicy(),
    };
    const result = await buildRepositoryContext(deps, RUN_ID, REQUIREMENTS, ['README.md']);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'github_access_failure');
    assert.equal(result.ok === false && result.kind === 'github_access_failure' && result.githubFailure.category, 'run_not_found');
  });

  it('fails with no_files_selected when the policy selects nothing, without calling GitHub access', async () => {
    let called = false;
    const deps: RepositoryContextDeps = {
      githubAccess: {
        async accessRepositoryForRun() {
          called = true;
          return successResult();
        },
      },
      fileSelectionPolicy: { selectFiles: () => [] },
    };
    const result = await buildRepositoryContext(deps, RUN_ID, REQUIREMENTS, ['README.md']);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'no_files_selected');
    assert.equal(called, false);
  });
});
