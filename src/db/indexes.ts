/**
 * Collection and index initialization.
 *
 * Run once per deploy by src/scripts/init-indexes.ts using the MIGRATION user.
 * The service itself never calls this.
 *
 * Idempotent, and idempotent across CHANGES to the specs — see
 * `ensureIndex` below. Every index carries an explicit name, so a second run
 * with unchanged specs is a no-op.
 */

import { isDeepStrictEqual } from 'node:util';
import type { Db, Document } from 'mongodb';

import type { Logger } from '../logging/logger.ts';
import {
  COLLECTION_NAMES,
  COLLECTION_OPTIONS,
  INDEXES,
  type CollectionName,
  type IndexDefinition,
} from './collections.ts';

export interface InitializationResult {
  readonly collectionsCreated: readonly CollectionName[];
  readonly collectionsExisting: readonly CollectionName[];
  readonly indexesEnsured: number;
  /** Indexes whose TTL was adjusted in place via collMod. */
  readonly indexesTtlUpdated: number;
  /** Indexes dropped and rebuilt because their definition changed. */
  readonly indexesRecreated: number;
}

/** What the server returns from listIndexes, for the fields we compare. */
interface ExistingIndex {
  readonly name: string;
  readonly key: Document;
  readonly unique?: boolean;
  readonly expireAfterSeconds?: number;
}

/**
 * MongoDB rejects a createIndex that reuses a name with different options.
 * 85 = IndexOptionsConflict, 86 = IndexKeySpecsConflict.
 */
export function isIndexConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, codeName } = error as { code?: unknown; codeName?: unknown };
  return (
    code === 85 ||
    code === 86 ||
    codeName === 'IndexOptionsConflict' ||
    codeName === 'IndexKeySpecsConflict'
  );
}

/**
 * True when the only thing that changed is the TTL.
 *
 * Worth detecting separately because MongoDB can adjust `expireAfterSeconds`
 * in place with collMod. Dropping and rebuilding would be needless work, and
 * on a unique index a rebuild leaves the constraint briefly unenforced.
 */
export function isTtlOnlyChange(existing: ExistingIndex, desired: IndexDefinition): boolean {
  if (!isDeepStrictEqual(existing.key, desired.key as Document)) return false;

  const desiredTtl = desired.options?.expireAfterSeconds;
  if (desiredTtl === undefined) return false;
  if (Boolean(existing.unique) !== Boolean(desired.options?.unique)) return false;

  return existing.expireAfterSeconds !== desiredTtl;
}

async function ensureCollection(
  db: Db,
  name: CollectionName,
  existing: ReadonlySet<string>,
  logger: Logger,
): Promise<boolean> {
  const options = COLLECTION_OPTIONS[name];

  if (existing.has(name)) {
    // Re-apply options so a validator change in source reaches a live cluster.
    if (options) {
      await db.command({ collMod: name, ...options });
      logger.info('collection options reapplied', { collection: name });
    }
    return false;
  }

  await db.createCollection(name, options ?? {});
  logger.info('collection created', { collection: name, withValidator: Boolean(options) });
  return true;
}

export type EnsureIndexOutcome = 'ensured' | 'ttl_updated' | 'recreated';

/**
 * Creates an index, reconciling it if one already exists under that name with
 * a different definition.
 *
 * Without this, `db:init` is idempotent only while the specs never change:
 * the first edit to an index — a new TTL, an added field — makes every
 * subsequent run fail with IndexOptionsConflict.
 */
export async function ensureIndex(
  db: Db,
  collection: CollectionName,
  index: IndexDefinition,
  logger: Logger,
): Promise<EnsureIndexOutcome> {
  const handle = db.collection(collection);
  const spec = { name: index.name, ...index.options };

  try {
    await handle.createIndex(index.key, spec);
    logger.debug('index ensured', { collection, index: index.name });
    return 'ensured';
  } catch (error) {
    if (!isIndexConflict(error)) throw error;

    const existing = ((await handle.listIndexes().toArray()) as ExistingIndex[]).find(
      (candidate) => candidate.name === index.name,
    );

    if (existing && isTtlOnlyChange(existing, index)) {
      await db.command({
        collMod: collection,
        index: { name: index.name, expireAfterSeconds: index.options?.expireAfterSeconds },
      });
      logger.info('index ttl updated in place', {
        collection,
        index: index.name,
        from: existing.expireAfterSeconds,
        to: index.options?.expireAfterSeconds,
      });
      return 'ttl_updated';
    }

    // Anything else needs a rebuild. Logged at warn because a unique index is
    // briefly unenforced between the drop and the rebuild.
    logger.warn('index definition changed; dropping and recreating', {
      collection,
      index: index.name,
      unique: Boolean(index.options?.unique),
    });
    await handle.dropIndex(index.name);
    await handle.createIndex(index.key, spec);
    return 'recreated';
  }
}

export async function initializeDatabase(db: Db, logger: Logger): Promise<InitializationResult> {
  const existing = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name),
  );

  const created: CollectionName[] = [];
  const present: CollectionName[] = [];
  let indexesEnsured = 0;
  let indexesTtlUpdated = 0;
  let indexesRecreated = 0;

  for (const name of COLLECTION_NAMES) {
    const wasCreated = await ensureCollection(db, name, existing, logger);
    (wasCreated ? created : present).push(name);

    for (const index of INDEXES[name] ?? []) {
      const outcome = await ensureIndex(db, name, index, logger);
      indexesEnsured += 1;
      if (outcome === 'ttl_updated') indexesTtlUpdated += 1;
      if (outcome === 'recreated') indexesRecreated += 1;
    }
  }

  logger.info('database initialization complete', {
    collectionsCreated: created.length,
    collectionsExisting: present.length,
    indexesEnsured,
    indexesTtlUpdated,
    indexesRecreated,
  });

  return {
    collectionsCreated: created,
    collectionsExisting: present,
    indexesEnsured,
    indexesTtlUpdated,
    indexesRecreated,
  };
}
