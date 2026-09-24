/**
 * Repository selection — the domain layer for `repositorySelections`.
 *
 * One row per run (unique on `runId`), recording which repository — if
 * any — was matched from `repositoryRegistry` for that run's project, and
 * whether a human has confirmed it. Decision D2 (human confirmation is
 * always required, even for a single match) means `status` only ever
 * reaches `selected` through `confirm()`; the matching pass in
 * repository-selection/worker.ts never sets it directly.
 *
 * Split of responsibility with the worker: this module only persists state
 * and enforces the state machine's write-time invariants (no overwriting an
 * already-`selected` row, no confirming a repositoryId that is not among
 * the row's own candidates). It does not decide WHEN to retry or WHEN to
 * notify — that policy lives in worker.ts, which is what makes the retry
 * backoff and the notification-dedupe rule (`lastNotifiedStatus`) visible
 * and testable in one place instead of split across layers.
 *
 * `confirm()` is the one human-facing state transition, so — mirroring
 * intake/repository.ts's `transition()` — it writes its own audit entry
 * here rather than leaving that to the API layer. The system-driven
 * transitions (`createInitial`, `recordMatchResult`) do not: those are
 * worker-driven, like orchestrator/worker.ts's run-queueing, and their
 * audit/notification entries are the worker's call to make.
 */

import type { Collection, Db, Filter, ObjectId } from 'mongodb';

import type { AuditLog } from '../db/audit-log.ts';
import type { Logger } from '../logging/logger.ts';
import { COLLECTIONS, type RepositorySelectionStatus } from '../db/collections.ts';

export interface RepositorySelectionDocument {
  _id?: ObjectId;
  runId: ObjectId;
  intakeItemId: ObjectId;
  issueKey: string;
  projectIdentifier: string;
  candidateRepositoryIds: string[];
  selectedRepositoryId: string | null;
  selectedRepositoryUrl: string | null;
  selectedDefaultBranch: string | null;
  selectedAllowedBranches: string[] | null;
  selectedAccessPolicy: Record<string, unknown> | null;
  status: RepositorySelectionStatus;
  failureReason: string | null;
  attempts: number;
  nextAttemptAt: Date;
  confirmedBy: string | null;
  confirmedAt: Date | null;
  lastNotifiedStatus: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The only statuses a match attempt (not a human) may ever produce. */
export type MatchOutcomeStatus = Extract<RepositorySelectionStatus, 'pending' | 'failed' | 'ambiguous'>;

export interface CreateInitialSelectionInput {
  readonly runId: ObjectId;
  readonly intakeItemId: ObjectId;
  readonly issueKey: string;
  readonly projectIdentifier: string;
  readonly candidateRepositoryIds: readonly string[];
  readonly status: MatchOutcomeStatus;
  readonly failureReason?: string | null;
  readonly nextAttemptAt: Date;
  readonly lastNotifiedStatus?: string | null;
}

export interface CreateInitialSelectionResult {
  /** False when a selection for this runId already existed (raced or retried). */
  readonly created: boolean;
  readonly selection: RepositorySelectionDocument;
}

export interface RecordMatchResultInput {
  readonly candidateRepositoryIds: readonly string[];
  readonly status: MatchOutcomeStatus;
  readonly failureReason?: string | null;
  readonly nextAttemptAt: Date;
  readonly lastNotifiedStatus?: string | null;
}

export interface ConfirmSelectionInput {
  readonly repositoryId: string;
  readonly repositoryUrl: string;
  readonly defaultBranch: string;
  readonly allowedBranches: readonly string[];
  readonly accessPolicy: Record<string, unknown> | null;
  readonly confirmedBy: string;
  readonly now?: Date;
}

export class SelectionNotFoundError extends Error {
  constructor(runId: ObjectId) {
    super(`no repository selection for runId '${runId.toHexString()}'`);
    this.name = 'SelectionNotFoundError';
  }
}

/** The row exists but is not in a state this operation may act on (e.g. already selected). */
export class SelectionConflictError extends Error {
  constructor(runId: ObjectId, detail: string) {
    super(`repository selection for runId '${runId.toHexString()}' ${detail}`);
    this.name = 'SelectionConflictError';
  }
}

export class SelectionValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'SelectionValidationError';
    this.field = field;
  }
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;
}

