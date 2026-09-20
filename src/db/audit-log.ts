/**
 * Audit log access — the only supported way to touch `auditLog`.
 *
 * WHY THIS MODULE EXISTS
 *
 * The audit log is append-only, and the DATABASE is what enforces that:
 * `aisdlcAppRole` grants the service `find` and `insert` on this collection
 * and nothing else, so an `updateOne` or `deleteMany` comes back
 * `user is not allowed to do action [update] on [aisdlc.auditLog]`.
 *
 * This module is defence in depth on top of that grant. It removes every
 * *path* by which our own code could attempt such a write:
 *
 *   1. `AuditLog` exposes `append()` and `query()`. There is no update or
 *      delete method to call, so misuse is a compile error.
 *   2. `guardAuditCollection()` wraps the driver's Collection so that every
 *      mutating method throws locally, for code that obtains the handle some
 *      other way.
 *
 * The value is turning a mistake into a compile error or a local throw,
 * rather than a round trip that returns `Unauthorized`. It is not what makes
 * the collection append-only. See docs/atlas-roles.md for the live grants and
 * the residual risks.
 */

import type { Collection, Db, Filter, ObjectId } from 'mongodb';

import type { Logger } from '../logging/logger.ts';
import { COLLECTIONS, type AuditSubjectType } from './collections.ts';

export interface AuditEntryDocument {
  _id?: ObjectId;
  occurredAt: Date;
  /** Who acted: an operator identifier, or a service name for automated steps. */
  actor: string;
  /** What happened, e.g. 'intake.approved'. */
  action: string;
  subjectType: AuditSubjectType;
  subjectId: ObjectId;
  detail?: Record<string, unknown>;
}

export interface AuditEntryInput {
  readonly actor: string;
  readonly action: string;
  readonly subjectType: AuditSubjectType;
  readonly subjectId: ObjectId;
  readonly detail?: Record<string, unknown>;
  /** Defaults to now. Present so a caller can record the true event time. */
  readonly occurredAt?: Date;
}

/**
 * Every Collection method that could rewrite or destroy audit history.
 *
 * `bulkWrite` is included because it can carry deletes. `drop` and `rename`
 * are included for completeness: the role denies them too, but failing here
 * names the reason rather than surfacing an `Unauthorized` from the wire.
 */
export const FORBIDDEN_AUDIT_METHODS = [
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'findOneAndDelete',
  'bulkWrite',
  'drop',
  'rename',
  'dropIndex',
  'dropIndexes',
] as const;

export type ForbiddenAuditMethod = (typeof FORBIDDEN_AUDIT_METHODS)[number];

export class AuditLogMutationError extends Error {
  readonly method: string;

  constructor(method: string) {
    super(
      `auditLog.${method}() is not permitted: the audit log is append-only. ` +
        'Add a new entry describing the correction instead of amending an old one.',
    );
    this.name = 'AuditLogMutationError';
    this.method = method;
  }
}

const FORBIDDEN = new Set<string>(FORBIDDEN_AUDIT_METHODS);

/**
 * Wraps a Collection so mutating calls throw instead of reaching the server.
 *
 * Bypassable by anyone who calls `db.collection('auditLog')` directly — this
 * catches accidents, not a determined caller.
 */
export function guardAuditCollection<T extends AuditEntryDocument>(
  collection: Collection<T>,
): Collection<T> {
  return new Proxy(collection, {
    get(target, property, receiver) {
      if (typeof property === 'string' && FORBIDDEN.has(property)) {
        return () => {
          throw new AuditLogMutationError(property);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      // Methods must keep their original `this`, or the driver breaks.
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Collection<T>;
}

export interface AuditLog {
  /** Appends one entry. Returns its id. The only write operation available. */
  append(entry: AuditEntryInput): Promise<ObjectId>;
  /** Reads entries, newest first. */
  query(filter?: Filter<AuditEntryDocument>, limit?: number): Promise<AuditEntryDocument[]>;
}

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed === '') {
    // Caught here so the failure names the field, rather than surfacing as an
    // opaque DocumentValidationFailure from the server.
    throw new TypeError(`auditLog entry is missing ${field}`);
  }
  return trimmed;
}

export function createAuditLog(db: Db, logger: Logger): AuditLog {
  const collection = guardAuditCollection(
    db.collection<AuditEntryDocument>(COLLECTIONS.auditLog),
  );

  return {
    async append(entry: AuditEntryInput): Promise<ObjectId> {
      const document: AuditEntryDocument = {
        occurredAt: entry.occurredAt ?? new Date(),
        actor: requireNonEmpty(entry.actor, 'actor'),
        action: requireNonEmpty(entry.action, 'action'),
        subjectType: entry.subjectType,
        subjectId: entry.subjectId,
        ...(entry.detail === undefined ? {} : { detail: entry.detail }),
      };

      const result = await collection.insertOne(document);
      logger.debug('audit entry appended', {
        action: document.action,
        subjectType: document.subjectType,
      });
      return result.insertedId;
    },

    async query(filter: Filter<AuditEntryDocument> = {}, limit = 100): Promise<AuditEntryDocument[]> {
      return collection.find(filter).sort({ occurredAt: -1 }).limit(limit).toArray();
    },
  };
}
