import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { ObjectId } from 'mongodb';

import type { IntakeItemDocument } from '../intake/repository.ts';
import { createLogger } from '../logging/logger.ts';
import type { RunDocument } from '../orchestrator/repository.ts';
import type { RepositorySelectionDocument } from '../repository-selection/repository.ts';
import type { RequirementsAnalysisDocument } from '../requirements/repository.ts';
import { renderConsoleUi } from './console-ui.ts';
import { BEARER_PREFIX } from './operator-auth.ts';
import { handleGetOperatorTickets, isAuthorizationError, type OperatorTicketsDeps } from './operator-tickets.ts';
import { handleRequest, type ServerDeps } from './server.ts';
import type { RunStatusSources } from './run-status.ts';

const TOKEN = 'op_test_token_value_not_real'; // pragma: fixture
const NOW = new Date('2026-09-23T12:00:00.000Z');

function request(headers: Record<string, string | undefined> = {}): IncomingMessage {
  const stream = Readable.from([Buffer.alloc(0)]) as unknown as IncomingMessage;
  stream.headers = { authorization: `${BEARER_PREFIX}${TOKEN}`, ...headers } as IncomingMessage['headers'];
  return stream;
}

function item(issueKey: string, status: IntakeItemDocument['status'], extra: Partial<IntakeItemDocument> = {}): IntakeItemDocument {
  return {
    _id: new ObjectId(),
    issueKey,
    source: 'webhook',
    deliveryRef: null,
    snapshot: { title: `Title ${issueKey}`, description: 'd', issueType: 'task', priority: 'medium', project: 'LOCAL' },
    snapshotMeta: null,
    sourceHash: 'h',
    status,
    statusReason: null,
    approvedBy: null,
    approvedAt: null,
    receivedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}

function ticketsDeps(items: IntakeItemDocument[], runs: Map<string, RunDocument>, selections: Map<string, RepositorySelectionDocument>): OperatorTicketsDeps {
  const sources: RunStatusSources = {
    selections: { async findByRunId(runId: ObjectId) { return [...selections.values()].find((s) => s.runId.equals(runId)) ?? null; } },
    reviews: { async findLatestByRunId() { return null; } },
    executions: { async findByReviewId() { return null; } },
    publications: { async findByExecutionId() { return null; } },
    deployments: { async findByPublicationId() { return null; } },
  } as unknown as RunStatusSources;
  return {
    logger: createLogger({ write: () => {} }),
    operatorToken: TOKEN,
    intake: { async list() { return items; } },
    requirements: {
      async findByIntakeItemId() {
        return { status: 'completed', agentVersion: 'openai-gpt-4.1', completedAt: NOW } as RequirementsAnalysisDocument;
      },
    },
    runs: { async findByIntakeItemId(id) { return runs.get(id.toHexString()) ?? null; } },
    sources,
  };
}

describe('GET /operator/tickets', () => {
  it('refuses a missing token and answers 503 without a database', async () => {
    const d = ticketsDeps([], new Map(), new Map());
    assert.equal((await handleGetOperatorTickets(request({ authorization: undefined }), d)).statusCode, 401);
    assert.equal((await handleGetOperatorTickets(request(), { ...d, runs: undefined })).statusCode, 503);
  });

  it('reports intake status before a run exists, and the run stage after', async () => {
    const waiting = item('LOCAL-1', 'pending_approval');
    const approved = item('LOCAL-2', 'approved', { approvedBy: 'operator:abhilasha', approvedAt: NOW });
    const run: RunDocument = {
      _id: new ObjectId(),
      intakeItemId: approved._id!,
      issueKey: 'LOCAL-2',
      status: 'queued',
      trigger: 'approval',
      startedAt: NOW,
      finishedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    } as unknown as RunDocument;
    const selection = {
      runId: run._id!,
      status: 'pending',
      candidateRepositoryIds: ['my-profile'],
      selectedRepositoryId: null,
      selectedRepositoryUrl: null,
      selectedDefaultBranch: null,
      confirmedBy: null,
      confirmedAt: null,
    } as unknown as RepositorySelectionDocument;

    const result = await handleGetOperatorTickets(
      request(),
      ticketsDeps([waiting, approved], new Map([[approved._id!.toHexString(), run]]), new Map([['s', selection]])),
    );
    assert.equal(result.statusCode, 200);
    const [first, second] = result.body['tickets'] as Record<string, any>[];
    assert.equal(first!['intakeStatus'], 'pending_approval');
    assert.equal(first!['run'], null);
    assert.equal(first!['repository'], null);
    assert.equal(second!['approvedBy'], 'operator:abhilasha');
    assert.equal(second!['run']['stage'], 'repository_selection');
    assert.deepEqual(second!['repository']['candidates'], ['my-profile']);
    assert.equal(second!['analysis']['agentVersion'], 'openai-gpt-4.1');
  });
});

describe('GET /operator/tickets with a database role missing later-stage grants', () => {
  function runFor(i: IntakeItemDocument): RunDocument {
    return { _id: new ObjectId(), intakeItemId: i._id!, issueKey: i.issueKey, status: 'queued', createdAt: NOW, updatedAt: NOW } as unknown as RunDocument;
  }

  it('still lists every ticket, and says which permission is missing', async () => {
    const approved = item('LOCAL-2', 'approved');
    const run = runFor(approved);
    const d = ticketsDeps([approved], new Map([[approved._id!.toHexString(), run]]), new Map());
    const denied = Object.assign(new Error('user is not allowed to do action [find] on [aisdlc_test.changeReviews]'), { code: 13, codeName: 'Unauthorized' });
    const sources = { ...d.sources!, reviews: { async findLatestByRunId() { throw denied; } } } as unknown as RunStatusSources;

    const result = await handleGetOperatorTickets(request(), { ...d, sources });
    assert.equal(result.statusCode, 200);
    const [t] = result.body['tickets'] as Record<string, any>[];
    assert.equal(t!['run']['stage'], 'queued');
    assert.deepEqual(result.body['warnings'], ['user is not allowed to do action [find] on [aisdlc_test.changeReviews]']);
  });

  it('recognises Atlas\'s form of the same denial, and nothing else under its code', () => {
    const atlas = (message: string) => Object.assign(new Error(message), { code: 8000, codeName: 'AtlasError' });
    assert.ok(isAuthorizationError(atlas('user is not allowed to do action [find] on [aisdlc_test.changeReviews]')));
    assert.ok(!isAuthorizationError(atlas('some other Atlas failure')));
    assert.ok(isAuthorizationError({ code: 13, codeName: 'Unauthorized', message: 'x' }));
    assert.ok(!isAuthorizationError(new Error('connection reset')));
  });

  it('does not swallow any other database error', async () => {
    const approved = item('LOCAL-2', 'approved');
    const d = ticketsDeps([approved], new Map([[approved._id!.toHexString(), runFor(approved)]]), new Map());
    const sources = { ...d.sources!, reviews: { async findLatestByRunId() { throw new Error('connection reset'); } } } as unknown as RunStatusSources;
    await assert.rejects(handleGetOperatorTickets(request(), { ...d, sources }), /connection reset/);
  });
});

describe('the AISDLC Console page', () => {
  const html = renderConsoleUi({ ticketCreatorUrl: null });

  it('acts only through the pre-existing gate routes and the /operator reads', () => {
    assert.match(html, /'\/intake\/' \+ encodeURIComponent\(t\.issueKey\) \+ '\/' \+ action/);
    assert.match(html, /'\/repository-selections\/' \+ encodeURIComponent\(s\.runId\) \+ '\/confirm'/);
    assert.match(html, /'\/operator\/queue'/);
    assert.match(html, /'\/operator\/tickets'/);
    assert.match(html, /\/repositories\?embedded=1/);
  });

  it('never assigns content through innerHTML', () => {
    assert.doesNotMatch(html, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  it('shares the Repository Management page\'s token storage keys', () => {
    assert.match(html, /'aisdlc_operator_token'/);
    assert.match(html, /'aisdlc_operator_name'/);
  });

  it('has no ticket creator unless the server enables mock mode', () => {
    assert.match(html, /var CONFIG = \{"ticketCreatorUrl":null,"codingAgentEnabled":false\};/);
    assert.match(renderConsoleUi({ ticketCreatorUrl: 'http://127.0.0.1:4601' }), /var CONFIG = \{"ticketCreatorUrl":"http:\/\/127\.0\.0\.1:4601","codingAgentEnabled":false\};/);
  });

  it('offers the Coding Agent only when the server says it is mounted, and calls only its existing route', () => {
    assert.match(renderConsoleUi({ ticketCreatorUrl: null, codingAgentEnabled: true }), /"codingAgentEnabled":true/);
    assert.match(html, /'\/runs\/' \+ encodeURIComponent\(t\.run\.runId\) \+ '\/coding-agent'/);
    assert.match(html, /\{ candidateFilePaths: paths, operator: name \}/);
  });

  it('decides Gate 3 only through the existing change-review route', () => {
    assert.match(html, /'\/change-reviews\/' \+ encodeURIComponent\(rv\.reviewId\) \+ '\/' \+ action/);
    assert.match(html, /id="gate3"/);
  });

  it('cannot be broken out of its <script> by a configured value', () => {
    const page = renderConsoleUi({ ticketCreatorUrl: 'http://127.0.0.1:1/</script><script>alert(1)</script>' });
    assert.equal(page.split('</script>').length, 2, 'only the page\'s own closing tag');
  });

  it('parses as JavaScript', () => {
    const js = /<script>([\s\S]*)<\/script>/.exec(html)![1]!;
    assert.doesNotThrow(() => new Function(js));
  });
});

describe('console routes', () => {
  function res() {
    const out: { status?: number; headers?: Record<string, unknown>; body?: string | undefined } = {};
    return {
      out,
      writeHead(status: number, headers: Record<string, unknown>) { out.status = status; out.headers = headers; },
      end(body?: string) { out.body = body; },
      headersSent: false,
    };
  }
  const deps = { logger: createLogger({ write: () => {} }), health: {} } as unknown as ServerDeps;

  it('serves /console', async () => {
    const r = res();
    await handleRequest({ url: '/console', method: 'GET', headers: {} } as IncomingMessage, r as never, deps);
    assert.equal(r.out.status, 200);
    assert.match(r.out.body ?? '', /<title>AISDLC Console<\/title>/);
  });

  it('redirects the old /operator page to the console\'s Approvals tab', async () => {
    const r = res();
    await handleRequest({ url: '/operator', method: 'GET', headers: {} } as IncomingMessage, r as never, deps);
    assert.equal(r.out.status, 302);
    assert.equal(r.out.headers?.['location'], '/console#approvals');
  });
});