export interface RepositorySelectionRepository {
  findByRunId(runId: ObjectId): Promise<RepositorySelectionDocument | null>;
  /** Idempotent on runId: a repeated pass over the same queued run returns the existing row. */
  createInitial(input: CreateInitialSelectionInput): Promise<CreateInitialSelectionResult>;
  /**
   * Applies a re-match result to a `failed` or `ambiguous` row. A no-op
   * (returns null) if the row has moved on — confirmed, or already resolved
   * by a concurrent pass — since a stale retry must never clobber that.
   */
  recordMatchResult(runId: ObjectId, input: RecordMatchResultInput): Promise<RepositorySelectionDocument | null>;
  /**
   * The human-confirmation transition. Only valid from `pending` or
   * `ambiguous`, and only for a repositoryId that is among the row's own
   * `candidateRepositoryIds` at the moment of confirmation.
   */
  confirm(runId: ObjectId, input: ConfirmSelectionInput): Promise<RepositorySelectionDocument>;
  /** Unresolved rows due for another match attempt. Uses status_nextAttemptAt. */
  findDueForRetry(now: Date, limit: number): Promise<RepositorySelectionDocument[]>;
}

export function createRepositorySelectionRepository(
  db: Db,
  audit: AuditLog,
  logger: Logger,
): RepositorySelectionRepository {
  const collection: Collection<RepositorySelectionDocument> = db.collection(COLLECTIONS.repositorySelections);

  return {
    async findByRunId(runId: ObjectId): Promise<RepositorySelectionDocument | null> {
      return collection.findOne({ runId });
    },

    async createInitial(input: CreateInitialSelectionInput): Promise<CreateInitialSelectionResult> {
      const now = new Date();
      const document: RepositorySelectionDocument = {
        runId: input.runId,
        intakeItemId: input.intakeItemId,
        issueKey: input.issueKey,
        projectIdentifier: input.projectIdentifier,
        candidateRepositoryIds: [...input.candidateRepositoryIds],
        selectedRepositoryId: null,
        selectedRepositoryUrl: null,
        selectedDefaultBranch: null,
        selectedAllowedBranches: null,
        selectedAccessPolicy: null,
        status: input.status,
        failureReason: input.failureReason ?? null,
        attempts: 0,
        nextAttemptAt: input.nextAttemptAt,
        confirmedBy: null,
        confirmedAt: null,
        lastNotifiedStatus: input.lastNotifiedStatus ?? null,
        createdAt: now,
        updatedAt: now,
      };

      try {
        const insertedId = (await collection.insertOne(document)).insertedId;
        logger.info('repository selection created', { issueKey: input.issueKey, status: input.status });
        return { created: true, selection: { ...document, _id: insertedId } };
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        const winner = await collection.findOne({ runId: input.runId });
        if (winner === null) throw error;
        logger.info('lost insert race on runId; returning existing selection', { issueKey: input.issueKey });
        return { created: false, selection: winner };
      }
    },

    async recordMatchResult(
      runId: ObjectId,
      input: RecordMatchResultInput,
    ): Promise<RepositorySelectionDocument | null> {
      const now = new Date();
      const updated = await collection.findOneAndUpdate(
        { runId, status: { $in: ['failed', 'ambiguous'] } },
        {
          $set: {
            candidateRepositoryIds: [...input.candidateRepositoryIds],
            status: input.status,
            failureReason: input.failureReason ?? null,
            nextAttemptAt: input.nextAttemptAt,
            ...(input.lastNotifiedStatus === undefined ? {} : { lastNotifiedStatus: input.lastNotifiedStatus }),
            updatedAt: now,
          },
          $inc: { attempts: 1 },
        },
        { returnDocument: 'after' },
      );
      if (updated === null) {
        logger.info('retry skipped: selection is no longer failed/ambiguous', { runId: runId.toHexString() });
      }
      return updated;
    },

    async confirm(runId: ObjectId, input: ConfirmSelectionInput): Promise<RepositorySelectionDocument> {
      const existing = await collection.findOne({ runId });
      if (existing === null) throw new SelectionNotFoundError(runId);

      if (existing.status !== 'pending' && existing.status !== 'ambiguous') {
        throw new SelectionConflictError(runId, `is '${existing.status}', not pending or ambiguous`);
      }
      if (!existing.candidateRepositoryIds.includes(input.repositoryId)) {
        throw new SelectionValidationError(
          'repositoryId',
          `'${input.repositoryId}' is not among this run's candidate repositories`,
        );
      }

      const now = input.now ?? new Date();
      const updated = await collection.findOneAndUpdate(
        { runId, status: existing.status },
        {
          $set: {
            selectedRepositoryId: input.repositoryId,
            selectedRepositoryUrl: input.repositoryUrl,
            selectedDefaultBranch: input.defaultBranch,
            selectedAllowedBranches: [...input.allowedBranches],
            selectedAccessPolicy: input.accessPolicy,
            status: 'selected',
            confirmedBy: input.confirmedBy,
            confirmedAt: now,
            updatedAt: now,
          },
        },
        { returnDocument: 'after' },
      );
      if (updated === null) {
        // Lost a race against a concurrent confirmation or retry between the
        // read above and this write.
        throw new SelectionConflictError(runId, 'changed while the confirmation was in flight; retry');
      }

      await audit.append({
        actor: input.confirmedBy,
        action: 'repository-selection.confirmed',
        subjectType: 'repositorySelection',
        subjectId: updated._id!,
        detail: { issueKey: updated.issueKey, repositoryId: input.repositoryId },
      });

      logger.info('repository selection confirmed', {
        issueKey: updated.issueKey,
        repositoryId: input.repositoryId,
      });
      return updated;
    },

    async findDueForRetry(now: Date, limit: number): Promise<RepositorySelectionDocument[]> {
      return collection
        .find({ status: { $in: ['failed', 'ambiguous'] }, nextAttemptAt: { $lte: now } } as Filter<RepositorySelectionDocument>)
        .sort({ nextAttemptAt: 1 })
        .limit(limit)
        .toArray();
    },
  };
}

