/**
 * Change Execution — shared result models and failure taxonomy.
 *
 * Human Review → Approved Change Execution:
 *
 *   Coding Agent (plan + proposed changes)
 *       ↓  ChangeReviewRepository.createIfAbsent — one immutable row per
 *       ↓  distinct proposal, keyed by a deterministic proposalHash
 *   Human Review
 *       ↓  ChangeReviewRepository.approve / .reject — explicit only; no
 *       ↓  action short of an operator calling approve() ever authorizes
 *       ↓  execution (see review-repository.ts's module comment)
 *   Approved Change Execution
 *       ↓  execution-service.ts: re-verifies repository/branch identity and
 *       ↓  every modified file's content hash against LIVE state, applies
 *       ↓  ONLY the approved changes to a local temp-directory working copy,
 *       ↓  then validates
 *   ExecutionResult
 *
 * NO GITHUB WRITE OPERATIONS ANYWHERE IN THIS MODULE. Nothing here creates a
 * branch, commits, pushes, or opens a pull request — see
 * docs/change-execution.md's "Current limitations". Approved changes are
 * applied to a local, disposable temp-directory working copy and validated
 * there; the real repository is never modified.
 */

import type { ObjectId } from 'mongodb';

import type {
  ImplementationPlan,
  ProposedChange,
  ProposedChangeOperation,
} from '../coding-agent/types.ts';

export type { ImplementationPlan, ProposedChange, ProposedChangeOperation };

/** One file actually written to the local working copy. Never carries content. */
export interface AppliedChange {
  readonly path: string;
  readonly operation: ProposedChangeOperation;
}

export interface ValidationStepResult {
  readonly ok: boolean;
  /** Safe for logs and audit details: a short outcome summary, never full command output. */
  readonly summary: string;
}

export interface ValidationSummary {
  readonly tests: ValidationStepResult;
  readonly typecheck: ValidationStepResult;
  readonly build: ValidationStepResult;
}

/** Whether every required validation step passed — see changes.md's "Do not automatically declare success if any required validation fails". */
export function isValidationSuccessful(validation: ValidationSummary): boolean {
  return validation.tests.ok && validation.typecheck.ok && validation.build.ok;
}

/**
 * Every way execution can fail, classified once — the same discipline
 * `CodingAgentFailureCategory` and `GitHubAccessFailureCategory` already
 * established. `stale_file` and `review_superseded` are this phase's two
 * "never guess, refuse safely" categories: both mean live state has moved
 * since a human made their decision, and execution refuses rather than
 * silently overwriting or reinterpreting an approval for content it no
 * longer describes.
 */
export type ExecutionFailureCategory =
  | 'review_not_found'
  | 'review_not_approved'
  | 'approval_expired'
  | 'review_superseded'
  | 'repository_access_failure'
  | 'repository_mismatch'
  | 'branch_mismatch'
  | 'stale_file'
  | 'invalid_path'
  | 'unauthorized_file'
  | 'apply_failed'
  | 'validation_failed'
  | 'unexpected_error';

/** The DEFAULT retryability for a category with no more specific information — mirrors `isRetryableCategory` in coding-agent/types.ts. */
export function isRetryableExecutionCategory(category: ExecutionFailureCategory): boolean {
  return category === 'repository_access_failure';
}

export interface ExecutionSuccess {
  readonly ok: true;
  readonly runId: ObjectId;
  readonly reviewId: ObjectId;
  readonly proposalHash: string;
  readonly appliedChanges: readonly AppliedChange[];
  readonly validation: ValidationSummary;
}

export interface ExecutionFailure {
  readonly ok: false;
  readonly runId: ObjectId;
  /** Null only when the failure occurred before a review could be resolved at all (e.g. no such review). */
  readonly reviewId: ObjectId | null;
  readonly proposalHash: string | null;
  readonly category: ExecutionFailureCategory;
  /** Safe for logs and audit details: never a token, key, or file content. */
  readonly message: string;
  readonly retryable: boolean;
  /**
   * Populated only when files were actually written to the local working
   * copy before a later step failed (i.e. `validation_failed`) — empty for
   * every earlier failure category, since a pre-flight or apply failure
   * leaves no working copy behind at all (see local-apply.ts's atomicity).
   */
  readonly appliedChanges: readonly AppliedChange[];
  /** Populated only for `validation_failed`. */
  readonly validation: ValidationSummary | null;
}

export type ExecutionResult = ExecutionSuccess | ExecutionFailure;
