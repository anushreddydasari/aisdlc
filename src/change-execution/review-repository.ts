/**
 * Change review repository — the domain layer for `changeReviews`, and the
 * Human Approval API/Service this phase's Section 3 asks for: retrieving a
 * proposal, and the only two ways to decide it (`approve`, `reject`).
 *
 * IMPORTANT SAFETY RULE, enforced here: the Coding Agent must never
 * automatically approve its own changes. `approve` and `reject` both refuse
 * any `actor` that does not carry the `OPERATOR_PRINCIPAL_PREFIX` — the
 * exact same rule, and the exact same reasoning, as
 * `intake/repository.ts`'s `transition(..., 'approved', ...)`. Nothing
 * short of an operator explicitly calling `approve()` ever moves a review
 * out of `pending`. Opening a proposal, reading it, running the Coding
 * Agent, or queueing a run are never interpreted as approval — none of
 * those actions call this module's write methods at all.
 *
 * IMMUTABLE PROPOSALS. A `changeReviews` row is never rewritten with new
 * plan/proposedChanges content — `createIfAbsent` is idempotent on
 * `proposalHash` (see proposal-hash.ts), so a regenerated proposal for the
 * same run is always a NEW row. This is what makes an approval meaningful:
 * approving row X can never later be reinterpreted as approving different
 * content, because X's content cannot change. The "is this still the
 * latest review for the run" check — what makes an approval on a
 * SUPERSEDED proposal refuse to execute — lives in execution-service.ts,
 * not here: this repository's job is recording an immutable decision about
 * one immutable row, not adjudicating which row is current.
 */

import type { Collection, Db, ObjectId } from 'mongodb';

import type { AuditLog } from '../db/audit-log.ts';
import type { Logger } from '../logging/logger.ts';
import { COLLECTIONS, OPERATOR_PRINCIPAL_PREFIX, type ChangeReviewStatus } from '../db/collections.ts';
import { computeProposalHash } from './proposal-hash.ts';
import type { ImplementationPlan, ProposedChange } from './types.ts';

/** Recorded as the actor for system-driven audit entries this module appends (creation only — approve/reject always record the human operator as actor). */
export const CHANGE_REVIEW_SYSTEM_ACTOR = 'system:change-review';

export interface ChangeReviewDocument {
  _id?: ObjectId;
  runId: ObjectId;
  intakeItemId: ObjectId;
  /** A snapshot at review-creation time — never re-read afterwards, the same reason repositorySelections snapshots its own selected* fields. */
  repositoryId: string;
  owner: string;
  repo: string;
  branch: string;
  plan: ImplementationPlan;
  proposedChanges: ProposedChange[];
  proposalHash: string;
  status: ChangeReviewStatus;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  reviewComment: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateChangeReviewInput {
  readonly runId: ObjectId;
  readonly intakeItemId: ObjectId;
  readonly repositoryId: string;
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  readonly plan: ImplementationPlan;
  readonly proposedChanges: readonly ProposedChange[];
}

export interface CreateChangeReviewResult {
  readonly review: ChangeReviewDocument;
  readonly created: boolean;
}

export interface ReviewDecisionInput {
  readonly actor: string;
  readonly comment?: string;
}

export class ReviewNotFoundError extends Error {
  constructor(id: string) {
    super(`no change review for id '${id}'`);
    this.name = 'ReviewNotFoundError';
  }
}

export class ReviewNotPendingError extends Error {
  readonly status: ChangeReviewStatus;

  constructor(id: string, status: ChangeReviewStatus) {
    super(`change review '${id}' is '${status}', not 'pending' — it has already been decided`);
    this.name = 'ReviewNotPendingError';
    this.status = status;
  }
}

export class ReviewDecisionRequiresOperatorError extends Error {
  readonly actor: string;

