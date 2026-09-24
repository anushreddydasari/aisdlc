import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { ObjectId, type Db } from 'mongodb';

import type { AuditEntryInput, AuditLog } from '../db/audit-log.ts';
import { createLogger } from '../logging/logger.ts';
import { BEARER_PREFIX } from '../api/operator-auth.ts';
import { handleDeleteTestTicket } from '../api/ticket-delete.ts';
import { handleRequest, type ServerDeps } from '../api/server.ts';
import { createTestTicketPurger } from './test-purge.ts';

const TOKEN = 'op_test_token_value_not_real'; // pragma: fixture
const logger = createLogger({ write: () => {} });

type Row = Record<string, unknown>;

/** An in-memory stand-in for the handful of Db calls the purger makes. */
function fakeDb(data: Record<string, Row[]>, denied: string[] = []) {
  const calls: string[] = [];
  const matches = (row: Row, filter: Row): boolean =>
    Object.entries(filter).every(([k, v]) => {
      if (k === '$or') return (v as Row[]).some((sub) => matches(row, sub));
      if (v !== null && typeof v === 'object' && '$in' in (v as Row)) {
        return (v as { $in: unknown[] }).$in.some((x) => (x instanceof ObjectId ? row[k] instanceof ObjectId && (row[k] as ObjectId).equals(x) : x === row[k]));
      }
      if (v instanceof ObjectId) return row[k] instanceof ObjectId && (row[k] as ObjectId).equals(v);
      return row[k] === v;
    });
  const db = {
    collection(name: string) {
      const rows = (data[name] ??= []);
      return {
        async findOne(filter: Row) { return rows.find((r) => matches(r, filter)) ?? null; },
        find(filter: Row) { return { async toArray() { return rows.filter((r) => matches(r, filter)); } }; },
        async deleteOne() {
          if (denied.includes(name)) throw Object.assign(new Error(`user is not allowed to do action [remove] on [aisdlc_test.${name}]`), { code: 8000, codeName: 'AtlasError' });
          return { deletedCount: 0 };
        },
        async deleteMany(filter: Row) {
          calls.push(name);
          const before = rows.length;
          data[name] = rows.filter((r) => !matches(r, filter));
          return { deletedCount: before - data[name]!.length };
        },
      };
    },
  };
  return { db: db as unknown as Db, data, calls };
}

function audit(): AuditLog & { entries: AuditEntryInput[] } {
  const entries: AuditEntryInput[] = [];
  return { entries, async append(e) { entries.push(e); return new ObjectId(); }, async query() { return []; } };
}

function seed() {
  const intakeItemId = new ObjectId();
  const runId = new ObjectId();
  const otherId = new ObjectId();
  return {
    intakeItemId,
    data: {
      intakeItems: [
        { _id: intakeItemId, issueKey: 'LOCAL-1', snapshotMeta: { cfKey: 'CF-1' } },
        { _id: otherId, issueKey: 'LOCAL-2', snapshotMeta: null },
      ],
      webhookDeliveries: [{ issueKey: 'CF-1' }, { issueKey: 'LOCAL-2' }],
      requirementsAnalyses: [{ intakeItemId }, { intakeItemId: otherId }],
      runs: [{ _id: runId, intakeItemId, issueKey: 'LOCAL-1' }],
      repositorySelections: [{ _id: new ObjectId(), intakeItemId, runId, issueKey: 'LOCAL-1' }],
      changeReviews: [{ runId }],
      changeExecutions: [],
      githubPublications: [],
      deployments: [],
      repositoryRegistry: [{ repositoryId: 'my-profile' }],
      auditLog: [{ action: 'intake.approved' }],
    } as Record<string, Row[]>,
  };
}

