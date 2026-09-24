/**
 * GitHub publication repository — the domain layer for `githubPublications`,
 * and the durable idempotency record for the GitHub Write + Pull Request
 * Workflow.
 *
 * IDEMPOTENCY. `createIfAbsent` is idempotent on `executionId`: a given
 * approved, successfully-validated execution is published at most once,
 * ever. A second attempt — retry, duplicate request, or a race lost
 * against a concurrent caller — finds the existing row via the unique
 * index and returns it rather than re-publishing anything. The same
 * `createIfAbsent`-on-a-unique-index shape `changeExecutions.reviewId_unique`
 * already uses one phase up; no second, competing run/execution identity
 * system was introduced.
 */

import type { Collection, Db, ObjectId } from 'mongodb';

import type { AuditLog } from '../db/audit-log.ts';
import type { Logger } from '../logging/logger.ts';
import { COLLECTIONS, type GithubPublicationStatus } from '../db/collections.ts';
import type { PublishFailureCategory } from './types.ts';

/** Recorded as every audit entry's actor. Never a human or another system component's identity. */
export const GITHUB_PUBLISH_SYSTEM_ACTOR = 'system:github-publish';

export interface GithubPublicationDocument {
  _id?: ObjectId;
  runId: ObjectId;
  reviewId: ObjectId;
  executionId: ObjectId;
  owner: string;
  repo: string;
  baseBranch: string;
  branch: string;
  /** The base branch's commit sha at the moment the commit was built on top of it. Null only for a failure recorded before that point. */
  baseSha: string | null;
  commitSha: string | null;
  status: GithubPublicationStatus;
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
  failureCategory: PublishFailureCategory | null;
  failureMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface RecordPublicationInput {
  readonly runId: ObjectId;
  readonly reviewId: ObjectId;
  readonly executionId: ObjectId;
  readonly owner: string;
  readonly repo: string;
  readonly baseBranch: string;
  readonly branch: string;
  readonly baseSha: string | null;
  readonly commitSha: string | null;
  readonly status: GithubPublicationStatus;
  readonly pullRequestNumber: number | null;
  readonly pullRequestUrl: string | null;
  readonly failureCategory: PublishFailureCategory | null;
  readonly failureMessage: string | null;
}

export interface RecordPublicationResult {
  readonly publication: GithubPublicationDocument;
  readonly created: boolean;
}

export interface GithubPublicationRepository {
  /** Idempotent on executionId — see the module comment. */
  createIfAbsent(input: RecordPublicationInput): Promise<RecordPublicationResult>;
  findByExecutionId(executionId: ObjectId): Promise<GithubPublicationDocument | null>;
  /**
   * Every currently-`published` publication, oldest first — the PR-merge
   * detection worker's poll (deployment/pr-merge-detection.ts). Includes
   * publications that already have a deployment record; the caller checks
   * `DeploymentRepository.findByPublicationId` per row before acting, the
   * same "list broadly, then check per-item" shape every queue worker in
   * this codebase already uses.
   */
  findPublished(limit?: number): Promise<GithubPublicationDocument[]>;
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;
}

export function createGithubPublicationRepository(
  db: Db,
  audit: AuditLog,
  logger: Logger,
): GithubPublicationRepository {
  const collection: Collection<GithubPublicationDocument> = db.collection(COLLECTIONS.githubPublications);

  return {
    async createIfAbsent(input: RecordPublicationInput): Promise<RecordPublicationResult> {
      const now = new Date();
      const document: GithubPublicationDocument = {
        runId: input.runId,
        reviewId: input.reviewId,
        executionId: input.executionId,
        owner: input.owner,
        repo: input.repo,
        baseBranch: input.baseBranch,
        branch: input.branch,
        baseSha: input.baseSha,
        commitSha: input.commitSha,
        status: input.status,
        pullRequestNumber: input.pullRequestNumber,
        pullRequestUrl: input.pullRequestUrl,
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
        logger.info('publication already recorded for this execution; returning existing row', {
          executionId: input.executionId.toHexString(),
        });
        const existing = await collection.findOne({ executionId: input.executionId });
        if (existing === null) throw error;
        return { publication: existing, created: false };
      }

      await audit.append({
        actor: GITHUB_PUBLISH_SYSTEM_ACTOR,
        action: input.status === 'published' ? 'github.write.completed' : 'github.write.failed',
        subjectType: 'githubPublication',
        subjectId: insertedId,
        detail: {
          runId: input.runId.toHexString(),
          executionId: input.executionId.toHexString(),
          status: input.status,
          ...(input.branch === '' ? {} : { branch: input.branch }),
          ...(input.pullRequestNumber === null ? {} : { pullRequestNumber: input.pullRequestNumber }),
          ...(input.failureCategory === null ? {} : { failureCategory: input.failureCategory }),
        },
      });

      logger.info('github publication recorded', {
        publicationId: insertedId.toHexString(),
        executionId: input.executionId.toHexString(),
        status: input.status,
      });

      return { publication: { ...document, _id: insertedId }, created: true };
    },

    async findByExecutionId(executionId: ObjectId): Promise<GithubPublicationDocument | null> {
      return collection.findOne({ executionId });
    },

    async findPublished(limit = 25): Promise<GithubPublicationDocument[]> {
      return collection.find({ status: 'published' }).sort({ createdAt: 1 }).limit(limit).toArray();
    },
  };
}
