import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId } from 'mongodb';

import type { AuditEntryInput, AuditLog } from '../db/audit-log.ts';
import { createLogger } from '../logging/logger.ts';
import { hashSnapshot, type IntakeItemDocument, type IntakeSnapshot } from '../intake/repository.ts';
import { STUB_ANALYZER_VERSION, type RequirementsResult } from './analyzer.ts';
import type {
  CreatePendingInput,
  MarkCompletedInput,
  MarkFailedInput,
  RequirementsAnalysisDocument,
  RequirementsRepository,
} from './repository.ts';
import { runRequirementsAgent, type RequirementsAgentDeps } from './worker.ts';

const NOW = new Date('2026-09-21T12:00:00.000Z');

const SNAPSHOT: IntakeSnapshot = {
  title: 'Login fails for SSO users',
  description: '<p>Users see a blank page.</p>',
  issueType: 'bug',
  priority: 'high',
  project: 'AISDLC',
  labels: ['sso'],
};

function intakeItem(overrides: Partial<IntakeItemDocument> = {}): IntakeItemDocument {
  return {
    _id: new ObjectId(),
    issueKey: 'CF-1',
    source: 'webhook',
    deliveryRef: null,
    snapshot: SNAPSHOT,
    snapshotMeta: null,
    sourceHash: hashSnapshot(SNAPSHOT),
    status: 'received',
    statusReason: null,
    approvedBy: null,
    approvedAt: null,
    receivedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

interface Harness {
  readonly deps: RequirementsAgentDeps;
  readonly rows: RequirementsAnalysisDocument[];
  readonly auditEntries: AuditEntryInput[];
  readonly analyzeCalls: IntakeSnapshot[];
}

function harness(
  options: {
    seed?: RequirementsAnalysisDocument;
    analyzeThrows?: boolean;
    analyzeResult?: RequirementsResult;
  } = {},
): Harness {
  const rows: RequirementsAnalysisDocument[] = options.seed ? [{ ...options.seed }] : [];
  const auditEntries: AuditEntryInput[] = [];
  const analyzeCalls: IntakeSnapshot[] = [];

  function find(intakeItemId: ObjectId): RequirementsAnalysisDocument | undefined {
    return rows.find((row) => row.intakeItemId.equals(intakeItemId));
  }

  const repository: RequirementsRepository = {
    async createPending(input: CreatePendingInput) {
      const existing = find(input.intakeItemId);
      if (existing) return { created: false, document: { ...existing } };

      const document: RequirementsAnalysisDocument = {
        _id: new ObjectId(),
        intakeItemId: input.intakeItemId,
        issueKey: input.issueKey,
        status: 'pending',
        inputHash: input.inputHash,
        result: null,
        error: null,
        attempts: 0,
        agentVersion: 'unassigned',
        usage: null,
        createdAt: NOW,
        updatedAt: NOW,
        completedAt: null,
      };
      rows.push(document);
      return { created: true, document: { ...document } };
    },
    async findByIntakeItemId(intakeItemId: ObjectId) {
      const row = find(intakeItemId);
      return row ? { ...row } : null;
    },
    async markCompleted(intakeItemId: ObjectId, input: MarkCompletedInput) {
      const row = find(intakeItemId);
      if (!row) throw new Error('not found');
      row.status = 'completed';
      row.result = input.result;
      row.error = null;
      row.inputHash = input.inputHash;
      row.agentVersion = input.agentVersion;
      row.attempts += 1;
      row.completedAt = input.now ?? NOW;
      return { ...row };
    },
    async markFailed(intakeItemId: ObjectId, input: MarkFailedInput) {
      const row = find(intakeItemId);
      if (!row) throw new Error('not found');
      row.status = 'failed';
      row.error = { message: input.message, at: input.now ?? NOW };
      row.inputHash = input.inputHash;
      row.agentVersion = input.agentVersion;
      row.attempts += 1;
      return { ...row };
    },
    async recordUsage(intakeItemId: ObjectId, usage) {
      const row = find(intakeItemId);
      if (!row) throw new Error('not found');
      row.usage = usage;
      return { ...row };
    },
  };

  const audit: AuditLog = {
    async append(entry) {
      auditEntries.push(entry);
      return new ObjectId();
    },
    async query() {
      return [];
    },
  };

  const analyze = (snapshot: IntakeSnapshot): RequirementsResult => {
    analyzeCalls.push(snapshot);
    if (options.analyzeThrows) throw new Error('analyzer exploded');
    return (
      options.analyzeResult ?? {
        summary: snapshot.title,
        problemStatement: snapshot.description,
        functionalRequirements: ['req'],
        acceptanceCriteria: ['ac'],
        assumptions: ['assumption'],
        risks: ['risk'],
        suggestedArea: null,
      }
    );
  };

  return {
    deps: { repository, audit, logger: createLogger({ write: () => {} }), now: () => NOW, analyze },
    rows,
    auditEntries,
    analyzeCalls,
  };
}

describe('runRequirementsAgent: happy path', () => {
  it('validates, analyzes and stores a completed result', async () => {
    const item = intakeItem();
    const h = harness();

    const outcome = await runRequirementsAgent(item, h.deps);

    assert.equal(outcome.outcome, 'completed');
    assert.equal(outcome.document.status, 'completed');
    assert.ok(outcome.document.result);
    assert.equal(h.analyzeCalls.length, 1);
    assert.equal(h.rows.length, 1);
  });

  it('records pending and completed audit entries against the intake item', async () => {
    const item = intakeItem();
    const h = harness();

    await runRequirementsAgent(item, h.deps);

    const actions = h.auditEntries.map((e) => e.action);
    assert.deepEqual(actions, ['requirements.pending', 'requirements.completed']);
    for (const entry of h.auditEntries) {
      assert.equal(entry.subjectType, 'intakeItem');
      assert.equal(entry.subjectId, item._id);
    }
  });

  it('does not modify the intake item it was given', async () => {
    const item = intakeItem();
    const before = JSON.parse(JSON.stringify(item));
    const h = harness();

    await runRequirementsAgent(item, h.deps);

    assert.deepEqual(JSON.parse(JSON.stringify(item)), before);
  });

  it('never touches the network', async () => {
    const item = intakeItem();
    const h = harness();
    const original = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error('the requirements agent must not access the network');
    }) as typeof fetch;
    try {
      await runRequirementsAgent(item, h.deps);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('awaits an async analyze (e.g. an LLM-backed one), not just a synchronous one', async () => {
    const item = intakeItem();
    const h = harness();
    let resolved = false;
    const deps: RequirementsAgentDeps = {
      ...h.deps,
      analyze: async (snapshot: IntakeSnapshot) => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        resolved = true;
        return {
          summary: snapshot.title,
          problemStatement: snapshot.description,
          functionalRequirements: ['async req'],
          acceptanceCriteria: ['async ac'],
          assumptions: ['async assumption'],
          risks: ['async risk'],
          suggestedArea: null,
        };
      },
    };

    const outcome = await runRequirementsAgent(item, deps);

    assert.ok(resolved, 'the returned promise must have been awaited before storing the result');
    assert.equal(outcome.outcome, 'completed');
    assert.deepEqual(outcome.document.result?.functionalRequirements, ['async req']);
  });
});

describe('runRequirementsAgent: validation failures', () => {
  it('marks failed_validation when the description is empty, without calling analyze', async () => {
    const item = intakeItem({ snapshot: { ...SNAPSHOT, description: '' } });
    const h = harness();

    const outcome = await runRequirementsAgent(item, h.deps);

    assert.equal(outcome.outcome, 'failed_validation');
    assert.equal(outcome.document.status, 'failed');
    assert.match(outcome.document.error?.message ?? '', /description/);
    assert.equal(h.analyzeCalls.length, 0);
    assert.deepEqual(
      h.auditEntries.map((e) => e.action),
      ['requirements.pending', 'requirements.failed'],
    );
  });
});

describe('runRequirementsAgent: analyzer failures', () => {
  it('marks failed_analysis when the analyzer throws', async () => {
    const item = intakeItem();
    const h = harness({ analyzeThrows: true });

    const outcome = await runRequirementsAgent(item, h.deps);

    assert.equal(outcome.outcome, 'failed_analysis');
    assert.equal(outcome.document.status, 'failed');
    assert.match(outcome.document.error?.message ?? '', /analyzer exploded/);
  });
});

describe('runRequirementsAgent: retries and duplicates', () => {
  it('is a no-op when a completed analysis already matches the current content', async () => {
    const item = intakeItem();
    const seed: RequirementsAnalysisDocument = {
      _id: new ObjectId(),
      intakeItemId: item._id!,
      issueKey: item.issueKey,
      status: 'completed',
      inputHash: hashSnapshot(item.snapshot),
      result: {
        summary: item.snapshot.title,
        problemStatement: item.snapshot.description,
        functionalRequirements: ['existing'],
        acceptanceCriteria: ['existing'],
        assumptions: ['existing'],
        risks: ['existing'],
        suggestedArea: null,
      },
      error: null,
      attempts: 1,
      agentVersion: STUB_ANALYZER_VERSION,
      usage: null,
      createdAt: NOW,
      updatedAt: NOW,
      completedAt: NOW,
    };
    const h = harness({ seed });

    const outcome = await runRequirementsAgent(item, h.deps);

    assert.equal(outcome.outcome, 'skipped_up_to_date');
    assert.equal(h.analyzeCalls.length, 0, 'must not re-run the analyzer');
    assert.equal(h.rows.length, 1, 'must not create a second row');
    assert.equal(h.auditEntries.length, 0, 'no new audit entry for a no-op');
  });

  it('re-analyzes when the intake content changed since the last completed run', async () => {
    const item = intakeItem();
    const seed: RequirementsAnalysisDocument = {
      _id: new ObjectId(),
      intakeItemId: item._id!,
      issueKey: item.issueKey,
      status: 'completed',
      // A stale hash, as if the snapshot changed after this row was written.
      inputHash: 'stale-hash',
      result: {
        summary: 'old',
        problemStatement: 'old',
        functionalRequirements: [],
        acceptanceCriteria: [],
        assumptions: [],
        risks: [],
        suggestedArea: null,
      },
      error: null,
      attempts: 1,
      agentVersion: STUB_ANALYZER_VERSION,
      usage: null,
      createdAt: NOW,
      updatedAt: NOW,
      completedAt: NOW,
    };
    const h = harness({ seed });

    const outcome = await runRequirementsAgent(item, h.deps);

    assert.equal(outcome.outcome, 'completed');
    assert.equal(h.analyzeCalls.length, 1);
    assert.equal(h.rows.length, 1, 'updates the existing row rather than appending');
    assert.equal(outcome.document.inputHash, hashSnapshot(item.snapshot));
    assert.equal(outcome.document.attempts, 2);
  });

  it('retrying after a failure updates the same row rather than creating a second one', async () => {
    const item = intakeItem();
    const h = harness();

    const firstAttempt = intakeItem({ _id: item._id!, snapshot: { ...SNAPSHOT, description: '' } });
    const first = await runRequirementsAgent(firstAttempt, h.deps);
    assert.equal(first.outcome, 'failed_validation');

    const second = await runRequirementsAgent(item, h.deps);

    assert.equal(second.outcome, 'completed');
    assert.equal(h.rows.length, 1, 'must not create a second row on retry');
    assert.equal(second.document.attempts, 2);
  });

  it('two concurrent-looking calls on the same unchanged item only create one row', async () => {
    const item = intakeItem();
    const h = harness();

    await Promise.all([runRequirementsAgent(item, h.deps), runRequirementsAgent(item, h.deps)]);

    assert.equal(h.rows.length, 1);
  });
});