describe('createTestTicketPurger', () => {
  it('removes the ticket and its whole trail, latest stage first, and leaves everything else', async () => {
    const { data } = seed();
    const f = fakeDb(data);
    const a = audit();
    const result = await createTestTicketPurger(f.db, a, logger).purge('LOCAL-1', 'operator:abhilasha');

    assert.equal(result.outcome, 'purged');
    assert.ok(f.calls.indexOf('changeReviews') < f.calls.indexOf('runs'), 'later stages before the run');
    assert.equal(f.calls.at(-1), 'intakeItems', 'the ticket itself goes last');
    assert.deepEqual(f.data['intakeItems']!.map((r) => r['issueKey']), ['LOCAL-2']);
    assert.deepEqual(f.data['webhookDeliveries']!.map((r) => r['issueKey']), ['LOCAL-2'], 'the CF-keyed delivery is found too');
    assert.equal(f.data['requirementsAnalyses']!.length, 1);
    assert.equal(f.data['runs']!.length, 0);
    assert.equal(f.data['repositorySelections']!.length, 0);
    assert.equal(f.data['changeReviews']!.length, 0);
    assert.equal(f.data['repositoryRegistry']!.length, 1, 'registry untouched');
    assert.equal(f.data['auditLog']!.length, 1, 'audit log untouched');
  });

  it('records who deleted it in the audit log', async () => {
    const { data, intakeItemId } = seed();
    const a = audit();
    await createTestTicketPurger(fakeDb(data).db, a, logger).purge('LOCAL-1', 'operator:abhilasha');
    assert.equal(a.entries.length, 1);
    assert.equal(a.entries[0]!.action, 'intake.purged');
    assert.equal(a.entries[0]!.actor, 'operator:abhilasha');
    assert.ok(a.entries[0]!.subjectId.equals(intakeItemId));
  });

  it('deletes NOTHING when any collection lacks the remove permission, and names them', async () => {
    const { data } = seed();
    const f = fakeDb(data, ['repositorySelections', 'changeReviews']);
    const a = audit();
    const result = await createTestTicketPurger(f.db, a, logger).purge('LOCAL-1', 'operator:x');
    assert.deepEqual(result, { outcome: 'permission_denied', issueKey: 'LOCAL-1', collections: ['changeReviews', 'repositorySelections'] });
    assert.deepEqual(f.calls, [], 'no deleteMany ran');
    assert.equal(f.data['intakeItems']!.length, 2);
    assert.equal(a.entries.length, 0);
  });

  it('also removes rows orphaned by an earlier partial cleanup (no intake item left)', async () => {
    const runId = new ObjectId();
    const data: Record<string, Row[]> = {
      intakeItems: [],
      runs: [{ _id: runId, intakeItemId: new ObjectId(), issueKey: 'ITEST-1' }],
      repositorySelections: [{ _id: new ObjectId(), runId, intakeItemId: new ObjectId(), issueKey: 'ITEST-1' }, { _id: new ObjectId(), runId: new ObjectId(), issueKey: 'KEEP-1' }],
      changeReviews: [{ runId }],
    };
    const a = audit();
    const result = await createTestTicketPurger(fakeDb(data).db, a, logger).purge('ITEST-1', 'operator:x');
    assert.equal(result.outcome, 'purged');
    assert.equal(data['runs']!.length, 0);
    assert.deepEqual(data['repositorySelections']!.map((r) => r['issueKey']), ['KEEP-1']);
    assert.equal(data['changeReviews']!.length, 0);
    assert.equal(a.entries[0]!.subjectType, 'run');
    assert.equal((a.entries[0]!.detail as Row)['orphaned'], true);
  });

  it('reports a ticket that does not exist', async () => {
    const result = await createTestTicketPurger(fakeDb(seed().data).db, audit(), logger).purge('LOCAL-404', 'operator:x');
    assert.equal(result.outcome, 'not_found');
  });
});

function request(body: unknown, headers: Record<string, string | undefined> = {}): IncomingMessage {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  stream.headers = { authorization: `${BEARER_PREFIX}${TOKEN}`, ...headers } as IncomingMessage['headers'];
  return stream;
}

describe('POST /operator/tickets/:issueKey/delete', () => {
  const purged = { async purge(issueKey: string) { return { outcome: 'purged' as const, issueKey, deleted: { intakeItems: 1 } }; } };
  const deps = (purger: unknown = purged) => ({ logger, operatorToken: TOKEN, purger: purger as never });

  it('refuses a missing token', async () => {
    assert.equal((await handleDeleteTestTicket(request({ operator: 'a', confirm: 'LOCAL-1' }, { authorization: undefined }), deps(), 'LOCAL-1')).statusCode, 401);
  });

  it('requires an operator name and a confirm that repeats the key exactly', async () => {
    assert.equal((await handleDeleteTestTicket(request({ confirm: 'LOCAL-1' }), deps(), 'LOCAL-1')).statusCode, 400);
    assert.equal((await handleDeleteTestTicket(request({ operator: 'a', confirm: 'LOCAL-2' }), deps(), 'LOCAL-1')).statusCode, 400);
    assert.equal((await handleDeleteTestTicket(request({ operator: 'a' }), deps(), 'LOCAL-1')).statusCode, 400);
  });

  it('deletes as operator:<name>', async () => {
    let actor = '';
    const result = await handleDeleteTestTicket(
      request({ operator: 'abhilasha', confirm: 'LOCAL-1' }),
      deps({ async purge(k: string, a: string) { actor = a; return { outcome: 'purged', issueKey: k, deleted: {} }; } }),
      'LOCAL-1',
    );
    assert.equal(result.statusCode, 200);
    assert.equal(actor, 'operator:abhilasha');
  });

  it('answers 403 naming the collections when the role cannot delete', async () => {
    const result = await handleDeleteTestTicket(
      request({ operator: 'a', confirm: 'LOCAL-1' }),
      deps({ async purge(k: string) { return { outcome: 'permission_denied', issueKey: k, collections: ['repositorySelections'] }; } }),
      'LOCAL-1',
    );
    assert.equal(result.statusCode, 403);
    assert.match(String(result.body['detail']), /repositorySelections — nothing was deleted/);
  });

  it('does not exist at all outside test mode', async () => {
    const out: { status?: number } = {};
    const res = { writeHead(s: number) { out.status = s; }, end() {}, headersSent: false };
    const req = request({ operator: 'a', confirm: 'LOCAL-1' });
    Object.assign(req, { url: '/operator/tickets/LOCAL-1/delete', method: 'POST' });
    await handleRequest(req, res as never, { logger, health: {} } as unknown as ServerDeps);
    assert.equal(out.status, 404);
  });
});
