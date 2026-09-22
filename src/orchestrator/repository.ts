/**
 * Runs repository — the domain layer for `runs`.
 *
 * One row per approved intake item, for this phase: createIfAbsent is
 * idempotent on intakeItemId via the unique index in src/db/collections.ts,
 * the same find-or-create-catching-duplicate-key pattern already proven in
 * intake/repository.ts's create() and requirements/repository.ts's
 * createPending().
 *
 * This module never writes to intakeItems or requirementsAnalyses. It only
 * ever creates and reads `runs` documents.
 */

import type { Collection, Db, Filter, ObjectId } from 'mongodb';

import type { Logger } from '../logging/logger.ts';
import { COLLECTIONS, type RunStatus, type RunTrigger } from '../db/collections.ts';

export interface RunDocument {
  _id?: ObjectId;
  intakeItemId: ObjectId;
  issueKey: string;
  status: RunStatus;
  trigger: RunTrigger;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
}

export interface CreateRunInput {
  readonly intakeItemId: ObjectId;
  readonly issueKey: string;
  readonly trigger: RunTrigger;
}

export interface CreateRunResult {
  /** False when a run for this intakeItemId already existed. */
  readonly created: boolean;
  readonly run: RunDocument;
}

export interface RunsRepository {
  /** Idempotent on intakeItemId: a retry returns the existing run unchanged. */
  createIfAbsent(input: CreateRunInput): Promise<CreateRunResult>;
  findByIntakeItemId(intakeItemId: ObjectId): Promise<RunDocument | null>;
  findById(runId: ObjectId): Promise<RunDocument | null>;
  list(filter?: Filter<RunDocument>, limit?: number): Promise<RunDocument[]>;
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;
}

export function createRunsRepository(db: Db, logger: Logger): RunsRepository {
  const collection: Collection<RunDocument> = db.collection(COLLECTIONS.runs);

  return {
    async createIfAbsent(input: CreateRunInput): Promise<CreateRunResult> {
      const existing = await collection.findOne({ intakeItemId: input.intakeItemId });
      if (existing !== null) {
        logger.info('run already queued for this intake item; reusing', {
          issueKey: input.issueKey,
          status: existing.status,
        });
        return { created: false, run: existing };
      }

      const now = new Date();
      const document: RunDocument = {
        intakeItemId: input.intakeItemId,
        issueKey: input.issueKey,
        status: 'queued',
        trigger: input.trigger,
        createdAt: now,
        startedAt: null,
        completedAt: null,
        updatedAt: now,
      };

      try {
        const insertedId = (await collection.insertOne(document)).insertedId;
        logger.info('run queued', { issueKey: input.issueKey, trigger: input.trigger });
        return { created: true, run: { ...document, _id: insertedId } };
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        // Lost a race against a concurrent orchestrator pass. The unique
        // index on intakeItemId did its job; return what the winner wrote.
        const winner = await collection.findOne({ intakeItemId: input.intakeItemId });
        if (winner === null) throw error;
        logger.info('lost insert race on intakeItemId; returning existing run', {
          issueKey: input.issueKey,
        });
        return { created: false, run: winner };
      }
    },

    async findByIntakeItemId(intakeItemId: ObjectId): Promise<RunDocument | null> {
      return collection.findOne({ intakeItemId });
    },

    async findById(runId: ObjectId): Promise<RunDocument | null> {
      return collection.findOne({ _id: runId });
    },

    async list(filter: Filter<RunDocument> = {}, limit = 100): Promise<RunDocument[]> {
      return collection.find(filter).sort({ createdAt: -1 }).limit(limit).toArray();
    },
  };
}
