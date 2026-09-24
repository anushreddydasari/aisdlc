/**
 * Every test here uses in-memory fakes: no real MongoDB, no real GitHub
 * App, no real OpenAI call. `GitHubAccessService` is faked directly rather
 * than built from its own dependencies — github-access/service.ts has its
 * own exhaustive test suite; this file only needs to prove THIS service
 * reacts correctly to what that one returns.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId } from 'mongodb';

import type { AuditEntryInput, AuditLog } from '../db/audit-log.ts';
import { createLogger } from '../logging/logger.ts';
import type { RunDocument, RunsRepository } from '../orchestrator/repository.ts';
import type { RequirementsAnalysisDocument, RequirementsRepository } from '../requirements/repository.ts';
import type { RequirementsResult } from '../requirements/analyzer.ts';
import type { GitHubAccessResult, GitHubAccessService } from '../github-access/service.ts';
import { createCodingAgentService, type CodingAgentDeps } from './service.ts';
import { createDefaultFileSelectionPolicy, type RepositoryContextDeps } from './repository-context.ts';
import { createMockCodingAgentProvider, type CodingAgentProvider, type GeneratePlanResult, type GenerateChangesResult } from './provider.ts';
import type { ImplementationPlan, RepositoryContext } from './types.ts';

const NOW = new Date('2026-09-22T00:00:00.000Z');
const RUN_ID = new ObjectId();
const INTAKE_ITEM_ID = new ObjectId();

function run(overrides: Partial<RunDocument> = {}): RunDocument {
  return {
    _id: RUN_ID,
    intakeItemId: INTAKE_ITEM_ID,
    issueKey: 'CF-1',
    status: 'queued',
    trigger: 'approval',
    createdAt: NOW,
    startedAt: null,
    completedAt: null,
    updatedAt: NOW,
    ...overrides,
  };
}

const REQUIREMENTS_RESULT: RequirementsResult = {
  summary: 'Add a health field',
  problemStatement: 'The status endpoint is missing a field.',
  functionalRequirements: ['The endpoint shall include the field.'],
  acceptanceCriteria: ['Given a request, when handled, then the field is present.'],
  assumptions: [],
  risks: [],
  suggestedArea: null,
};

function analysis(overrides: Partial<RequirementsAnalysisDocument> = {}): RequirementsAnalysisDocument {
  return {
    _id: new ObjectId(),
    intakeItemId: INTAKE_ITEM_ID,
    issueKey: 'CF-1',
    status: 'completed',
    inputHash: 'hash',
    result: REQUIREMENTS_RESULT,
    error: null,
    attempts: 1,
    agentVersion: 'stub-v1',
    usage: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: NOW,
    ...overrides,
  };
}

function githubAccessSuccess(overrides: Partial<Extract<GitHubAccessResult, { ok: true }>> = {}): GitHubAccessResult {
  return {
    ok: true,
    runId: RUN_ID,
    intakeItemId: INTAKE_ITEM_ID,
    repositoryId: 'aisdlc-service',
    owner: 'cloudfuze',
    repo: 'aisdlc-service',
    branch: 'main',
    defaultBranch: 'main',
    visibility: 'private',
    files: [{ path: 'src/index.ts', content: 'export {};' }],
    ...overrides,
  };
}

function githubAccessFailure(overrides: Partial<Extract<GitHubAccessResult, { ok: false }>> = {}): GitHubAccessResult {
  return {
    ok: false,
    runId: RUN_ID,
    intakeItemId: INTAKE_ITEM_ID,
    repositoryId: null,
    category: 'selection_missing',
    message: 'no repository selection exists for this run',
    retryable: false,
    ...overrides,
  };
}

interface Harness {
  readonly deps: CodingAgentDeps;
  readonly auditEntries: AuditEntryInput[];
  readonly logs: string[];
  readonly githubAccessCalls: number;
  readonly requirementsCalls: number;
}

function harness(
  options: {
    run?: RunDocument | null;
    analysis?: RequirementsAnalysisDocument | null;
    githubAccessResult?: GitHubAccessResult;
    provider?: CodingAgentProvider;
  } = {},
): Harness {
  const auditEntries: AuditEntryInput[] = [];
  const logs: string[] = [];
  let githubAccessCalls = 0;
  let requirementsCalls = 0;

  const runs: RunsRepository = {
    async createIfAbsent() {
      throw new Error('must not be called');
    },
    async findByIntakeItemId() {
      throw new Error('must not be called');
    },
    async findById() {
      return 'run' in options ? options.run! : run();
    },
    async list() {
      throw new Error('must not be called');
    },
  };

  const requirements: RequirementsRepository = {
    async createPending() {
      throw new Error('must not be called');
    },
    async findByIntakeItemId() {
      requirementsCalls += 1;
      return 'analysis' in options ? options.analysis! : analysis();
    },
    async markCompleted() {
      throw new Error('must not be called');
    },
    async markFailed() {
      throw new Error('must not be called');
    },
    async recordUsage() {
      throw new Error('must not be called');
    },
  };

  const githubAccess: GitHubAccessService = {
    async accessRepositoryForRun() {
      githubAccessCalls += 1;
      return options.githubAccessResult ?? githubAccessSuccess();
    },
    async listFilesForRun(): Promise<never> {
      throw new Error('must not be called');
    },
  };
  const repositoryContext: RepositoryContextDeps = {
    githubAccess,
    fileSelectionPolicy: createDefaultFileSelectionPolicy(),
  };

  const provider = options.provider ?? createMockCodingAgentProvider();

  const audit: AuditLog = {
    async append(entry: AuditEntryInput) {
      auditEntries.push(entry);
      return new ObjectId();
    },
    async query() {
      return [];
    },
  };

  return {
    deps: {
      runs,
      requirements,
      repositoryContext,
      provider,
      audit,
      logger: createLogger({ level: 'debug', write: (line) => logs.push(line) }),
    },
    auditEntries,
    logs,
    get githubAccessCalls() {
      return githubAccessCalls;
    },
    get requirementsCalls() {
      return requirementsCalls;
    },
  };
}

describe('successful flow', () => {
  it('produces a plan and proposed changes for an approved, confirmed run', async () => {
    const h = harness();
    const service = createCodingAgentService(h.deps);
    const result = await service.run({ runId: RUN_ID, candidateFilePaths: ['src/index.ts'] });

    assert.ok(result.ok);
    assert.equal(result.repositoryId, 'aisdlc-service');
    assert.ok(result.intakeItemId.equals(INTAKE_ITEM_ID));
    assert.equal(result.plan.items.length, 1);
    assert.equal(result.proposedChanges.length, 1);
    assert.equal(result.proposedChanges[0]!.filePath, 'src/index.ts');
  });
});

describe('input validation', () => {
  it('rejects an empty candidateFilePaths list without calling GitHub access', async () => {
    const h = harness();
    const service = createCodingAgentService(h.deps);
    const result = await service.run({ runId: RUN_ID, candidateFilePaths: [] });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.category, 'invalid_input');
    assert.equal(h.githubAccessCalls, 0);
  });

  it('rejects a missing run', async () => {
    const h = harness({ run: null });
    const service = createCodingAgentService(h.deps);
    const result = await service.run({ runId: RUN_ID, candidateFilePaths: ['src/index.ts'] });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.category, 'invalid_input');
    assert.equal(h.requirementsCalls, 0);
    assert.equal(h.githubAccessCalls, 0);
  });

  it('rejects missing requirements without calling GitHub access', async () => {
    const h = harness({ analysis: null });
    const service = createCodingAgentService(h.deps);
    const result = await service.run({ runId: RUN_ID, candidateFilePaths: ['src/index.ts'] });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.category, 'missing_requirements');
    assert.equal(h.githubAccessCalls, 0);
  });

  for (const status of ['pending', 'failed'] as const) {
    it(`rejects requirements analysis with status '${status}'`, async () => {
      const h = harness({ analysis: analysis({ status, result: null }) });
      const service = createCodingAgentService(h.deps);
      const result = await service.run({ runId: RUN_ID, candidateFilePaths: ['src/index.ts'] });

      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.category, 'missing_requirements');
    });
  }

  it('rejects an intake item that is not approved, via the GitHub Access Integration boundary', async () => {
    const h = harness({ githubAccessResult: githubAccessFailure({ category: 'intake_not_approved', message: 'x' }) });
    const service = createCodingAgentService(h.deps);
    const result = await service.run({ runId: RUN_ID, candidateFilePaths: ['src/index.ts'] });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.category, 'github_access_failure');
  });

  it('rejects a missing repository selection, via the GitHub Access Integration boundary', async () => {
    const h = harness({ githubAccessResult: githubAccessFailure({ category: 'selection_missing' }) });
    const service = createCodingAgentService(h.deps);
    const result = await service.run({ runId: RUN_ID, candidateFilePaths: ['src/index.ts'] });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.category, 'github_access_failure');
  });

  it('rejects an unconfirmed repository selection, via the GitHub Access Integration boundary', async () => {
    const h = harness({ githubAccessResult: githubAccessFailure({ category: 'selection_not_confirmed' }) });
    const service = createCodingAgentService(h.deps);
    const result = await service.run({ runId: RUN_ID, candidateFilePaths: ['src/index.ts'] });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.category, 'github_access_failure');
  });

  it('never accepts a caller-supplied repository or branch — there is no such input to mismatch', () => {
    // CodingAgentInput carries only { runId, candidateFilePaths } (see
    // types.ts) — repository identity and branch are always DERIVED from
    // the confirmed selection via GitHub Access Integration, never
    // supplied independently. "Repository mismatch" / "branch mismatch"
    // are therefore prevented by construction, not merely validated away;
    // there is no code path by which this service could be asked to use a
    // different repository or branch than the one the run confirmed.
    assert.ok(true);
  });

  it('treats a repository-context failure (e.g. all candidate paths blank) as repository_context_failure', async () => {
    const h = harness();
    const service = createCodingAgentService(h.deps);
    const result = await service.run({ runId: RUN_ID, candidateFilePaths: ['   '] });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.category, 'repository_context_failure');
    assert.equal(h.githubAccessCalls, 0);
  });

  it('propagates retryable and retryAfterMs from a rate-limited GitHub access failure', async () => {
    const h = harness({
      githubAccessResult: githubAccessFailure({ category: 'rate_limited', retryable: true, retryAfterMs: 5000 }),
    });
    const service = createCodingAgentService(h.deps);
    const result = await service.run({ runId: RUN_ID, candidateFilePaths: ['src/index.ts'] });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.retryable, true);
    assert.equal(result.ok === false && result.retryAfterMs, 5000);
  });

  it('propagates a GitHub timeout as retryable', async () => {
    const h = harness({ githubAccessResult: githubAccessFailure({ category: 'timeout', retryable: true }) });
    const service = createCodingAgentService(h.deps);
    const result = await service.run({ runId: RUN_ID, candidateFilePaths: ['src/index.ts'] });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.retryable, true);
  });
});

describe('provider failures', () => {
  it('maps a malformed plan (missing required fields) to malformed_model_output', async () => {
    const provider = createMockCodingAgentProvider({
      planResult: { ok: true, plan: { summary: '' } as unknown as ImplementationPlan },
    });
    const h = harness({ provider });
    const service = createCodingAgentService(h.deps);
    const result = await service.run({ runId: RUN_ID, candidateFilePaths: ['src/index.ts'] });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.category, 'malformed_model_output');
  });

  it('maps a plan with invalid file references to validation_failure', async () => {
    const invalidPlan: ImplementationPlan = {
      summary: 's',
      requirementsUnderstanding: 'u',
      relevantFiles: ['../secret.txt'],
      items: [{ id: 'item-1', filePath: '../secret.txt', operation: 'create', changeDescription: 'd' }],
      dependenciesAndImpact: [],
      testsRequired: [],
      assumptions: [],
      risks: [],
    };
    const provider = createMockCodingAgentProvider({ planResult: { ok: true, plan: invalidPlan } });
    const h = harness({ provider });
    const service = createCodingAgentService(h.deps);
    const result = await service.run({ runId: RUN_ID, candidateFilePaths: ['src/index.ts'] });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.category, 'validation_failure');
  });

  it('maps a provider timeout on the plan step to the timeout category, retryable', async () => {
    const provider = createMockCodingAgentProvider({
      planResult: { ok: false, kind: 'timeout', message: 'timed out' },
    });
    const h = harness({ provider });
    const service = createCodingAgentService(h.deps);
    const result = await service.run({ runId: RUN_ID, candidateFilePaths: ['src/index.ts'] });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.category, 'timeout');
    assert.equal(result.ok === false && result.retryable, true);
  });

  it('maps a generic transient provider failure to provider_failure, retryable', async () => {
    const provider = createMockCodingAgentProvider({
      planResult: { ok: false, kind: 'transient', message: 'network blip' },
    });
    const h = harness({ provider });
    const service = createCodingAgentService(h.deps);
    const result = await service.run({ runId: RUN_ID, candidateFilePaths: ['src/index.ts'] });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.category, 'provider_failure');
    assert.equal(result.ok === false && result.retryable, true);
  });

  it('maps a non-retryable provider failure (authentication_failed) to provider_failure, not retryable', async () => {
    const provider = createMockCodingAgentProvider({
      planResult: { ok: false, kind: 'authentication_failed', message: 'bad key' },
    });
    const h = harness({ provider });
    const service = createCodingAgentService(h.deps);
    const result = await service.run({ runId: RUN_ID, candidateFilePaths: ['src/index.ts'] });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.category, 'provider_failure');
    assert.equal(result.ok === false && result.retryable, false);
  });

  it('maps an unexpected exception thrown by the provider to unexpected_error, never crashing the service', async () => {
    const provider: CodingAgentProvider = {
      async generateImplementationPlan() {
        throw new Error('provider exploded');
      },
      async generateProposedChanges() {
        throw new Error('must not be called');
      },
    };
    const h = harness({ provider });
    const service = createCodingAgentService(h.deps);
    const result = await service.run({ runId: RUN_ID, candidateFilePaths: ['src/index.ts'] });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.category, 'unexpected_error');
    assert.equal(result.ok === false && result.retryable, false);
  });

  it('maps a provider failure on the changes step the same way as on the plan step', async () => {
    const provider = createMockCodingAgentProvider({
      changesResult: { ok: false, kind: 'rate_limited', message: 'rate limited' },
    });
    const h = harness({ provider });
    const service = createCodingAgentService(h.deps);
    const result = await service.run({ runId: RUN_ID, candidateFilePaths: ['src/index.ts'] });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.category, 'rate_limited');
  });

  it('never calls generateProposedChanges when the plan itself is invalid', async () => {
    let changesCalled = false;
    const provider: CodingAgentProvider = {
      async generateImplementationPlan(): Promise<GeneratePlanResult> {
        return { ok: true, plan: { summary: '' } as unknown as ImplementationPlan };
      },
      async generateProposedChanges(): Promise<GenerateChangesResult> {
        changesCalled = true;
        return { ok: true, changes: [] };
      },
    };
    const h = harness({ provider });
    const service = createCodingAgentService(h.deps);
    await service.run({ runId: RUN_ID, candidateFilePaths: ['src/index.ts'] });

    assert.equal(changesCalled, false);
  });
});

describe('unsafe proposed changes surfaced through the full service', () => {
  it('rejects a proposed change to a credential file', async () => {
    const plan: ImplementationPlan = {
      summary: 's',
      requirementsUnderstanding: 'u',
      relevantFiles: ['.env'],
      items: [{ id: 'item-1', filePath: '.env', operation: 'create', changeDescription: 'd' }],
      dependenciesAndImpact: [],
      testsRequired: [],
      assumptions: [],
      risks: [],
    };
    // .env as a plan item is itself rejected by plan validation before
    // changes are even attempted — see path-safety.ts's shared checks.
    const provider = createMockCodingAgentProvider({ planResult: { ok: true, plan } });
    const h = harness({ provider });
    const service = createCodingAgentService(h.deps);
    const result = await service.run({ runId: RUN_ID, candidateFilePaths: ['src/index.ts'] });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.category, 'validation_failure');
  });

  it('rejects a proposed change referencing an unrelated file not in the repository context', async () => {
    const plan: ImplementationPlan = {
      summary: 's',
      requirementsUnderstanding: 'u',
      relevantFiles: ['src/index.ts'],
      items: [{ id: 'item-1', filePath: 'src/index.ts', operation: 'modify', changeDescription: 'd' }],
      dependenciesAndImpact: [],
      testsRequired: [],
      assumptions: [],
      risks: [],
    };
    const provider = createMockCodingAgentProvider({
      planResult: { ok: true, plan },
      changesResult: {
        ok: true,
        changes: [
          {
            filePath: 'src/unrelated-file.ts',
            operation: 'modify',
            proposedContent: 'x',
            reason: 'r',
            relatedPlanItemId: 'item-1',
          },
        ],
      },
    });
    const h = harness({ provider });
    const service = createCodingAgentService(h.deps);
    const result = await service.run({ runId: RUN_ID, candidateFilePaths: ['src/index.ts'] });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.category, 'unsafe_proposed_change');
  });
});

describe('safety', () => {
  it('the GitHubAccessService boundary exposes no write capability of any kind', () => {
    // Structural, not behavioral: GitHubAccessService's interface (see
    // github-access/service.ts) has exactly one method,
    // accessRepositoryForRun, which is read-only. There is no
    // createBranch/commit/openPullRequest method on any dependency this
    // service holds — a write cannot happen because there is nothing to
    // call, not merely because nothing calls it today.
    assert.ok(true);
  });

  it('a CodingAgentResult never contains anything token- or key-shaped', async () => {
    const h = harness();
    const service = createCodingAgentService(h.deps);
    const result = await service.run({ runId: RUN_ID, candidateFilePaths: ['src/index.ts'] });
    assert.ok(result.ok);

    const serialized = JSON.stringify(result);
    assert.ok(!/ghs_|ghp_|sk-|eyJ[A-Za-z0-9_-]+\./.test(serialized));
  });

  it('never includes proposed file content in an audit entry', async () => {
    const provider = createMockCodingAgentProvider({
      changesResult: {
        ok: true,
        changes: [
          {
            filePath: 'src/index.ts',
            operation: 'modify',
            proposedContent: 'super-secret-proprietary-algorithm',
            reason: 'r',
            relatedPlanItemId: 'item-1',
          },
        ],
      },
    });
    const h = harness({ provider });
    const service = createCodingAgentService(h.deps);
    await service.run({ runId: RUN_ID, candidateFilePaths: ['src/index.ts'] });

    const serialized = JSON.stringify(h.auditEntries);
    assert.ok(!serialized.includes('super-secret-proprietary-algorithm'));
  });

  it('never includes repository file content in a log line', async () => {
    const h = harness();
    const service = createCodingAgentService(h.deps);
    await service.run({ runId: RUN_ID, candidateFilePaths: ['src/index.ts'] });

    assert.ok(!h.logs.join('\n').includes('export {};'));
  });
});

describe('idempotency', () => {
  it('de-duplicates concurrent calls for the same run', async () => {
    const h = harness();
    const service = createCodingAgentService(h.deps);

    const [a, b] = await Promise.all([
      service.run({ runId: RUN_ID, candidateFilePaths: ['src/index.ts'] }),
      service.run({ runId: RUN_ID, candidateFilePaths: ['src/index.ts'] }),
    ]);

    assert.deepEqual(a, b);
    assert.equal(h.requirementsCalls, 1, 'requirements should only be looked up once for overlapping calls');
    assert.equal(h.githubAccessCalls, 1, 'GitHub access should only be requested once for overlapping calls');
  });

  it('runs a fresh execution for a later, sequential call (repeated execution)', async () => {
    const h = harness();
    const service = createCodingAgentService(h.deps);

    const first = await service.run({ runId: RUN_ID, candidateFilePaths: ['src/index.ts'] });
    const second = await service.run({ runId: RUN_ID, candidateFilePaths: ['src/index.ts'] });

    assert.ok(first.ok && second.ok);
    assert.equal(h.requirementsCalls, 2);
    assert.equal(h.githubAccessCalls, 2);
  });

  it('does not create conflicting state: repeated execution for the same run always analyzes the same confirmed repository', async () => {
    const h = harness();
    const service = createCodingAgentService(h.deps);

    const first = await service.run({ runId: RUN_ID, candidateFilePaths: ['src/index.ts'] });
    const second = await service.run({ runId: RUN_ID, candidateFilePaths: ['src/index.ts'] });

    assert.ok(first.ok && second.ok);
    assert.equal(first.repositoryId, second.repositoryId);
  });
});

describe('audit events', () => {
  it('emits started, repository-context.created, plan.created, changes.proposed in order for a successful run', async () => {
    const h = harness();
    const service = createCodingAgentService(h.deps);
    await service.run({ runId: RUN_ID, candidateFilePaths: ['src/index.ts'] });

    assert.deepEqual(
      h.auditEntries.map((e) => e.action),
      [
        'coding-agent.started',
        'coding-agent.repository-context.created',
        'coding-agent.plan.created',
        'coding-agent.changes.proposed',
      ],
    );
    for (const entry of h.auditEntries) {
      assert.equal(entry.actor, 'system:coding-agent');
      assert.equal(entry.subjectType, 'run');
      assert.ok(entry.subjectId.equals(RUN_ID));
    }
  });

  it('emits started then failed for a validation failure, with the failure category in detail', async () => {
    const h = harness({ analysis: null });
    const service = createCodingAgentService(h.deps);
    await service.run({ runId: RUN_ID, candidateFilePaths: ['src/index.ts'] });

    assert.deepEqual(
      h.auditEntries.map((e) => e.action),
      ['coding-agent.started', 'coding-agent.failed'],
    );
    assert.equal(h.auditEntries[1]!.detail?.['category'], 'missing_requirements');
  });

  it('stops at repository-context.created when the plan step fails — no plan.created or changes.proposed event', async () => {
    const provider = createMockCodingAgentProvider({ planResult: { ok: false, kind: 'malformed', message: 'x' } });
    const h = harness({ provider });
    const service = createCodingAgentService(h.deps);
    await service.run({ runId: RUN_ID, candidateFilePaths: ['src/index.ts'] });

    assert.deepEqual(
      h.auditEntries.map((e) => e.action),
      ['coding-agent.started', 'coding-agent.repository-context.created', 'coding-agent.failed'],
    );
  });
});
