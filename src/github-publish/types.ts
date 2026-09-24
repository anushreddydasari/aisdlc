/**
 * GitHub Write + Pull Request Workflow — shared result models and failure
 * taxonomy.
 *
 * Human Review → Approved Change Execution → Local Validation → **GitHub
 * Write + Pull Request Workflow** (this module) → Human PR Review → Merge.
 *
 * IMPORTANT SAFETY RULE, again: this module NEVER merges a pull request.
 * `publish-service.ts` exports exactly one write-capable entry point,
 * `publishApprovedChanges`, and it stops the moment a pull request exists —
 * see that module's header comment. There is no merge method anywhere in
 * this module, `github-app/client.ts`, or its implementations.
 *
 * TWO PHASES, the same split `change-execution/execution-service.ts`
 * already established and for the same reason:
 *
 *   1. Eligibility (unpersisted, freely re-checkable): does an approved,
 *      successfully-validated execution exist for this exact, still-current
 *      review, and does the run still resolve to the reviewed
 *      repository/branch? Nothing here has a side effect.
 *   2. Attempt (persisted via `GithubPublicationRepository`, idempotent on
 *      `executionId`): re-verify every file's live content one more time,
 *      build one commit, publish a new branch, open a pull request. Once
 *      execution reaches this phase, every outcome is recorded exactly
 *      once — a second call for the same execution never re-publishes.
 */

import type { ObjectId } from 'mongodb';

/**
 * Every way publishing can fail, classified once — the same discipline
 * `ExecutionFailureCategory` and `GitHubAccessFailureCategory` already
 * established. The first nine are Eligibility categories (unpersisted);
 * the rest are Attempt categories (persisted) — see the module comment.
 */
export type PublishFailureCategory =
  // Eligibility
  | 'execution_not_found'
  | 'execution_not_succeeded'
  | 'review_not_found'
  | 'review_not_approved'
  | 'review_superseded'
  | 'proposal_hash_mismatch'
  | 'repository_access_failure'
  | 'repository_mismatch'
  | 'branch_mismatch'
  // Attempt
  | 'invalid_path'
  | 'unauthorized_file'
  | 'stale_file'
  | 'base_branch_missing'
  | 'base_branch_changed'
  | 'invalid_branch_name'
  | 'branch_conflict'
  | 'tree_creation_failed'
  | 'commit_creation_failed'
  | 'branch_creation_failed'
  | 'push_verification_failed'
  | 'pull_request_creation_failed'
  | 'unexpected_error';

/** The DEFAULT retryability for a category with no more specific information — every category here defaults to non-retryable; the handful backed by a live GitHub call carry their OWN `retryable` explicitly, passed through from the underlying `GitHubAccessFailure`. */
export function isRetryablePublishCategory(_category: PublishFailureCategory): boolean {
  return false;
}

export interface PublishSuccess {
  readonly ok: true;
  readonly runId: ObjectId;
  readonly executionId: ObjectId;
  readonly reviewId: ObjectId;
  readonly owner: string;
  readonly repo: string;
  readonly baseBranch: string;
  readonly branch: string;
  readonly commitSha: string;
  readonly pullRequestNumber: number;
  readonly pullRequestUrl: string;
}

export interface PublishFailure {
  readonly ok: false;
  readonly runId: ObjectId;
  /** Null only when the failure occurred before an execution could be resolved at all. */
  readonly executionId: ObjectId | null;
  readonly reviewId: ObjectId | null;
  readonly category: PublishFailureCategory;
  /** Safe for logs and audit details: never a token, key, or file content. */
  readonly message: string;
  readonly retryable: boolean;
}

export type PublishResult = PublishSuccess | PublishFailure;