/**
 * Read-only listings for the Operator Console (api/operator-queue.ts).
 * Deliberately NOT on RepositorySelectionRepository: nothing in the
 * pipeline needs "list everything awaiting a human", and keeping it off the
 * shared interface means no worker can grow a dependency on it.
 */
export interface SelectionQueueQueries {
  /** `pending` and `ambiguous` rows — the only statuses confirm() accepts — plus `failed`, so a missing mapping is visible. Oldest first. */
  awaitingConfirmation(limit: number): Promise<RepositorySelectionDocument[]>;
  /** Most recently confirmed first. */
  recentlyConfirmed(limit: number): Promise<RepositorySelectionDocument[]>;
}

export function createSelectionQueueQueries(db: Db): SelectionQueueQueries {
  const collection: Collection<RepositorySelectionDocument> = db.collection(COLLECTIONS.repositorySelections);
  return {
    async awaitingConfirmation(limit) {
      return collection
        .find({ status: { $in: ['pending', 'ambiguous', 'failed'] } } as Filter<RepositorySelectionDocument>)
        .sort({ createdAt: 1 })
        .limit(limit)
        .toArray();
    },
    async recentlyConfirmed(limit) {
      return collection
        .find({ status: 'selected' } as Filter<RepositorySelectionDocument>)
        .sort({ confirmedAt: -1 })
        .limit(limit)
        .toArray();
    },
  };
}
