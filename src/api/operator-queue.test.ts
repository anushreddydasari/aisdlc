import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { ObjectId } from 'mongodb';

import type { IntakeItemDocument } from '../intake/repository.ts';
import { createLogger } from '../logging/logger.ts';
import type { RepositoryRegistryDocument } from '../repository-registry/repository.ts';
import type { RepositorySelectionDocument } from '../repository-selection/repository.ts';
import type { RequirementsAnalysisDocument } from '../requirements/repository.ts';
import { BEARER_PREFIX } from './operator-auth.ts';
import { handleGetOperatorQueue, type OperatorQueueDeps } from './operator-queue.ts';

const TOKEN = 'op_test_token_value_not_real'; // pragma: fixture
const NOW = new Date('2026-09-23T12:00:00.000Z');

function request(headers: Record<string, string | undefined> = {}): IncomingMessage {
  const stream = Readable.from([Buffer.alloc(0)]) as unknown as IncomingMessage;
  stream.headers = { authorization: `${BEARER_PREFIX}${TOKEN}`, ...headers } as IncomingMessage['headers'];
  return stream;
}

function intakeItem(issueKey: string, status: IntakeItemDocument['status']): IntakeItemDocument {
  return {
    _id: new ObjectId(),
    issueKey,
    source: 'webhook',
    deliveryRef: null,
    snapshot: { title: `Title ${issueKey}`, description: '<p>Body</p>', issueType: 'task', priority: 'medium', project: 'LOCAL', labels: ['x'] },
    snapshotMeta: null,
    sourceHash: 'h',
    status,
    statusReason: null,
    approvedBy: null,
    approvedAt: null,
    receivedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function selection(issueKey: string, status: RepositorySelectionDocument['status'], candidates: string[], extra: Partial<RepositorySelectionDocument> = {}): RepositorySelectionDocument {
  return {
    _id: new ObjectId(),
    runId: new ObjectId(),
    intakeItemId: new ObjectId(),
    issueKey,
    projectIdentifier: 'LOCAL',
    candidateRepositoryIds: candidates,
    selectedRepositoryId: null,
    selectedRepositoryUrl: null,
    selectedDefaultBranch: null,
    selectedAllowedBranches: null,
    selectedAccessPolicy: null,
    status,
    failureReason: null,
    attempts: 0,
    nextAttemptAt: NOW,
    confirmedBy: null,
    confirmedAt: null,
    lastNotifiedStatus: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}

function registryEntry(repositoryId: string): RepositoryRegistryDocument {
  return {
    _id: new ObjectId(),
    projectIdentifier: 'LOCAL',
    repositoryId,
    repositoryUrl: `https://github.com/org/${repositoryId}`,
    defaultBranch: 'main',
    allowedBranches: ['main'],
    status: 'active',
    accessPolicy: null,
    createdBy: 'operator:t',
    updatedBy: 'operator:t',
    createdAt: NOW,
    updatedAt: NOW,
  } as RepositoryRegistryDocument;
}

interface Fixture {
  intake?: IntakeItemDocument[];
  analyses?: Map<string, Partial<RequirementsAnalysisDocument>>;
  awaiting?: RepositorySelectionDocument[];
  confirmed?: RepositorySelectionDocument[];
  active?: RepositoryRegistryDocument[];
}

function deps(f: Fixture = {}, overrides: Partial<OperatorQueueDeps> = {}): OperatorQueueDeps & { registryCalls: string[] } {
  const registryCalls: string[] = [];
  return {
    logger: createLogger({ write: () => {} }),
    operatorToken: TOKEN,
    intake: {
      async list(filter = {}) {
        const status = (filter as Record<string, unknown>)['status'];
        return (f.intake ?? []).filter((i) => i.status === status);
      },
    },
    requirements: {
      async findByIntakeItemId(id) {
        const item = (f.intake ?? []).find((i) => i._id!.equals(id));
        return (item && (f.analyses?.get(item.issueKey) as RequirementsAnalysisDocument)) ?? null;
      },
    },
    selections: {
      async awaitingConfirmation() {
        return f.awaiting ?? [];
      },
      async recentlyConfirmed() {
        return f.confirmed ?? [];
      },
    },
    registry: {
      async findActiveByProjectIdentifier(project) {
        registryCalls.push(project);
        return (f.active ?? []).filter((e) => e.projectIdentifier === project);
      },
    },
    registryCalls,
    ...overrides,
  };
}

describe('GET /operator/queue', () => {
  it('refuses a missing or wrong token', async () => {
    assert.equal((await handleGetOperatorQueue(request({ authorization: undefined }), deps())).statusCode, 401);
    assert.equal((await handleGetOperatorQueue(request({ authorization: `${BEARER_PREFIX}wrong` }), deps())).statusCode, 401);
  });

  it('refuses everything when OPERATOR_TOKEN is unset', async () => {
    assert.equal((await handleGetOperatorQueue(request(), deps({}, { operatorToken: undefined }))).statusCode, 401);
  });

  it('answers 503 while the database is unavailable', async () => {
    assert.equal((await handleGetOperatorQueue(request(), deps({}, { intake: undefined }))).statusCode, 503);
  });

  it('lists only pending_approval items, each with its requirements analysis', async () => {
    const result = await handleGetOperatorQueue(
      request(),
      deps({
        intake: [intakeItem('LOCAL-1', 'pending_approval'), intakeItem('LOCAL-2', 'approved'), intakeItem('LOCAL-3', 'pending_approval')],
        analyses: new Map([['LOCAL-1', { status: 'completed', agentVersion: 'openai-gpt-4.1', result: { summary: 'S' } as never, completedAt: NOW }]]),
      }),
    );
    assert.equal(result.statusCode, 200);
    const pending = result.body['pendingApproval'] as Record<string, unknown>[];
    assert.deepEqual(pending.map((p) => p['issueKey']), ['LOCAL-1', 'LOCAL-3']);
    assert.deepEqual(pending[0]!['analysis'], { status: 'completed', agentVersion: 'openai-gpt-4.1', result: { summary: 'S' }, completedAt: NOW });
    assert.equal(pending[1]!['analysis'], null);
    assert.equal(pending[0]!['project'], 'LOCAL');
  });

  it('marks each candidate with its CURRENT registry state, since confirm() re-checks it', async () => {
    const d = deps({
      awaiting: [selection('LOCAL-1', 'ambiguous', ['my-profile', 'retired'])],
      active: [registryEntry('my-profile')],
    });
    const result = await handleGetOperatorQueue(request(), d);
    const [s] = result.body['awaitingRepository'] as Record<string, unknown>[];
    assert.equal(s!['status'], 'ambiguous');
    assert.deepEqual(s!['candidates'], [
      { repositoryId: 'my-profile', active: true, repositoryUrl: 'https://github.com/org/my-profile', defaultBranch: 'main' },
      { repositoryId: 'retired', active: false, repositoryUrl: null, defaultBranch: null },
    ]);
  });

  it('looks each project up in the registry once, and never for a blank project', async () => {
    const d = deps({
      awaiting: [selection('A', 'pending', ['r']), selection('B', 'pending', ['r']), selection('C', 'failed', [], { projectIdentifier: '' })],
      active: [registryEntry('r')],
    });
    await handleGetOperatorQueue(request(), d);
    assert.deepEqual(d.registryCalls, ['LOCAL']);
  });

  it('lists pending change reviews for Gate 3 with the full proposed content, and none when reviews are not wired', async () => {
    const review = {
      _id: new ObjectId(),
      runId: new ObjectId(),
      repositoryId: 'my-profile',
      owner: 'anushreddydasari',
      repo: 'my-profile',
      branch: 'master',
      proposalHash: 'a'.repeat(64),
      plan: { summary: 'Add Skills section' },
      proposedChanges: [{ filePath: 'index.html', operation: 'modify', reason: 'add section', proposedContent: '<section>Skills</section>', originalContentHash: 'x', planItemId: 'p1' }],
      status: 'pending',
      createdAt: NOW,
    };
    const withReviews = await handleGetOperatorQueue(request(), deps({}, { reviews: { async pending() { return [review as never]; } } }));
    const [r] = withReviews.body['pendingChangeReviews'] as Record<string, any>[];
    assert.equal(r!['repository'], 'anushreddydasari/my-profile');
    assert.equal(r!['branch'], 'master');
    assert.deepEqual(r!['proposedChanges'], [{ filePath: 'index.html', operation: 'modify', reason: 'add section', proposedContent: '<section>Skills</section>' }]);

    const without = await handleGetOperatorQueue(request(), deps());
    assert.deepEqual(without.body['pendingChangeReviews'], []);
  });

  it('shows what each confirmed run is locked to', async () => {
    const confirmed = selection('LOCAL-9', 'selected', ['my-profile'], {
      selectedRepositoryId: 'my-profile',
      selectedRepositoryUrl: 'https://github.com/org/my-profile',
      selectedDefaultBranch: 'main',
      confirmedBy: 'operator:abhilasha',
      confirmedAt: NOW,
    });
    const result = await handleGetOperatorQueue(request(), deps({ confirmed: [confirmed] }));
    const [row] = result.body['recentlyConfirmed'] as Record<string, unknown>[];
    assert.equal(row!['runId'], confirmed.runId.toHexString());
    assert.equal(row!['selectedRepositoryId'], 'my-profile');
    assert.equal(row!['confirmedBy'], 'operator:abhilasha');
  });
});
