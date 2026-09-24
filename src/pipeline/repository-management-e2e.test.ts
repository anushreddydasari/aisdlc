/**
 * Offline, deterministic verification of the "END-TO-END UI TEST" scenario
 * from the Repository Management admin UI phase:
 *
 *   Open Repository Management -> Add Repository (spaceKey = TESTIN) ->
 *   confirm it appears in the table -> a ticket in TESTIN resolves through
 *   the Repository Registry -> repository selection still requires human
 *   confirmation -> confirm -> the workflow reaches GitHub Access.
 *
 * No real browser, no real GitHub, no real MongoDB — the same "REAL
 * repository/service wiring, not a re-implementation of it" approach
 * `pipeline/end-to-end.test.ts` already established, extended to also
 * exercise the real `createHttpServer`/`handleRequest` HTTP layer (via
 * `fetch` against a listening server, exactly like `server.test.ts` does)
 * so this test proves the admin UI's HTTP calls, not just the underlying
 * handler functions.
 *
 * This file adds NO new registry logic. It only calls the pre-existing
 * `/repository-registry` API and the pre-existing
 * `repository-selection/worker.ts` — proving the admin UI sits on top of
 * the existing Repository Registry without becoming a second source of
 * truth, and that adding it changed none of the existing selection safety
 * rules (human confirmation, ambiguous-candidate handling, deactivated
 * repositories being unselectable).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import { ObjectId, type Db } from 'mongodb';

import { createHttpServer, type ServerDeps } from '../api/server.ts';
import { createAuditLog } from '../db/audit-log.ts';
import { createLogger } from '../logging/logger.ts';
import { createIntakeRepository, type IntakeSnapshot } from '../intake/repository.ts';
import { createRequirementsRepository } from '../requirements/repository.ts';
import { processReceivedIntakeItems } from '../requirements/queue.ts';
import { createRunsRepository } from '../orchestrator/repository.ts';
import { queueApprovedRuns } from '../orchestrator/worker.ts';
import { createRepositoryRegistryRepository } from '../repository-registry/repository.ts';
import { createRepositorySelectionRepository } from '../repository-selection/repository.ts';
import { matchRepositorySelections } from '../repository-selection/worker.ts';
import { createMockGitHubAppClient, type MockRepository } from '../github-app/mock-client.ts';
import { authorizeRepositoryAccess } from '../github-app/access.ts';

const OPERATOR_TOKEN = 'op_test_token_value_not_real'; // pragma: fixture
const NOW = new Date('2026-09-26T12:00:00.000Z');
const SPACE_KEY = 'TESTIN';
const INSTALLATION_ID = 9001;

const SNAPSHOT: IntakeSnapshot = {
  title: 'AISDLC-labeled ticket in TESTIN',
  description: 'Exercises the repository management admin UI end to end.',
  issueType: 'task',
  project: SPACE_KEY,
};

/** One generic in-memory Db, shared across every collection this test touches — same shape as pipeline/end-to-end.test.ts's own fake. */
function createFakeDb(): Db {
  const stores = new Map<string, Record<string, unknown>[]>();
  const uniqueFields: Record<string, string[]> = {
    intakeItems: ['issueKey'],
    runs: ['intakeItemId'],
    repositorySelections: ['runId'],
  };

  function storeFor(name: string): Record<string, unknown>[] {
    let store = stores.get(name);
    if (store === undefined) {
      store = [];
      stores.set(name, store);
    }
    return store;
  }

  function fieldsEqual(a: unknown, b: unknown): boolean {
    if (a instanceof ObjectId && b instanceof ObjectId) return a.equals(b);
    return a === b;
  }

  function matches(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
    return Object.entries(filter).every(([key, value]) => fieldsEqual(doc[key], value));
  }

  function makeCollection(name: string) {
    const store = storeFor(name);
    const uniques = uniqueFields[name] ?? [];

    return {
      async findOne(filter: Record<string, unknown> = {}) {
        const found = store.find((doc) => matches(doc, filter));
        return found ? { ...found } : null;
      },
      async insertOne(doc: Record<string, unknown>) {
        for (const field of uniques) {
          if (store.some((existing) => fieldsEqual(existing[field], doc[field]))) {
            throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
          }
        }
        const _id = (doc['_id'] as ObjectId | undefined) ?? new ObjectId();
        store.push({ ...doc, _id });
        return { insertedId: _id };
      },
      find(filter: Record<string, unknown> = {}) {
        let results = store.filter((doc) => matches(doc, filter)).map((doc) => ({ ...doc }));
        const cursor = {
          sort(spec: Record<string, 1 | -1>) {
            const [field, direction] = Object.entries(spec)[0] as [string, 1 | -1];
            results = [...results].sort((a, b) => {
              const av = a[field] instanceof Date ? (a[field] as Date).getTime() : (a[field] as number);
              const bv = b[field] instanceof Date ? (b[field] as Date).getTime() : (b[field] as number);
              return direction === 1 ? av - bv : bv - av;
            });
            return cursor;
          },
          limit(n: number) {
            results = results.slice(0, n);
            return cursor;
          },
          async toArray() {
            return results;
          },
        };
        return cursor;
      },
      async findOneAndUpdate(filter: Record<string, unknown>, update: { $set?: Record<string, unknown> }) {
        const idx = store.findIndex((doc) => matches(doc, filter));
        if (idx === -1) return null;
        const merged = { ...store[idx], ...(update.$set ?? {}) };
        store[idx] = merged;
        return { ...merged };
      },
    };
  }

  return { collection: (name: string) => makeCollection(name) } as unknown as Db;
}

