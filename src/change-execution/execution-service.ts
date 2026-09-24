/**
 * The Change Execution service — Human Review → Approved Change Execution.
 *
 * IMPORTANT SAFETY RULE. This service never approves anything. It only ever
 * *consumes* a review already moved to `approved` by a human operator via
 * `ChangeReviewRepository.approve` (see review-repository.ts). If approval
 * is missing, rejected, expired, or the proposal has been superseded by a
 * newer one, execution refuses and returns a structured failure — it never
 * applies changes "just in case" or guesses at intent.
 *
 * TWO PHASES, and why the split matters for idempotency (Section 10) and
 * concurrency (Section 11):
 *
 *   1. ELIGIBILITY (unpersisted, freely re-checkable): review lookup,
 *      approval/expiry/supersession checks, and a live repository/branch
 *      identity re-verification. Nothing here has side effects, so a
 *      failure here is recomputed fresh on every call — useful, since a
 *      transient `repository_access_failure` today may legitimately
 *      succeed on a later call.
 *   2. ATTEMPT (persisted via `ChangeExecutionRepository`, idempotent on
 *      reviewId): reading live file content for every `modify` target,
 *      applying to a local working copy, and validating. Once execution
 *      reaches this phase, EVERY outcome — success or failure — is recorded
 *      exactly once. A second call for the same review, at any point after
 *      that, finds the recorded row and returns it without re-reading
 *      files, re-applying anything, or re-running validation.
 *
 * NO GITHUB WRITE OPERATIONS. `access.accessRepositoryForRun` is the only
 * GitHub-facing call this service makes, and it is read-only — see
 * github-access/service.ts. Nothing here creates a branch, commits,
 * pushes, or opens a pull request.
 */

import { rm } from 'node:fs/promises';

import type { ObjectId } from 'mongodb';

import type { AuditLog } from '../db/audit-log.ts';
import type { Logger } from '../logging/logger.ts';
import type { GitHubAccessService } from '../github-access/service.ts';
import { applyChangesLocally } from './local-apply.ts';
import type { ChangeExecutionDocument, ChangeExecutionRepository } from './execution-repository.ts';
import type { ChangeReviewDocument, ChangeReviewRepository } from './review-repository.ts';
import type { ChangeValidationRunner } from './validation.ts';
import {
  isRetryableExecutionCategory,
  isValidationSuccessful,
  type AppliedChange,
  type ExecutionFailure,
  type ExecutionFailureCategory,
  type ExecutionResult,
  type ValidationSummary,
} from './types.ts';

/** Recorded as every audit entry's actor. Never a human or another system component's identity. */
export const CHANGE_EXECUTION_SERVICE_ACTOR = 'system:change-execution';

/**
 * How long an approval remains valid before execution refuses it as
 * `approval_expired`, even though the review row's `status` is still
 * `approved` — see db/collections.ts's `CHANGE_REVIEW_STATUSES` comment for
 * why this is a time-computed check rather than a stored state.
 */
const DEFAULT_APPROVAL_VALIDITY_MS = 24 * 60 * 60 * 1000;

export interface ChangeExecutionDeps {
  readonly reviews: ChangeReviewRepository;
  readonly executions: ChangeExecutionRepository;
  readonly access: GitHubAccessService;
  readonly validation: ChangeValidationRunner;
  readonly audit: AuditLog;
  readonly logger: Logger;
  readonly approvalValidityMs?: number;
  /** Injectable clock, the same shape `github-app/token-issuer.ts` uses — so expiry is deterministic and offline-testable rather than tied to the real wall clock. */
  readonly now?: () => Date;
}

export interface ChangeExecutionService {
  executeApprovedChanges(runId: ObjectId, reviewId: ObjectId): Promise<ExecutionResult>;
}

