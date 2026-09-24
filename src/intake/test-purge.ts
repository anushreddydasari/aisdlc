/**
 * Deletes one ticket and everything the pipeline built for it — TEST MODE
 * ONLY. Mounted by index.ts under exactly the condition the console's
 * Create-test-ticket tab uses (non-production, Neutara pointed at a
 * loopback mock), and never otherwise: in a real environment a ticket's
 * trail is the record of what was approved and shipped, and nothing here
 * should be able to erase it.
 *
 * Deliberately NOT removed:
 *   - repositoryRegistry — configuration, not ticket data.
 *   - auditLog — append-only by design (the application role cannot delete
 *     from it at all). A purge ADDS an `intake.purged` entry naming who
 *     deleted what, so the history stays honest.
 *
 * All-or-nothing on permissions: every collection is probed for `remove`
 * before anything is deleted, so a role missing a grant fails cleanly
 * with nothing touched, instead of leaving a half-deleted ticket (e.g. a
 * run with no selection, which the repository-selection worker would then
 * try to re-match). Deletion runs latest stage first, ticket last, for the
 * same reason: an interrupted purge leaves a shorter pipeline, never an
 * orphaned later stage.
 */

import type { Db, Document, Filter } from 'mongodb';

import type { AuditLog } from '../db/audit-log.ts';
import { COLLECTIONS } from '../db/collections.ts';
import type { Logger } from '../logging/logger.ts';

export type PurgeResult =
  | { readonly outcome: 'purged'; readonly issueKey: string; readonly deleted: Readonly<Record<string, number>> }
  | { readonly outcome: 'not_found'; readonly issueKey: string }
  | { readonly outcome: 'permission_denied'; readonly issueKey: string; readonly collections: readonly string[] };

export interface TestTicketPurger {
  purge(issueKey: string, actor: string): Promise<PurgeResult>;
}

/** Same classification as api/operator-tickets.ts: MongoDB code 13, or Atlas's 8000 "not allowed to do action". */
function isAuthorizationError(error: unknown): boolean {
  const e = error as { code?: unknown; codeName?: unknown; message?: unknown } | null;
  if (e === null || typeof e !== 'object') return false;
  if (e.code === 13 || e.codeName === 'Unauthorized') return true;
  return e.code === 8000 && typeof e.message === 'string' && /not allowed to do action/.test(e.message);
}

/** A delete whose filter can match nothing still requires the `remove` privilege — a side-effect-free permission check. */
const PROBE_FILTER = { _id: '__aisdlc_permission_probe__' } as unknown as Filter<Document>;

export function createTestTicketPurger(db: Db, audit: AuditLog, logger: Logger): TestTicketPurger {
  return {
    async purge(issueKey, actor) {
      // Matched by issue key as well as by id, so rows orphaned by an earlier,
      // partial cleanup (a run or selection whose intake item is already
      // gone) are found and removed too.
      const item = await db.collection(COLLECTIONS.intakeItems).findOne({ issueKey });
      const intakeItemId = item?.['_id'];
      const byTicket: Filter<Document> = intakeItemId === undefined ? { issueKey } : { $or: [{ intakeItemId }, { issueKey }] };
      const runs = await db.collection(COLLECTIONS.runs).find(byTicket, { projection: { _id: 1 } }).toArray();
      const selections = await db.collection(COLLECTIONS.repositorySelections).find(byTicket, { projection: { _id: 1, runId: 1 } }).toArray();
      if (item === null && runs.length === 0 && selections.length === 0) return { outcome: 'not_found', issueKey };

      const runIds = [...runs.map((r) => r['_id']), ...selections.map((s) => s['runId']).filter((id) => id !== undefined)];
      const byRun: Filter<Document> | null = runIds.length === 0 ? null : { runId: { $in: runIds } };
      const cfKey = (item?.['snapshotMeta'] as { cfKey?: unknown } | null | undefined)?.cfKey;
      const deliveryKeys = typeof cfKey === 'string' && cfKey !== '' ? [issueKey, cfKey] : [issueKey];

      // Latest stage first, the ticket itself last.
      const plan: [string, Filter<Document> | null][] = [
        [COLLECTIONS.deployments, byRun],
        [COLLECTIONS.githubPublications, byRun],
        [COLLECTIONS.changeExecutions, byRun],
        [COLLECTIONS.changeReviews, byRun],
        [COLLECTIONS.repositorySelections, byTicket],
        [COLLECTIONS.runs, byTicket],
        [COLLECTIONS.requirementsAnalyses, intakeItemId === undefined ? { issueKey } : byTicket],
        [COLLECTIONS.webhookDeliveries, { issueKey: { $in: deliveryKeys } }],
        [COLLECTIONS.intakeItems, intakeItemId === undefined ? null : { _id: intakeItemId }],
      ];

      const denied: string[] = [];
      for (const [name] of plan) {
        try {
          await db.collection(name).deleteOne(PROBE_FILTER);
        } catch (error) {
          if (!isAuthorizationError(error)) throw error;
          denied.push(name);
        }
      }
      if (denied.length > 0) {
        logger.warn('test ticket purge refused: missing remove permission', { issueKey, collections: denied });
        return { outcome: 'permission_denied', issueKey, collections: denied };
      }

      const deleted: Record<string, number> = {};
      for (const [name, filter] of plan) {
        if (filter === null) {
          deleted[name] = 0;
          continue;
        }
        deleted[name] = (await db.collection(name).deleteMany(filter)).deletedCount;
      }

      // Subject: the ticket when it still existed, else the orphan's run or selection.
      const subject =
        intakeItemId !== undefined
          ? { subjectType: 'intakeItem' as const, subjectId: intakeItemId }
          : runs[0] !== undefined
            ? { subjectType: 'run' as const, subjectId: runs[0]['_id'] }
            : { subjectType: 'repositorySelection' as const, subjectId: selections[0]!['_id'] };
      await audit.append({
        actor,
        action: 'intake.purged',
        ...subject,
        detail: { issueKey, deleted, orphaned: item === null, testModeOnly: true },
      });
      logger.info('test ticket purged', { issueKey, actor, deleted });
      return { outcome: 'purged', issueKey, deleted };
    },
  };
}