const logger = createLogger({ write: () => {} });

interface Harness {
  readonly url: string;
  readonly db: Db;
  readonly registry: ReturnType<typeof createRepositoryRegistryRepository>;
  readonly intake: ReturnType<typeof createIntakeRepository>;
  readonly runs: ReturnType<typeof createRunsRepository>;
  readonly selections: ReturnType<typeof createRepositorySelectionRepository>;
  readonly stop: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const db = createFakeDb();
  const audit = createAuditLog(db, logger);
  const registry = createRepositoryRegistryRepository(db, audit, logger);
  const intake = createIntakeRepository(db, audit, logger);
  const runs = createRunsRepository(db, logger);
  const selections = createRepositorySelectionRepository(db, audit, logger);

  const deps: ServerDeps = {
    logger,
    health: { version: 'test', uptimeSeconds: () => 1, database: undefined },
    repositoryRegistry: { logger, operatorToken: OPERATOR_TOKEN, registry },
  };
  const server = createHttpServer(deps);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    db,
    registry,
    intake,
    runs,
    selections,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** The exact call the admin page's "Save Repository" button makes for Add Repository. */
async function addRepositoryViaHttp(
  url: string,
  overrides: { projectIdentifier?: string; repositoryId?: string; repositoryUrl?: string } = {},
): Promise<Record<string, unknown>> {
  const res = await fetch(`${url}/repository-registry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${OPERATOR_TOKEN}` },
    body: JSON.stringify({
      projectIdentifier: overrides.projectIdentifier ?? SPACE_KEY,
      repositoryId: overrides.repositoryId ?? 'test-app',
      repositoryUrl: overrides.repositoryUrl ?? 'https://github.com/company/test-app',
      defaultBranch: 'main',
      allowedBranches: ['main'],
      accessPolicy: { installationId: INSTALLATION_ID },
      operator: 'alice',
    }),
  });
  assert.equal(res.status, 201, 'Add Repository must succeed through the live HTTP server');
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Takes a fresh ticket from `received` through the EXISTING requirements
 * queue, human-approval transition, and orchestrator queueing worker — the
 * same three steps `pipeline/end-to-end.test.ts` already exercises in full
 * — so that a queued `runs` row exists for `matchRepositorySelections` to
 * pick up. Not this phase's concern to re-verify (it is unchanged and
 * untouched), only a prerequisite to reach the registry/selection boundary
 * this phase actually adds a UI for.
 */
