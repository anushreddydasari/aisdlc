import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { ObjectId, type Db } from 'mongodb';

import type { AuditEntryInput, AuditLog } from '../db/audit-log.ts';
import { createLogger } from '../logging/logger.ts';
import { BEARER_PREFIX } from '../api/operator-auth.ts';
import { handleDeleteRegistryEntry } from '../api/registry-delete.ts';
import { REPOSITORY_UI_DELETE_FLAG_OFF, REPOSITORY_UI_HTML } from '../api/repository-ui.ts';
import { handleRequest, type ServerDeps } from '../api/server.ts';
import { createTestRegistryDeleter } from './test-delete.ts';

const TOKEN = 'op_test_token_value_not_real'; // pragma: fixture
const logger = createLogger({ write: () => {} });

type Row = Record<string, unknown>;

function fakeDb(rows: Row[], denied = false) {
  const same = (a: unknown, b: unknown) => (a instanceof ObjectId && b instanceof ObjectId ? a.equals(b) : a === b);
  const match = (r: Row, f: Row) => Object.entries(f).every(([k, v]) => same(r[k], v));
  return {
    rows,
    db: {
      collection() {
        return {
          async findOne(f: Row) { return rows.find((r) => match(r, f)) ?? null; },
          async deleteOne(f: Row) {
            if (denied) throw Object.assign(new Error('user is not allowed to do action [remove] on [aisdlc_test.repositoryRegistry]'), { code: 8000 });
            const i = rows.findIndex((r) => match(r, f));
            if (i < 0) return { deletedCount: 0 };
            rows.splice(i, 1);
            return { deletedCount: 1 };
          },
        };
      },
    } as unknown as Db,
  };
}

function audit(): AuditLog & { entries: AuditEntryInput[] } {
  const entries: AuditEntryInput[] = [];
  return { entries, async append(e) { entries.push(e); return new ObjectId(); }, async query() { return []; } };
}

const entry = (status: 'active' | 'inactive', repositoryId = 'test-repo') => ({
  _id: new ObjectId(),
  repositoryId,
  projectIdentifier: 'LOCAL',
  repositoryUrl: 'https://github.com/your-org/test-repo',
  status,
});

describe('createTestRegistryDeleter', () => {
  it('deletes an inactive entry and records it in the audit log', async () => {
    const e = entry('inactive');
    const f = fakeDb([e]);
    const a = audit();
    const result = await createTestRegistryDeleter(f.db, a, logger).delete(e._id, 'test-repo', 'operator:abhilasha');
    assert.equal(result.outcome, 'deleted');
    assert.equal(f.rows.length, 0);
    assert.equal(a.entries[0]!.action, 'repository-registry.deleted');
    assert.equal(a.entries[0]!.actor, 'operator:abhilasha');
    assert.equal(a.entries[0]!.subjectType, 'repositoryRegistryEntry');
  });

  it('never deletes an active entry — deactivate first', async () => {
    const e = entry('active');
    const f = fakeDb([e]);
    const result = await createTestRegistryDeleter(f.db, audit(), logger).delete(e._id, 'test-repo', 'operator:x');
    assert.equal(result.outcome, 'still_active');
    assert.equal(f.rows.length, 1);
  });

  it('requires the confirm to name the same repository', async () => {
    const e = entry('inactive');
    const f = fakeDb([e]);
    const result = await createTestRegistryDeleter(f.db, audit(), logger).delete(e._id, 'my-profile', 'operator:x');
    assert.equal(result.outcome, 'confirm_mismatch');
    assert.equal(f.rows.length, 1);
  });

  it('reports a missing remove permission, touching nothing and writing no audit entry', async () => {
    const e = entry('inactive');
    const f = fakeDb([e], true);
    const a = audit();
    const result = await createTestRegistryDeleter(f.db, a, logger).delete(e._id, 'test-repo', 'operator:x');
    assert.equal(result.outcome, 'permission_denied');
    assert.equal(f.rows.length, 1);
    assert.equal(a.entries.length, 0);
  });
});

function request(body: unknown): IncomingMessage {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  stream.headers = { authorization: `${BEARER_PREFIX}${TOKEN}` } as IncomingMessage['headers'];
  return stream;
}

describe('POST /repository-registry/:id/delete', () => {
  const id = new ObjectId().toHexString();
  const deps = (outcome: string) => ({
    logger,
    operatorToken: TOKEN,
    deleter: { async delete() { return { outcome, repositoryId: 'test-repo', projectIdentifier: 'LOCAL' } as never; } },
  });

  it('maps each outcome to its status', async () => {
    const cases: [string, number][] = [['deleted', 200], ['not_found', 404], ['still_active', 409], ['confirm_mismatch', 400], ['permission_denied', 403]];
    for (const [outcome, status] of cases) {
      assert.equal((await handleDeleteRegistryEntry(request({ operator: 'a', confirm: 'test-repo' }), deps(outcome), id)).statusCode, status, outcome);
    }
  });

  it('rejects a malformed id and a missing operator', async () => {
    assert.equal((await handleDeleteRegistryEntry(request({ operator: 'a', confirm: 'x' }), deps('deleted'), 'nope')).statusCode, 400);
    assert.equal((await handleDeleteRegistryEntry(request({ confirm: 'x' }), deps('deleted'), id)).statusCode, 400);
  });

  function res() {
    const out: { status?: number; body?: string | undefined } = {};
    return { out, writeHead(s: number) { out.status = s; }, end(b?: string) { out.body = b; }, headersSent: false };
  }

  it('does not exist outside test mode, and the page then shows no Delete', async () => {
    const r = res();
    const req = request({ operator: 'a', confirm: 'x' });
    Object.assign(req, { url: `/repository-registry/${id}/delete`, method: 'POST' });
    await handleRequest(req, r as never, { logger, health: {} } as unknown as ServerDeps);
    assert.equal(r.out.status, 404);

    const page = res();
    await handleRequest({ url: '/repositories', method: 'GET', headers: {} } as IncomingMessage, page as never, { logger, health: {} } as unknown as ServerDeps);
    assert.match(page.out.body ?? '', /var CAN_DELETE = false;/);
  });

  it('turns the page\'s Delete on only when the route is mounted', async () => {
    assert.ok(REPOSITORY_UI_HTML.includes(REPOSITORY_UI_DELETE_FLAG_OFF));
    const page = res();
    await handleRequest({ url: '/repositories', method: 'GET', headers: {} } as IncomingMessage, page as never, {
      logger,
      health: {},
      registryDelete: deps('deleted'),
    } as unknown as ServerDeps);
    assert.match(page.out.body ?? '', /var CAN_DELETE = true;/);
  });
});
