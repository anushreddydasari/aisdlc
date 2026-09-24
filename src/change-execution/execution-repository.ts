/**
 * Change execution repository — the domain layer for `changeExecutions`,
 * and the durable record `change-execution.*` idempotency is built on.
 *
 * IDEMPOTENCY (Section 10). `createIfAbsent` is idempotent on `reviewId`:
 * an approved review may be executed at most once, ever. A second attempt —
 * whether a genuine retry, a duplicate request, or two concurrent callers —
 * finds the existing row via the unique index and returns it rather than
 * re-applying anything. This is the same `createIfAbsent`-on-a-unique-index
 * shape `runs.intakeItemId_unique` and `requirementsAnalyses.intakeItemId_unique`
 * already use; no second, competing run-identity system was introduced.
 */

import type { Collection, Db, ObjectId } from 'mongodb';

import type { AuditLog } from '../db/audit-log.ts';
import type { Logger } from '../logging/logger.ts';
import { COLLECTIONS, type ChangeExecutionStatus } from '../db/collections.ts';
import type { AppliedChange, ExecutionFailureCategory, ValidationSummary } from './types.ts';

/** Recorded as every audit entry's actor. Never a human or another system component's identity. */
export const CHANGE_EXECUTION_SYSTEM_ACTOR = 'system:change-execution';

export interface ChangeExecutionDocument {
  _id?: ObjectId;
  runId: ObjectId;
  reviewId: ObjectId;
  proposalHash: string;
  status: ChangeExecutionStatus;
  appliedChanges: AppliedChange[];
  validation: ValidationSummary | null;
  failureCategory: ExecutionFailureCategory | null;
  failureMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface RecordExecutionInput {
  readonly runId: ObjectId;
  readonly reviewId: ObjectId;
  readonly proposalHash: string;
  readonly status: ChangeExecutionStatus;
  readonly appliedChanges: readonly AppliedChange[];
  readonly validation: ValidationSummary | null;
  readonly failureCategory: ExecutionFailureCategory | null;
  readonly failureMessage: string | null;
}

export interface RecordExecutionResult {
  readonly execution: ChangeExecutionDocument;
  readonly created: boolean;
}

export interface ChangeExecutionRepository {
  /** Idempotent on reviewId — see the module comment. */
  createIfAbsent(input: RecordExecutionInput): Promise<RecordExecutionResult>;
  findByReviewId(reviewId: ObjectId): Promise<ChangeExecutionDocument | null>;
  /** Looked up by its own id — used by github-publish/, which is given an executionId directly rather than a reviewId. */
  findById(id: ObjectId): Promise<ChangeExecutionDocument | null>;
  /**
   * Every currently-succeeded execution, oldest first — the pipeline
   * queue's poll for "successful executions that might still need
   * publishing." See `ChangeReviewRepository.findApproved`'s comment for
   * why this "list broadly, check per-item" shape is correct.
   */
  findSucceeded(limit?: number): Promise<ChangeExecutionDocument[]>;
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;
}

export function createChangeExecutionRepository(
  db: Db,
  audit: AuditLog,
  logger: Logger,
): ChangeExecutionRepository {
  const collection: Collection<ChangeExecutionDocument> = db.collection(COLLECTIONS.changeExecutions);

  return {
    async createIfAbsent(input: RecordExecutionInput): Promise<RecordExecutionResult> {
      const now = new Date();
      const document: ChangeExecutionDocument = {
        runId: input.runId,
        reviewId: input.reviewId,
        proposalHash: input.proposalHash,
        status: input.status,
        appliedChanges: [...input.appliedChanges],
        validation: input.validation,
        failureCategory: input.failureCategory,
        failureMessage: input.failureMessage,
        createdAt: now,
        completedAt: now,
      };

      let insertedId: ObjectId;
      try {
        insertedId = (await collection.insertOne(document)).insertedId;
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        logger.info('change execution already recorded for this review; returning existing row', {
          reviewId: input.reviewId.toHexString(),
        });
        const existing = await collection.findOne({ reviewId: input.reviewId });
        if (existing === null) throw error;
        return { execution: existing, created: false };
      }

      await audit.append({
        actor: CHANGE_EXECUTION_SYSTEM_ACTOR,
        action: input.status === 'succeeded' ? 'change-execution.completed' : 'change-execution.failed',
        subjectType: 'changeExecution',
        subjectId: insertedId,
        detail: {
          runId: input.runId.toHexString(),
          reviewId: input.reviewId.toHexString(),
          status: input.status,
          appliedFileCount: input.appliedChanges.length,
          ...(input.failureCategory === null ? {} : { failureCategory: input.failureCategory }),
        },
      });

      logger.info('change execution recorded', {
        executionId: insertedId.toHexString(),
        reviewId: input.reviewId.toHexString(),
        status: input.status,
      });

      return { execution: { ...document, _id: insertedId }, created: true };
    },

    async findByReviewId(reviewId: ObjectId): Promise<ChangeExecutionDocument | null> {
      return collection.findOne({ reviewId });
    },

    async findById(id: ObjectId): Promise<ChangeExecutionDocument | null> {
      return collection.findOne({ _id: id });
    },

    async findSucceeded(limit = 25): Promise<ChangeExecutionDocument[]> {
      return collection.find({ status: 'succeeded' }).sort({ createdAt: 1 }).limit(limit).toArray();
    },
  };
}