async function approveAndQueue(h: Harness, issueKey: string): Promise<ObjectId> {
  const audit = createAuditLog(h.db, logger);
  const requirements = createRequirementsRepository(h.db, logger);
  const { item } = await h.intake.create({ issueKey, source: 'webhook', snapshot: SNAPSHOT });
  await processReceivedIntakeItems({ intake: h.intake, repository: requirements, audit, logger, now: () => NOW });
  await h.intake.transition(issueKey, 'approved', { actor: 'operator:alice', approvedBy: 'operator:alice' });
  await queueApprovedRuns({ intake: h.intake, runs: h.runs, audit, logger });
  return item._id!;
}

describe('END-TO-END UI TEST: admin registers a repository, AISDLC finds and uses it', () => {
  it('1-7: registering a repository through the live HTTP API makes it appear in the table (GET /repository-registry)', async () => {
    const h = await startHarness();
    try {
      const uiPage = await fetch(`${h.url}/repositories`);
      assert.equal(uiPage.status, 200, 'Repository Management page must be reachable');

      await addRepositoryViaHttp(h.url);

      const listRes = await fetch(`${h.url}/repository-registry`, {
        headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      });
      assert.equal(listRes.status, 200);
      const body = (await listRes.json()) as { entries: Record<string, unknown>[] };
      assert.equal(body.entries.length, 1);
      assert.equal(body.entries[0]!['projectIdentifier'], SPACE_KEY);
      assert.equal(body.entries[0]!['repositoryUrl'], 'https://github.com/company/test-app');
      assert.equal(body.entries[0]!['status'], 'active');
    } finally {
      await h.stop();
    }
  });

  it('8-12: a TESTIN ticket resolves through the Registry, still requires human confirmation, then reaches GitHub Access', async () => {
    const h = await startHarness();
    try {
      // 2-6: Add Repository, exactly as the admin page's form would.
      const created = await addRepositoryViaHttp(h.url);
      assert.equal(created['status'], 'active');

      // 8: a test AISDLC ticket in TESTIN, carried through the EXISTING
      // requirements queue + human approval + orchestrator queueing —
      // pipeline/end-to-end.test.ts already exhaustively covers that chain
      // in isolation; here it is just the prerequisite to reach the
      // registry/selection boundary this phase actually adds a UI for.
      const intakeItemId = await approveAndQueue(h, 'TESTIN-1');
      const run = await h.runs.findByIntakeItemId(intakeItemId);
      assert.ok(run !== null);

      // 9: AISDLC finds the registered repository through the EXISTING
      // Repository Registry (unchanged worker, unchanged registry instance
      // the HTTP API above just wrote into).
      const matchSummary = await matchRepositorySelections({
        intake: h.intake,
        runs: h.runs,
        registry: h.registry,
        selections: h.selections,
        audit: createAuditLog(h.db, logger),
        logger,
        now: () => NOW,
      });
      assert.equal(matchSummary.pending, 1);

      // 10: repository selection still requires human confirmation — a
      // single active candidate is 'pending', never auto-advanced to
      // 'selected'. No ticket or admin-page action can skip this.
      const selectionBeforeConfirm = await h.selections.findByRunId(run!._id!);
      assert.ok(selectionBeforeConfirm !== null);
      assert.equal(selectionBeforeConfirm!.status, 'pending');
      assert.deepEqual(selectionBeforeConfirm!.candidateRepositoryIds, ['test-app']);

      // An arbitrary GitHub URL supplied outside the registry can never be
      // used instead — the only candidate ever considered comes from
      // `registry.findActiveByProjectIdentifier`, never from ticket input.
      assert.equal(selectionBeforeConfirm!.selectedRepositoryUrl, null);

      // 11: confirm — the exact call POST /repository-selections/:runId/confirm makes.
      const confirmed = await h.selections.confirm(run!._id!, {
        repositoryId: created['repositoryId'] as string,
        repositoryUrl: created['repositoryUrl'] as string,
        defaultBranch: created['defaultBranch'] as string,
        allowedBranches: created['allowedBranches'] as string[],
        accessPolicy: created['accessPolicy'] as Record<string, unknown>,
        confirmedBy: 'operator:alice',
      });
      assert.equal(confirmed.status, 'selected');

      // 12: the workflow now reaches the existing GitHub Access stage —
      // unchanged, reused exactly as github-access/service.ts already calls it.
      const client = createMockGitHubAppClient({
        repositories: [
          { owner: 'company', repo: 'test-app', installationId: INSTALLATION_ID, defaultBranch: 'main', branches: ['main'] } satisfies MockRepository,
        ],
      });
      const access = await authorizeRepositoryAccess({ registry: h.registry, client, logger }, confirmed);
      assert.ok(access.ok, 'GitHub Access must succeed for the confirmed, registered repository');
      if (access.ok) {
        assert.equal(access.owner, 'company');
        assert.equal(access.repo, 'test-app');
        assert.equal(access.installationId, INSTALLATION_ID);
      }
    } finally {
      await h.stop();
    }
  });

  it('13: a deactivated repository is no longer selectable for a new run', async () => {
    const h = await startHarness();
    try {
      const created = await addRepositoryViaHttp(h.url);
      const id = created['id'] as string;

      const deactivateRes = await fetch(`${h.url}/repository-registry/${id}/deactivate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${OPERATOR_TOKEN}` },
        body: JSON.stringify({ operator: 'alice' }),
      });
      assert.equal(deactivateRes.status, 200);
      assert.equal((await deactivateRes.json() as Record<string, unknown>)['status'], 'inactive');

      const intakeItemId = await approveAndQueue(h, 'TESTIN-2');
      const run = await h.runs.findByIntakeItemId(intakeItemId);

      const matchSummary = await matchRepositorySelections({
        intake: h.intake,
        runs: h.runs,
        registry: h.registry,
        selections: h.selections,
        audit: createAuditLog(h.db, logger),
        logger,
        now: () => NOW,
      });
      assert.equal(matchSummary.failed, 1, 'a deactivated repository must not be an eligible candidate');

      const selection = await h.selections.findByRunId(run!._id!);
      assert.equal(selection!.status, 'failed');
      assert.deepEqual(selection!.candidateRepositoryIds, []);
    } finally {
      await h.stop();
    }
  });

  it('12 (multi-candidate variant): two active repositories for the same space are "ambiguous", never silently auto-selected', async () => {
    const h = await startHarness();
    try {
      await addRepositoryViaHttp(h.url, { repositoryId: 'test-app-one', repositoryUrl: 'https://github.com/company/test-app-one' });
      await addRepositoryViaHttp(h.url, { repositoryId: 'test-app-two', repositoryUrl: 'https://github.com/company/test-app-two' });

      const intakeItemId = await approveAndQueue(h, 'TESTIN-3');
      const run = await h.runs.findByIntakeItemId(intakeItemId);

      const matchSummary = await matchRepositorySelections({
        intake: h.intake,
        runs: h.runs,
        registry: h.registry,
        selections: h.selections,
        audit: createAuditLog(h.db, logger),
        logger,
        now: () => NOW,
      });
      assert.equal(matchSummary.ambiguous, 1);

      const selection = await h.selections.findByRunId(run!._id!);
      assert.equal(selection!.status, 'ambiguous');
      assert.equal(selection!.candidateRepositoryIds.length, 2);

      // Still requires the exact same human confirmation call as the
      // single-candidate case — the admin page changes nothing here, it
      // only lets an operator SEE the ambiguity to resolve it.
      const confirmed = await h.selections.confirm(run!._id!, {
        repositoryId: 'test-app-two',
        repositoryUrl: 'https://github.com/company/test-app-two',
        defaultBranch: 'main',
        allowedBranches: ['main'],
        accessPolicy: null,
        confirmedBy: 'operator:alice',
      });
      assert.equal(confirmed.status, 'selected');
      assert.equal(confirmed.selectedRepositoryId, 'test-app-two');
    } finally {
      await h.stop();
    }
  });
});
