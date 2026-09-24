/**
 * Deployment repository — the domain layer for `deployments`.
 *
 * ONE row per publication's merge outcome, ever (`publicationId_unique`).
 * Created once, by `createIfAbsent`, the moment merge detection has
 * something definitive to report — either the PR was merged (`status:
 * 'eligible'`) or it was closed without merging (`status:
 * 'closed_unmerged'`, terminal — see `pr-merge-detection.ts`). From
 * `'eligible'`, the deployment worker's own lifecycle methods
 * (`claim`/`markSucceeded`/`markFailed`) advance the SAME row through to a
 * terminal outcome; no second row is ever created for one publication.
 *
 * AUDIT OWNERSHIP. This module audits its own row's lifecycle events
 * (`github.pr.merge.detected` / `github.pr.closed_without_merge.detected`
 * on creation, `deployment.completed` / `deployment.failed` on
 * finalization) — the same "the repository audits its own write" pattern
 * `change-execution/execution-repository.ts` and
 * `github-publish/publish-repository.ts` already establish.
 * `deployment.started` and the `deployment.validation.*` events are NOT
 * emitted here — they belong to `deployment-service.ts`, the same
 * "eligibility-phase and mid-attempt events live in the service; the
 * repository only audits its own writes" split
 * `change-execution/execution-service.ts` already established.
 */

import type { Collection, Db, ObjectId } from 'mongodb';

import type { AuditLog } from '../db/audit-log.ts';
import type { Logger } from '../logging/logger.ts';
import { COLLECTIONS, type DeploymentStatus } from '../db/collections.ts';
import type { DeploymentFailureCategory, PostDeploymentValidationSummary } from './types.ts';

/** Recorded as every audit entry's actor. Never a human or another system component's identity. */
export const DEPLOYMENT_SYSTEM_ACTOR = 'system:deployment';