  constructor(actor: string) {
    super(
      `actor must identify a human operator (prefix '${OPERATOR_PRINCIPAL_PREFIX}'), ` +
        'so a service identity — including the Coding Agent itself — can never approve or reject its own proposal. ' +
        'Received a principal that does not carry that prefix.',
    );
    this.name = 'ReviewDecisionRequiresOperatorError';
    this.actor = actor;
  }
}

export interface ChangeReviewRepository {
  /** Idempotent on the content hash of (plan, proposedChanges): identical proposal content returns the existing row rather than creating a duplicate. */
  createIfAbsent(input: CreateChangeReviewInput): Promise<CreateChangeReviewResult>;
  findById(id: ObjectId): Promise<ChangeReviewDocument | null>;
  /** The most recently created review for a run — what "is this still the latest proposal" execution-time checks compare against. */
  findLatestByRunId(runId: ObjectId): Promise<ChangeReviewDocument | null>;
  /** Throws `ReviewDecisionRequiresOperatorError` for a non-operator actor, `ReviewNotFoundError` / `ReviewNotPendingError` otherwise. */
  approve(id: ObjectId, options: ReviewDecisionInput): Promise<ChangeReviewDocument>;
  /** Same operator-identity and status requirements as `approve`. */
  reject(id: ObjectId, options: ReviewDecisionInput): Promise<ChangeReviewDocument>;
  /**
   * Every currently-approved review, oldest first — the pipeline queue's
   * poll for "approved reviews that might still need executing." Includes
   * reviews that already have an execution recorded; the caller (see
   * `pipeline/change-execution-queue.ts`) checks `ChangeExecutionRepository.findByReviewId`
   * per row before acting, the same "list broadly, then check per-item"
   * shape `repository-selection/worker.ts` already uses.
   */
  findApproved(limit?: number): Promise<ChangeReviewDocument[]>;
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;
}

export function createChangeReviewRepository(
  db: Db,
  audit: AuditLog,
  logger: Logger,
): ChangeReviewRepository {
  const collection: Collection<ChangeReviewDocument> = db.collection(COLLECTIONS.changeReviews);

  async function decide(
    id: ObjectId,
    to: Extract<ChangeReviewStatus, 'approved' | 'rejected'>,
    options: ReviewDecisionInput,
  ): Promise<ChangeReviewDocument> {
    if (!options.actor.startsWith(OPERATOR_PRINCIPAL_PREFIX)) {
      throw new ReviewDecisionRequiresOperatorError(options.actor);
    }

    const current = await collection.findOne({ _id: id });
    if (current === null) throw new ReviewNotFoundError(id.toHexString());
    if (current.status !== 'pending') throw new ReviewNotPendingError(id.toHexString(), current.status);

    const now = new Date();
    const updated = await collection.findOneAndUpdate(
      { _id: id, status: 'pending' },
      {
        $set: {
          status: to,
          reviewedBy: options.actor,
          reviewedAt: now,
          reviewComment: options.comment ?? null,
          updatedAt: now,
        },
      },
      { returnDocument: 'after' },
    );

    if (updated === null) {
      // Lost a race against a concurrent decision since the read above.
      const raced = await collection.findOne({ _id: id });
      throw new ReviewNotPendingError(id.toHexString(), raced?.status ?? current.status);
    }

    await audit.append({
      actor: options.actor,
      action: `change-review.${to}`,
      subjectType: 'changeReview',
      subjectId: id,
      detail: {
        runId: updated.runId.toHexString(),
        proposalHash: updated.proposalHash,
        ...(options.comment === undefined ? {} : { comment: options.comment }),
      },
    });

    logger.info('change review decided', { reviewId: id.toHexString(), status: to });
    return updated;
  }

  return {
    async createIfAbsent(input: CreateChangeReviewInput): Promise<CreateChangeReviewResult> {
      const proposalHash = computeProposalHash(input.plan, input.proposedChanges);
      const now = new Date();
      const document: ChangeReviewDocument = {
        runId: input.runId,
        intakeItemId: input.intakeItemId,
        repositoryId: input.repositoryId,
        owner: input.owner,
        repo: input.repo,
        branch: input.branch,
        plan: input.plan,
        proposedChanges: [...input.proposedChanges],
        proposalHash,
        status: 'pending',
        reviewedBy: null,
        reviewedAt: null,
        reviewComment: null,
        createdAt: now,
        updatedAt: now,
      };

      let insertedId: ObjectId;
      try {
        insertedId = (await collection.insertOne(document)).insertedId;
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        logger.info('change review already exists for this proposal content; returning existing row', {
          proposalHash,
        });
        const existing = await collection.findOne({ proposalHash });
        if (existing === null) throw error;
        return { review: existing, created: false };
      }

      await audit.append({
        actor: CHANGE_REVIEW_SYSTEM_ACTOR,
        action: 'change-review.created',
        subjectType: 'changeReview',
        subjectId: insertedId,
        detail: {
          runId: input.runId.toHexString(),
          repositoryId: input.repositoryId,
          proposalHash,
          changeCount: input.proposedChanges.length,
        },
      });

      logger.info('change review created', {
        reviewId: insertedId.toHexString(),
        runId: input.runId.toHexString(),
        changeCount: input.proposedChanges.length,
      });

      return { review: { ...document, _id: insertedId }, created: true };
    },

    async findById(id: ObjectId): Promise<ChangeReviewDocument | null> {
      return collection.findOne({ _id: id });
    },

    async findLatestByRunId(runId: ObjectId): Promise<ChangeReviewDocument | null> {
      const rows = await collection.find({ runId }).sort({ createdAt: -1 }).limit(1).toArray();
      return rows[0] ?? null;
    },

    async approve(id: ObjectId, options: ReviewDecisionInput): Promise<ChangeReviewDocument> {
      return decide(id, 'approved', options);
    },

    async reject(id: ObjectId, options: ReviewDecisionInput): Promise<ChangeReviewDocument> {
      return decide(id, 'rejected', options);
    },

    async findApproved(limit = 25): Promise<ChangeReviewDocument[]> {
      return collection.find({ status: 'approved' }).sort({ updatedAt: 1 }).limit(limit).toArray();
    },
  };
}

/**
 * Read-only listing for the AISDLC Console's Gate 3 (api/operator-queue.ts).
 * Kept off ChangeReviewRepository for the same reason SelectionQueueQueries
 * is kept off RepositorySelectionRepository: no pipeline worker should grow
 * a dependency on "everything awaiting a human".
 */
export interface ChangeReviewQueueQueries {
  /** `pending` reviews, oldest first — the only status approve()/reject() accept. */
  pending(limit: number): Promise<ChangeReviewDocument[]>;
}

export function createChangeReviewQueueQueries(db: Db): ChangeReviewQueueQueries {
  const collection: Collection<ChangeReviewDocument> = db.collection(COLLECTIONS.changeReviews);
  return {
    async pending(limit) {
      return collection.find({ status: 'pending' }).sort({ createdAt: 1 }).limit(limit).toArray();
    },
  };
}
