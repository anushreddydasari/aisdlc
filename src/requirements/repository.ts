/**
 * Requirements-analysis repository — the domain layer for `requirementsAnalyses`.
 *
 * One row per intake item, enforced by the unique index on `intakeItemId`
 * (see INDEXES in src/db/collections.ts). That uniqueness is what makes
 * retries safe: `createPending` is idempotent the same way
 * `intake/repository.ts`'s `create()` is idempotent on `issueKey`, and
 * `markCompleted`/`markFailed` update the existing row rather than appending
 * a new one, the same pattern `checkpoints` uses for step retries.
 *
 * This module never writes to `intakeItems`. It only ever reads an
 * IntakeItemDocument handed to it by the caller (see worker.ts).
 */

import type { Collection, Db, ObjectId } from 'mongodb';

import type { Logger } from '../logging/logger.ts';
import { COLLECTIONS, type RequirementsAnalysisStatus } from '../db/collections.ts';
import type { RequirementsResult } from './analyzer.ts';

/**
 * Token usage for one analysis call. Provider-agnostic (prompt/completion/
 * total token counts apply the same way across LLM providers), so this lives
 * here rather than in openai-analyzer.ts — the document shape shouldn't need
 * to change if the provider does.
 */
export interface AnalysisUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface RequirementsAnalysisDocument {
  _id?: ObjectId;
  intakeItemId: ObjectId;
  issueKey: string;
  status: RequirementsAnalysisStatus;
  /** hashSnapshot() of the intake item's snapshot when this row was last written. */
  inputHash: string;
  result: RequirementsResult | null;
  error: { message: string; at: Date } | null;
  attempts: number;
  agentVersion: string;
  /**
   * Set separately from the analysis result via recordUsage(), after a
   * successful LLM-backed run — never populated by the deterministic stub,
   * which has no token usage to report. Kept as a sibling field rather than
   * folded into `result`, so `result` stays exactly RequirementsResult.
   */
  usage: AnalysisUsage | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface CreatePendingInput {
  readonly intakeItemId: ObjectId;
  readonly issueKey: string;
  readonly inputHash: string;
}

export interface CreatePendingResult {
  /** False when a row for this intakeItemId already existed. */
  readonly created: boolean;
  readonly document: RequirementsAnalysisDocument;
}

export interface MarkCompletedInput {
  readonly result: RequirementsResult;
  readonly inputHash: string;
  readonly agentVersion: string;
  readonly now?: Date;
}

export interface MarkFailedInput {
  readonly message: string;
  readonly inputHash: string;
  readonly agentVersion: string;
  readonly now?: Date;
}

export interface RequirementsRepository {
  /** Idempotent on intakeItemId: a retry returns the existing row unchanged. */
  createPending(input: CreatePendingInput): Promise<CreatePendingResult>;
  findByIntakeItemId(intakeItemId: ObjectId): Promise<RequirementsAnalysisDocument | null>;
  markCompleted(intakeItemId: ObjectId, input: MarkCompletedInput): Promise<RequirementsAnalysisDocument>;
  markFailed(intakeItemId: ObjectId, input: MarkFailedInput): Promise<RequirementsAnalysisDocument>;
  /**
   * Attaches usage metadata to an existing row, independent of markCompleted/
   * markFailed — callers invoke this only when a real LLM call reported
   * usage, after the analysis itself has already been stored.
   */
  recordUsage(intakeItemId: ObjectId, usage: AnalysisUsage, now?: Date): Promise<RequirementsAnalysisDocument>;
}

/**
 * Whether a run's usage should be persisted via recordUsage().
 *
 * Deliberately takes the outcome as a plain string union rather than
 * importing RequirementsOutcome from worker.ts: worker.ts already imports
 * from this module, and keeping this one-directional avoids a circular
 * dependency for the sake of one shared literal type.
 *
 * Usage is only meaningful for a FRESH completed analysis: `skipped_up_to_date`
 * never called the analyzer at all (so there is nothing to attribute), and a
 * failed outcome has nothing to attribute usage to even when the analyzer did
 * report some before throwing (see openai-analyzer.ts, which logs usage
 * before validating the tool call) — the row itself is marked `failed`, and
 * writing usage onto it would misleadingly suggest the analysis succeeded.
 *
 * A type guard so a caller gets `usage` narrowed to non-undefined on `true`.
 */
export function shouldRecordUsage(
  outcome: 'completed' | 'skipped_up_to_date' | 'failed_validation' | 'failed_analysis',
  usage: AnalysisUsage | undefined,
): usage is AnalysisUsage {
  return outcome === 'completed' && usage !== undefined;
}

export class RequirementsAnalysisNotFoundError extends Error {
  constructor(intakeItemId: ObjectId) {
    super(`no requirements analysis for intakeItemId '${intakeItemId.toHexString()}'`);
    this.name = 'RequirementsAnalysisNotFoundError';
  }
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;
}

export function createRequirementsRepository(db: Db, logger: Logger): RequirementsRepository {
  const collection: Collection<RequirementsAnalysisDocument> = db.collection(
    COLLECTIONS.requirementsAnalyses,
  );

  return {
    async createPending(input: CreatePendingInput): Promise<CreatePendingResult> {
      const existing = await collection.findOne({ intakeItemId: input.intakeItemId });
      if (existing !== null) {
        logger.info('requirements analysis already exists; reusing', {
          issueKey: input.issueKey,
          status: existing.status,
        });
        return { created: false, document: existing };
      }

      const now = new Date();
      const document: RequirementsAnalysisDocument = {
        intakeItemId: input.intakeItemId,
        issueKey: input.issueKey,
        status: 'pending',
        inputHash: input.inputHash,
        result: null,
        error: null,
        attempts: 0,
        // Overwritten by markCompleted/markFailed once an analyzer actually
        // runs; recorded here too so a row is never without one.
        agentVersion: 'unassigned',
        usage: null,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      };

      try {
        const insertedId = (await collection.insertOne(document)).insertedId;
        logger.info('requirements analysis created', { issueKey: input.issueKey });
        return { created: true, document: { ...document, _id: insertedId } };
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        // Lost a race against a concurrent writer. The unique index on
        // intakeItemId did its job; return what the winner wrote.
        const winner = await collection.findOne({ intakeItemId: input.intakeItemId });
        if (winner === null) throw error;
        logger.info('lost insert race on intakeItemId; returning existing row', {
          issueKey: input.issueKey,
        });
        return { created: false, document: winner };
      }
    },

    async findByIntakeItemId(intakeItemId: ObjectId): Promise<RequirementsAnalysisDocument | null> {
      return collection.findOne({ intakeItemId });
    },

    async markCompleted(
      intakeItemId: ObjectId,
      input: MarkCompletedInput,
    ): Promise<RequirementsAnalysisDocument> {
      const now = input.now ?? new Date();
      const updated = await collection.findOneAndUpdate(
        { intakeItemId },
        {
          $set: {
            status: 'completed',
            result: input.result,
            error: null,
            inputHash: input.inputHash,
            agentVersion: input.agentVersion,
            updatedAt: now,
            completedAt: now,
          },
          $inc: { attempts: 1 },
        },
        { returnDocument: 'after' },
      );
      if (updated === null) throw new RequirementsAnalysisNotFoundError(intakeItemId);
      logger.info('requirements analysis completed', { issueKey: updated.issueKey });
      return updated;
    },

    async markFailed(
      intakeItemId: ObjectId,
      input: MarkFailedInput,
    ): Promise<RequirementsAnalysisDocument> {
      const now = input.now ?? new Date();
      const updated = await collection.findOneAndUpdate(
        { intakeItemId },
        {
          $set: {
            status: 'failed',
            error: { message: input.message, at: now },
            inputHash: input.inputHash,
            agentVersion: input.agentVersion,
            updatedAt: now,
          },
          $inc: { attempts: 1 },
        },
        { returnDocument: 'after' },
      );
      if (updated === null) throw new RequirementsAnalysisNotFoundError(intakeItemId);
      logger.warn('requirements analysis failed', { issueKey: updated.issueKey, message: input.message });
      return updated;
    },

    async recordUsage(
      intakeItemId: ObjectId,
      usage: AnalysisUsage,
      now = new Date(),
    ): Promise<RequirementsAnalysisDocument> {
      const updated = await collection.findOneAndUpdate(
        { intakeItemId },
        { $set: { usage, updatedAt: now } },
        { returnDocument: 'after' },
      );
      if (updated === null) throw new RequirementsAnalysisNotFoundError(intakeItemId);
      logger.debug('requirements analysis usage recorded', { issueKey: updated.issueKey });
      return updated;
    },
  };
}
