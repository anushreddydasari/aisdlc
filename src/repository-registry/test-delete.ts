/**
 * Permanently removes one Repository Registry entry — TEST MODE ONLY, and
 * only an entry that is already `inactive`. Mounted by index.ts under the
 * same condition as intake/test-purge.ts (non-production, Neutara on a
 * loopback mock); a real environment keeps its registry history and only
 * ever deactivates.
 *
 * Why this is safe to offer there:
 *   - Confirmed runs are unaffected: repositorySelections snapshots the
 *     entry's url/branches at confirmation and never re-reads the registry.
 *   - An unconfirmed selection that listed this entry already cannot pick
 *     it (confirm() re-checks the CURRENT active registry, and the entry
 *     had to be inactive to get here).
 *   - Requiring `inactive` first means an active mapping can never be
 *     removed by one mis-click.
 *
 * The removal is recorded in the audit log like every other registry change.
 */

import type { Db, Document, Filter, ObjectId } from 'mongodb';

import type { AuditLog } from '../db/audit-log.ts';
import { COLLECTIONS } from '../db/collections.ts';
import type { Logger } from '../logging/logger.ts';

export type RegistryDeleteResult =
  | { readonly outcome: 'deleted'; readonly repositoryId: string; readonly projectIdentifier: string }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'still_active'; readonly repositoryId: string }
  | { readonly outcome: 'confirm_mismatch'; readonly repositoryId: string }
  | { readonly outcome: 'permission_denied' };

export interface TestRegistryDeleter {
  /** `confirmRepositoryId` must equal the entry's repositoryId — what the operator confirmed on screen. */
  delete(id: ObjectId, confirmRepositoryId: string, actor: string): Promise<RegistryDeleteResult>;
}

function isAuthorizationError(error: unknown): boolean {
  const e = error as { code?: unknown; codeName?: unknown; message?: unknown } | null;
  if (e === null || typeof e !== 'object') return false;
  if (e.code === 13 || e.codeName === 'Unauthorized') return true;
  return e.code === 8000 && typeof e.message === 'string' && /not allowed to do action/.test(e.message);
}

export function createTestRegistryDeleter(db: Db, audit: AuditLog, logger: Logger): TestRegistryDeleter {
  const collection = db.collection(COLLECTIONS.repositoryRegistry);
  return {
    async delete(id, confirmRepositoryId, actor) {
      const entry = await collection.findOne({ _id: id } as Filter<Document>);
      if (entry === null) return { outcome: 'not_found' };
      const repositoryId = String(entry['repositoryId']);
      const projectIdentifier = String(entry['projectIdentifier']);
      if (confirmRepositoryId !== repositoryId) return { outcome: 'confirm_mismatch', repositoryId };
      if (entry['status'] !== 'inactive') return { outcome: 'still_active', repositoryId };

      try {
        // Conditional on still being inactive, so a concurrent reactivation wins.
        const result = await collection.deleteOne({ _id: id, status: 'inactive' } as Filter<Document>);
        if (result.deletedCount === 0) return { outcome: 'still_active', repositoryId };
      } catch (error) {
        if (!isAuthorizationError(error)) throw error;
        logger.warn('test registry delete refused: missing remove permission', { repositoryId });
        return { outcome: 'permission_denied' };
      }

      await audit.append({
        actor,
        action: 'repository-registry.deleted',
        subjectType: 'repositoryRegistryEntry',
        subjectId: id,
        detail: { repositoryId, projectIdentifier, repositoryUrl: entry['repositoryUrl'], testModeOnly: true },
      });
      logger.info('test registry entry deleted', { repositoryId, projectIdentifier, actor });
      return { outcome: 'deleted', repositoryId, projectIdentifier };
    },
  };
}