export interface DeploymentDocument {
  _id?: ObjectId;
  runId: ObjectId;
  executionId: ObjectId;
  publicationId: ObjectId;
  owner: string;
  repo: string;
  pullRequestNumber: number;
  /** Null only for a `closed_unmerged` row — no merge ever happened. */
  mergeCommitSha: string | null;
  status: DeploymentStatus;
  provider: string | null;
  target: string | null;
  deploymentIdentifier: string | null;
  validation: PostDeploymentValidationSummary | null;
  failureCategory: DeploymentFailureCategory | null;
  failureMessage: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface CreateDeploymentInput {
  readonly runId: ObjectId;
  readonly executionId: ObjectId;
  readonly publicationId: ObjectId;
  readonly owner: string;
  readonly repo: string;
  readonly pullRequestNumber: number;
  readonly mergeCommitSha: string | null;
  /** Only these two are ever the INITIAL status of a row — see the module comment. */
  readonly status: Extract<DeploymentStatus, 'eligible' | 'closed_unmerged'>;
}

export interface CreateDeploymentResult {
  readonly deployment: DeploymentDocument;
  readonly created: boolean;
}

export interface MarkSucceededInput {
  readonly provider: string;
  readonly target: string;
  readonly deploymentIdentifier: string;
  readonly validation: PostDeploymentValidationSummary;
}

export interface MarkFailedInput {
  readonly category: DeploymentFailureCategory;
  readonly message: string;
  readonly validation?: PostDeploymentValidationSummary;
}

export interface DeploymentRepository {
  /** Idempotent on publicationId — see the module comment. */
  createIfAbsent(input: CreateDeploymentInput): Promise<CreateDeploymentResult>;
  findByPublicationId(publicationId: ObjectId): Promise<DeploymentDocument | null>;
  /** Every currently-`eligible` deployment, oldest first — the deployment worker's poll. */
  findEligible(limit?: number): Promise<DeploymentDocument[]>;
  /**
   * Compare-and-set `eligible -> running`, the claim that prevents two
   * concurrent workers from both attempting the same deployment. Returns
   * null if the row was no longer `eligible` (already claimed, or moved
   * on) — never throws for a lost race, the same "a race is a harmless
   * no-op" discipline `repository-selection/repository.ts`'s
   * `recordMatchResult` already established.
   */
  claim(id: ObjectId): Promise<DeploymentDocument | null>;
  markSucceeded(id: ObjectId, input: MarkSucceededInput): Promise<DeploymentDocument>;
  markFailed(id: ObjectId, input: MarkFailedInput): Promise<DeploymentDocument>;
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;
}

export class DeploymentNotFoundError extends Error {
  constructor(id: string) {
    super(`no deployment for id '${id}'`);
    this.name = 'DeploymentNotFoundError';
  }
}

export function createDeploymentRepository(db: Db, audit: AuditLog, logger: Logger): DeploymentRepository {
  const collection: Collection<DeploymentDocument> = db.collection(COLLECTIONS.deployments);

  return {
    async createIfAbsent(input: CreateDeploymentInput): Promise<CreateDeploymentResult> {
      const now = new Date();
      const document: DeploymentDocument = {
        runId: input.runId,
        executionId: input.executionId,
        publicationId: input.publicationId,
        owner: input.owner,
        repo: input.repo,
        pullRequestNumber: input.pullRequestNumber,
        mergeCommitSha: input.mergeCommitSha,
        status: input.status,
        provider: null,
        target: null,
        deploymentIdentifier: null,
        validation: null,
        failureCategory: null,
        failureMessage: null,
        createdAt: now,
        startedAt: null,
        completedAt: input.status === 'closed_unmerged' ? now : null,
      };

      let insertedId: ObjectId;
      try {
        insertedId = (await collection.insertOne(document)).insertedId;
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        logger.info('deployment already recorded for this publication; returning existing row', {
          publicationId: input.publicationId.toHexString(),
        });
        const existing = await collection.findOne({ publicationId: input.publicationId });
        if (existing === null) throw error;
        return { deployment: existing, created: false };
      }

      await audit.append({
        actor: DEPLOYMENT_SYSTEM_ACTOR,
        action: input.status === 'eligible' ? 'github.pr.merge.detected' : 'github.pr.closed_without_merge.detected',
        subjectType: 'deployment',
        subjectId: insertedId,
        detail: {
          runId: input.runId.toHexString(),
          executionId: input.executionId.toHexString(),
          publicationId: input.publicationId.toHexString(),
          pullRequestNumber: input.pullRequestNumber,
          ...(input.mergeCommitSha === null ? {} : { mergeCommitSha: input.mergeCommitSha }),
        },
      });

      logger.info('deployment record created', { deploymentId: insertedId.toHexString(), status: input.status });
      return { deployment: { ...document, _id: insertedId }, created: true };
    },

    async findByPublicationId(publicationId: ObjectId): Promise<DeploymentDocument | null> {
      return collection.findOne({ publicationId });
    },

    async findEligible(limit = 25): Promise<DeploymentDocument[]> {
      return collection.find({ status: 'eligible' }).sort({ createdAt: 1 }).limit(limit).toArray();
    },

    async claim(id: ObjectId): Promise<DeploymentDocument | null> {
      const now = new Date();
      return collection.findOneAndUpdate(
        { _id: id, status: 'eligible' },
        { $set: { status: 'running', startedAt: now } },
        { returnDocument: 'after' },
      );
    },

    async markSucceeded(id: ObjectId, input: MarkSucceededInput): Promise<DeploymentDocument> {
      const now = new Date();
      const updated = await collection.findOneAndUpdate(
        { _id: id },
        {
          $set: {
            status: 'succeeded',
            provider: input.provider,
            target: input.target,
            deploymentIdentifier: input.deploymentIdentifier,
            validation: input.validation,
            completedAt: now,
          },
        },
        { returnDocument: 'after' },
      );
      if (updated === null) throw new DeploymentNotFoundError(id.toHexString());

      await audit.append({
        actor: DEPLOYMENT_SYSTEM_ACTOR,
        action: 'deployment.completed',
        subjectType: 'deployment',
        subjectId: id,
        detail: {
          runId: updated.runId.toHexString(),
          deploymentIdentifier: input.deploymentIdentifier,
          provider: input.provider,
          target: input.target,
        },
      });

      logger.info('deployment succeeded', { deploymentId: id.toHexString(), deploymentIdentifier: input.deploymentIdentifier });
      return updated;
    },

    async markFailed(id: ObjectId, input: MarkFailedInput): Promise<DeploymentDocument> {
      const now = new Date();
      const updated = await collection.findOneAndUpdate(
        { _id: id },
        {
          $set: {
            status: 'failed',
            failureCategory: input.category,
            failureMessage: input.message,
            ...(input.validation === undefined ? {} : { validation: input.validation }),
            completedAt: now,
          },
        },
        { returnDocument: 'after' },
      );
      if (updated === null) throw new DeploymentNotFoundError(id.toHexString());

      await audit.append({
        actor: DEPLOYMENT_SYSTEM_ACTOR,
        action: 'deployment.failed',
        subjectType: 'deployment',
        subjectId: id,
        detail: { runId: updated.runId.toHexString(), category: input.category },
      });

      logger.warn('deployment failed', { deploymentId: id.toHexString(), category: input.category });
      return updated;
    },
  };
}