export function createChangeExecutionService(deps: ChangeExecutionDeps): ChangeExecutionService {
  const { reviews, executions, access, validation, audit, logger } = deps;
  const approvalValidityMs = deps.approvalValidityMs ?? DEFAULT_APPROVAL_VALIDITY_MS;
  const now = deps.now ?? (() => new Date());
  const inFlight = new Map<string, Promise<ExecutionResult>>();

  function toExecutionResult(runId: ObjectId, execution: ChangeExecutionDocument): ExecutionResult {
    if (execution.status === 'succeeded') {
      return {
        ok: true,
        runId,
        reviewId: execution.reviewId,
        proposalHash: execution.proposalHash,
        appliedChanges: execution.appliedChanges,
        validation: execution.validation as ValidationSummary,
      };
    }
    const category = execution.failureCategory ?? 'unexpected_error';
    return {
      ok: false,
      runId,
      reviewId: execution.reviewId,
      proposalHash: execution.proposalHash,
      category,
      message: execution.failureMessage ?? 'execution failed',
      retryable: isRetryableExecutionCategory(category),
      appliedChanges: execution.appliedChanges,
      validation: execution.validation,
    };
  }

  /** Phase 1 (eligibility) refusal: nothing was attempted, nothing is persisted — see the module comment. */
  async function eligibilityFailure(
    runId: ObjectId,
    reviewId: ObjectId | null,
    proposalHash: string | null,
    category: ExecutionFailureCategory,
    message: string,
    retryableOverride?: boolean,
  ): Promise<ExecutionFailure> {
    const retryable = retryableOverride ?? isRetryableExecutionCategory(category);
    logger.child({ runId: runId.toHexString() }).warn('change execution refused before attempting', {
      reviewId: reviewId?.toHexString() ?? null,
      category,
      message,
    });

    await audit.append({
      actor: CHANGE_EXECUTION_SERVICE_ACTOR,
      action: 'change-execution.failed',
      subjectType: 'run',
      subjectId: runId,
      detail: {
        category,
        retryable,
        ...(reviewId === null ? {} : { reviewId: reviewId.toHexString() }),
        ...(proposalHash === null ? {} : { proposalHash }),
      },
    });

    return {
      ok: false,
      runId,
      reviewId,
      proposalHash,
      category,
      message,
      retryable,
      appliedChanges: [],
      validation: null,
    };
  }

  /** Phase 2 (attempt) outcome: always persisted via `executions.createIfAbsent`, so a second call never re-attempts. */
  async function recordAttemptFailure(
    runId: ObjectId,
    review: ChangeReviewDocument,
    category: ExecutionFailureCategory,
    message: string,
    appliedChanges: readonly AppliedChange[] = [],
    validationSummary: ValidationSummary | null = null,
  ): Promise<ExecutionResult> {
    const reviewId = review._id!;
    logger.child({ runId: runId.toHexString() }).warn('change execution attempt failed', {
      reviewId: reviewId.toHexString(),
      category,
      message,
    });

    const { execution, created } = await executions.createIfAbsent({
      runId,
      reviewId,
      proposalHash: review.proposalHash,
      status: 'failed',
      appliedChanges,
      validation: validationSummary,
      failureCategory: category,
      failureMessage: message,
    });
    if (!created) return toExecutionResult(runId, execution);

    return {
      ok: false,
      runId,
      reviewId,
      proposalHash: review.proposalHash,
      category,
      message,
      retryable: isRetryableExecutionCategory(category),
      appliedChanges: [...appliedChanges],
      validation: validationSummary,
    };
  }

  async function execute(runId: ObjectId, reviewId: ObjectId): Promise<ExecutionResult> {
    // Fast idempotency path (Section 10): an attempt was already recorded.
    const existingExecution = await executions.findByReviewId(reviewId);
    if (existingExecution !== null) {
      logger.child({ runId: runId.toHexString() }).info('change execution already recorded for this review; returning existing result', {
        reviewId: reviewId.toHexString(),
      });
      return toExecutionResult(runId, existingExecution);
    }

    const review = await reviews.findById(reviewId);
    if (review === null) {
      return eligibilityFailure(runId, reviewId, null, 'review_not_found', `no change review for id '${reviewId.toHexString()}'`);
    }
    if (!review.runId.equals(runId)) {
      return eligibilityFailure(
        runId,
        reviewId,
        review.proposalHash,
        'review_not_found',
        `review '${reviewId.toHexString()}' does not belong to run '${runId.toHexString()}'`,
      );
    }

    if (review.status === 'rejected') {
      return eligibilityFailure(runId, reviewId, review.proposalHash, 'review_not_approved', 'review was rejected; execution refused');
    }
    if (review.status !== 'approved' || review.reviewedAt === null) {
      return eligibilityFailure(
        runId,
        reviewId,
        review.proposalHash,
        'review_not_approved',
        `review status is '${review.status}', not 'approved'`,
      );
    }

    const approvalAgeMs = now().getTime() - review.reviewedAt.getTime();
    if (approvalAgeMs >= approvalValidityMs) {
      return eligibilityFailure(
        runId,
        reviewId,
        review.proposalHash,
        'approval_expired',
        `approval is ${Math.floor(approvalAgeMs / 1000)}s old, exceeding the ${Math.floor(approvalValidityMs / 1000)}s validity window`,
      );
    }

    const latest = await reviews.findLatestByRunId(runId);
    if (latest === null || !latest._id!.equals(review._id!)) {
      return eligibilityFailure(
        runId,
        reviewId,
        review.proposalHash,
        'review_superseded',
        'a newer proposal exists for this run; this approval no longer authorizes execution',
      );
    }

    // Live re-verification of repository/branch identity — never trust the
    // snapshot taken when the review was created (Section 5, Section 11).
    const identityCheck = await access.accessRepositoryForRun(runId, []);
    if (!identityCheck.ok) {
      return eligibilityFailure(
        runId,
        reviewId,
        review.proposalHash,
        'repository_access_failure',
        identityCheck.message,
        identityCheck.retryable,
      );
    }
    if (identityCheck.owner !== review.owner || identityCheck.repo !== review.repo) {
      return eligibilityFailure(
        runId,
        reviewId,
        review.proposalHash,
        'repository_mismatch',
        `run now resolves to '${identityCheck.owner}/${identityCheck.repo}', not the reviewed '${review.owner}/${review.repo}'`,
      );
    }
    if (identityCheck.branch !== review.branch) {
      return eligibilityFailure(
        runId,
        reviewId,
        review.proposalHash,
        'branch_mismatch',
        `run now resolves to branch '${identityCheck.branch}', not the reviewed '${review.branch}'`,
      );
    }

    // Past this point is Phase 2: every outcome is persisted.
    await audit.append({
      actor: CHANGE_EXECUTION_SERVICE_ACTOR,
      action: 'change-execution.started',
      subjectType: 'changeReview',
      subjectId: reviewId,
      detail: { runId: runId.toHexString(), proposalHash: review.proposalHash },
    });

    const modifyPaths = review.proposedChanges.filter((c) => c.operation === 'modify').map((c) => c.filePath);
    let currentFileContents = new Map<string, string>();
    if (modifyPaths.length > 0) {
      const contentResult = await access.accessRepositoryForRun(runId, modifyPaths);
      if (!contentResult.ok) {
        // A missing modify-target is exactly the "someone deleted/renamed
        // the file since review" staleness case (Section 11); any other
        // GitHub-side failure is reported as its own category.
        const category: ExecutionFailureCategory =
          contentResult.category === 'file_not_found' ? 'stale_file' : 'repository_access_failure';
        return recordAttemptFailure(runId, review, category, contentResult.message);
      }
      currentFileContents = new Map(contentResult.files.map((f) => [f.path, f.content]));
    }

    const applyResult = await applyChangesLocally({
      runId: runId.toHexString(),
      proposedChanges: review.proposedChanges,
      currentFileContents,
    });
    if (!applyResult.ok) {
      const category: ExecutionFailureCategory =
        applyResult.reason === 'invalid_path'
          ? 'invalid_path'
          : applyResult.reason === 'unauthorized_file'
            ? 'unauthorized_file'
            : applyResult.reason === 'stale_file'
              ? 'stale_file'
              : 'apply_failed';
      return recordAttemptFailure(runId, review, category, applyResult.message);
    }

    await audit.append({
      actor: CHANGE_EXECUTION_SERVICE_ACTOR,
      action: 'change-validation.started',
      subjectType: 'changeReview',
      subjectId: reviewId,
      detail: { runId: runId.toHexString(), fileCount: applyResult.appliedChanges.length },
    });

    let validationSummary: ValidationSummary;
    try {
      validationSummary = await validation.run({
        runId: runId.toHexString(),
        workingDirectory: applyResult.workingDirectory,
      });
    } finally {
      // The working copy is disposable staging, never a persistent
      // artifact — removed unconditionally once validation has run.
      await rm(applyResult.workingDirectory, { recursive: true, force: true });
    }

    if (!isValidationSuccessful(validationSummary)) {
      await audit.append({
        actor: CHANGE_EXECUTION_SERVICE_ACTOR,
        action: 'change-validation.failed',
        subjectType: 'changeReview',
        subjectId: reviewId,
        detail: {
          runId: runId.toHexString(),
          testsOk: validationSummary.tests.ok,
          typecheckOk: validationSummary.typecheck.ok,
          buildOk: validationSummary.build.ok,
        },
      });
      // Do NOT automatically declare success if any required validation
      // fails (Section 8) — recorded as a failed execution even though
      // every file was successfully applied to the working copy.
      return recordAttemptFailure(
        runId,
        review,
        'validation_failed',
        'one or more validation steps failed; see the validation summary for detail',
        applyResult.appliedChanges,
        validationSummary,
      );
    }

    await audit.append({
      actor: CHANGE_EXECUTION_SERVICE_ACTOR,
      action: 'change-validation.completed',
      subjectType: 'changeReview',
      subjectId: reviewId,
      detail: { runId: runId.toHexString() },
    });

    const { execution, created } = await executions.createIfAbsent({
      runId,
      reviewId,
      proposalHash: review.proposalHash,
      status: 'succeeded',
      appliedChanges: applyResult.appliedChanges,
      validation: validationSummary,
      failureCategory: null,
      failureMessage: null,
    });
    if (!created) return toExecutionResult(runId, execution);

    logger.child({ runId: runId.toHexString() }).info('change execution succeeded', {
      reviewId: reviewId.toHexString(),
      fileCount: applyResult.appliedChanges.length,
    });

    return {
      ok: true,
      runId,
      reviewId,
      proposalHash: review.proposalHash,
      appliedChanges: applyResult.appliedChanges,
      validation: validationSummary,
    };
  }

  return {
    async executeApprovedChanges(runId: ObjectId, reviewId: ObjectId): Promise<ExecutionResult> {
      const key = `${runId.toHexString()}:${reviewId.toHexString()}`;
      const existing = inFlight.get(key);
      if (existing !== undefined) return existing;

      const promise = (async (): Promise<ExecutionResult> => {
        try {
          return await execute(runId, reviewId);
        } catch (error) {
          logger.error('change execution failed unexpectedly', {
            runId: runId.toHexString(),
            reviewId: reviewId.toHexString(),
            error,
          });
          return eligibilityFailure(runId, reviewId, null, 'unexpected_error', 'an unexpected error occurred', false);
        }
      })().finally(() => inFlight.delete(key));

      inFlight.set(key, promise);
      return promise;
    },
  };
}
