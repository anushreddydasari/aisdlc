/**
 * The GitHub Write + Pull Request Workflow service.
 *
 * Validated Local Changes → Create Dedicated Branch → Apply Approved
 * Changes → Verify Changes → Commit → Push → Verify Remote State → Create
 * Pull Request → Human PR Review.
 *
 * IMPORTANT SAFETY RULE. This service never merges anything, and it never
 * runs for anything the human-review/local-execution/local-validation
 * chain has not already fully cleared — see types.ts's module comment for
 * the two-phase eligibility/attempt split this mirrors from
 * change-execution/execution-service.ts.
 *
 * WHY THIS RE-VERIFIES SO MUCH. Every check in Phase 1 (eligibility) is
 * already implied by the mere EXISTENCE of a `succeeded` ChangeExecutionDocument
 * — that could only have been recorded if the review was approved, current,
 * and matched a live, active, correctly-configured repository AT EXECUTION
 * TIME. This service re-verifies all of it anyway, because time has passed
 * since then: the review could have been superseded, the registry entry
 * deactivated, the base branch could have moved, and a "modify" target's
 * live content could have changed again — the same "never guess, refuse
 * safely" posture `change-execution/local-apply.ts` already applies to a
 * single file, extended here to the whole publish boundary.
 *
 * WHY A COMMIT, NOT PER-FILE PUTS. Building one commit via the Git Data API
 * (`getCommit` → `createTree` → `createCommit` → `createBranch`) rather
 * than one Contents-API PUT per file keeps the publish atomic in the same
 * sense `local-apply.ts` is atomic: nothing is externally visible — no
 * branch, no commit anyone can see — until the SINGLE `createBranch` call
 * succeeds. A tree or commit object with no ref pointing at it is simply
 * unreachable garbage if this attempt is abandoned partway through; only
 * `createBranch` (the push) and `createPullRequest` have an externally
 * visible, non-idempotent side effect, which is exactly why those two (and
 * only those two) get reconciliation-before-retry treatment below rather
 * than blind retries — see "PARTIAL FAILURE / RECOVERY" in
 * docs/github-publish.md.
 */

import type { ObjectId } from 'mongodb';

import type { AuditLog } from '../db/audit-log.ts';
import type { Logger } from '../logging/logger.ts';
import type { ChangeReviewDocument, ChangeReviewRepository } from '../change-execution/review-repository.ts';
import type { ChangeExecutionDocument, ChangeExecutionRepository } from '../change-execution/execution-repository.ts';
import { hashFileContent } from '../coding-agent/changes.ts';
import { validatePath } from '../coding-agent/path-safety.ts';
import { authorizeRepositoryAccess } from '../github-app/access.ts';
import { isRetryable, type GitHubAppClient } from '../github-app/client.ts';
import type { RepositoryRegistryRepository } from '../repository-registry/repository.ts';
import type { RepositorySelectionRepository } from '../repository-selection/repository.ts';
import { generateBranchName, validateBranchName } from './branch-name.ts';
import { buildCommitMessage, buildPullRequestContent } from './pr-content.ts';
import { GITHUB_PUBLISH_SYSTEM_ACTOR, type GithubPublicationRepository } from './publish-repository.ts';
import { isRetryablePublishCategory, type PublishFailure, type PublishFailureCategory, type PublishResult } from './types.ts';

export interface PublishDeps {
  readonly reviews: ChangeReviewRepository;
  readonly executions: ChangeExecutionRepository;
  readonly selections: RepositorySelectionRepository;
  readonly registry: RepositoryRegistryRepository;
  readonly client: GitHubAppClient;
  readonly publications: GithubPublicationRepository;
  readonly audit: AuditLog;
  readonly logger: Logger;
}

export interface GithubPublishService {
  publishApprovedChanges(runId: ObjectId, executionId: ObjectId): Promise<PublishResult>;
}

export function createGithubPublishService(deps: PublishDeps): GithubPublishService {
  const { reviews, executions, selections, registry, client, publications, audit, logger } = deps;
  const inFlight = new Map<string, Promise<PublishResult>>();

  function toPublishResult(runId: ObjectId, pub: Awaited<ReturnType<GithubPublicationRepository['findByExecutionId']>>): PublishResult {
    const publication = pub!;
    if (publication.status === 'published') {
      return {
        ok: true,
        runId,
        executionId: publication.executionId,
        reviewId: publication.reviewId,
        owner: publication.owner,
        repo: publication.repo,
        baseBranch: publication.baseBranch,
        branch: publication.branch,
        commitSha: publication.commitSha!,
        pullRequestNumber: publication.pullRequestNumber!,
        pullRequestUrl: publication.pullRequestUrl!,
      };
    }
    const category = publication.failureCategory ?? 'unexpected_error';
    return {
      ok: false,
      runId,
      executionId: publication.executionId,
      reviewId: publication.reviewId,
      category,
      message: publication.failureMessage ?? 'publish failed',
      retryable: isRetryablePublishCategory(category),
    };
  }

  /** Phase 1 (eligibility) refusal: nothing was attempted, nothing is persisted. */
  async function eligibilityFailure(
    runId: ObjectId,
    executionId: ObjectId | null,
    reviewId: ObjectId | null,
    category: PublishFailureCategory,
    message: string,
    retryable = false,
  ): Promise<PublishFailure> {
    logger.child({ runId: runId.toHexString() }).warn('github publish refused before attempting', {
      executionId: executionId?.toHexString() ?? null,
      category,
      message,
    });

    await audit.append({
      actor: GITHUB_PUBLISH_SYSTEM_ACTOR,
      action: 'github.write.failed',
      subjectType: 'run',
      subjectId: runId,
      detail: {
        category,
        retryable,
        ...(executionId === null ? {} : { executionId: executionId.toHexString() }),
        ...(reviewId === null ? {} : { reviewId: reviewId.toHexString() }),
      },
    });

    return { ok: false, runId, executionId, reviewId, category, message, retryable };
  }

  /** Phase 2 (attempt) outcome: always persisted, so a second call never re-attempts. */
  async function recordAttemptFailure(
    runId: ObjectId,
    review: ChangeReviewDocument,
    executionId: ObjectId,
    owner: string,
    repo: string,
    branch: string,
    baseSha: string | null,
    commitSha: string | null,
    category: PublishFailureCategory,
    message: string,
  ): Promise<PublishResult> {
    logger.child({ runId: runId.toHexString() }).warn('github publish attempt failed', {
      executionId: executionId.toHexString(),
      category,
      message,
    });

    const { publication, created } = await publications.createIfAbsent({
      runId,
      reviewId: review._id!,
      executionId,
      owner,
      repo,
      baseBranch: review.branch,
      branch,
      baseSha,
      commitSha,
      status: 'failed',
      pullRequestNumber: null,
      pullRequestUrl: null,
      failureCategory: category,
      failureMessage: message,
    });
    if (!created) return toPublishResult(runId, publication);

    return {
      ok: false,
      runId,
      executionId,
      reviewId: review._id!,
      category,
      message,
      retryable: isRetryablePublishCategory(category),
    };
  }

  async function execute(runId: ObjectId, executionId: ObjectId): Promise<PublishResult> {
    // Fast idempotency path (Section 10): an attempt was already recorded.
    const existing = await publications.findByExecutionId(executionId);
    if (existing !== null) {
      logger.child({ runId: runId.toHexString() }).info('publication already recorded for this execution; returning existing result', {
        executionId: executionId.toHexString(),
      });
      return toPublishResult(runId, existing);
    }

    const execution = await executions.findById(executionId);
    if (execution === null) {
      return eligibilityFailure(runId, executionId, null, 'execution_not_found', `no change execution for id '${executionId.toHexString()}'`);
    }
    if (!execution.runId.equals(runId)) {
      return eligibilityFailure(
        runId,
        executionId,
        execution.reviewId,
        'execution_not_found',
        `execution '${executionId.toHexString()}' does not belong to run '${runId.toHexString()}'`,
      );
    }
    if (execution.status !== 'succeeded') {
      return eligibilityFailure(
        runId,
        executionId,
        execution.reviewId,
        'execution_not_succeeded',
        `execution status is '${execution.status}', not 'succeeded' — local execution and validation must both have passed`,
      );
    }

    const review = await reviews.findById(execution.reviewId);
    if (review === null) {
      return eligibilityFailure(runId, executionId, execution.reviewId, 'review_not_found', `no change review for id '${execution.reviewId.toHexString()}'`);
    }
    if (review.status !== 'approved') {
      return eligibilityFailure(runId, executionId, review._id!, 'review_not_approved', `review status is '${review.status}', not 'approved'`);
    }
    if (execution.proposalHash !== review.proposalHash) {
      return eligibilityFailure(
        runId,
        executionId,
        review._id!,
        'proposal_hash_mismatch',
        'the executed proposal hash does not match the approved review — refusing to publish content that was never actually reviewed',
      );
    }

    const latest = await reviews.findLatestByRunId(runId);
    if (latest === null || !latest._id!.equals(review._id!)) {
      return eligibilityFailure(
        runId,
        executionId,
        review._id!,
        'review_superseded',
        'a newer proposal exists for this run; this approval no longer authorizes publishing',
      );
    }

    // Live re-verification of repository/branch identity and authorization —
    // never trust the review's confirmation-time snapshot. Reuses
    // authorizeRepositoryAccess (github-app/access.ts) directly: the same
    // selection/registry/branch checks github-access/service.ts already
    // relies on, which is also how this service gets an installationId —
    // GitHubAccessService deliberately never exposes one (it is read-only).
    const selection = await selections.findByRunId(runId);
    if (selection === null) {
      return eligibilityFailure(runId, executionId, review._id!, 'repository_access_failure', 'no repository selection exists for this run');
    }
    // Deliberately NOT `{ branch: review.branch }` — that would force
    // authorization of the REVIEWED branch regardless of what the
    // confirmed selection currently says, making `branch_mismatch` below
    // unreachable dead code. Omitting it authorizes the selection's OWN
    // current default branch, so a selection re-confirmed with a
    // different branch since the review was created is exactly what this
    // check catches.
    const authorized = await authorizeRepositoryAccess({ registry, client, logger }, selection);
    if (!authorized.ok) {
      return eligibilityFailure(runId, executionId, review._id!, 'repository_access_failure', authorized.message, isRetryable(authorized.kind));
    }
    if (authorized.owner !== review.owner || authorized.repo !== review.repo) {
      return eligibilityFailure(
        runId,
        executionId,
        review._id!,
        'repository_mismatch',
        `run now resolves to '${authorized.owner}/${authorized.repo}', not the reviewed '${review.owner}/${review.repo}'`,
      );
    }
    if (authorized.branch !== review.branch) {
      return eligibilityFailure(
        runId,
        executionId,
        review._id!,
        'branch_mismatch',
        `run now resolves to branch '${authorized.branch}', not the reviewed '${review.branch}'`,
      );
    }

    return attempt(runId, executionId, execution, review, authorized.installationId, authorized.owner, authorized.repo);
  }

  async function attempt(
    runId: ObjectId,
    executionId: ObjectId,
    execution: ChangeExecutionDocument,
    review: ChangeReviewDocument,
    installationId: number,
    owner: string,
    repo: string,
  ): Promise<PublishResult> {
    const fail = (category: PublishFailureCategory, message: string, branch = '', baseSha: string | null = null, commitSha: string | null = null) =>
      recordAttemptFailure(runId, review, executionId, owner, repo, branch, baseSha, commitSha, category, message);

    await audit.append({
      actor: GITHUB_PUBLISH_SYSTEM_ACTOR,
      action: 'github.write.started',
      subjectType: 'changeExecution',
      subjectId: executionId,
      detail: { runId: runId.toHexString(), reviewId: review._id!.toHexString(), baseBranch: review.branch },
    });

    // Section 6: re-verify path safety and, for every `modify` target, live
    // content one more time — right before publishing, never trusting
    // whatever local-apply.ts already checked earlier in a DIFFERENT phase.
    const files: { path: string; content: string }[] = [];
    for (const change of review.proposedChanges) {
      const pathResult = validatePath(change.filePath);
      if (!pathResult.ok) {
        const category: PublishFailureCategory = pathResult.reason === 'credential_or_secret_file' || pathResult.reason === 'unauthorized_configuration_file' ? 'unauthorized_file' : 'invalid_path';
        return fail(category, pathResult.message);
      }
      if (change.operation === 'modify') {
        const liveResult = await client.getFileContents(installationId, owner, repo, change.filePath, review.branch);
        if (!liveResult.ok) {
          return fail('stale_file', `'${change.filePath}' could not be re-read immediately before publishing: ${liveResult.message}`);
        }
        if (hashFileContent(liveResult.content) !== change.originalContentHash) {
          return fail('stale_file', `'${change.filePath}' has changed since this proposal was executed; refusing to publish a stale change`);
        }
      }
      files.push({ path: change.filePath, content: change.proposedContent });
    }

    const baseRef = await client.getRef(installationId, owner, repo, review.branch);
    if (!baseRef.ok) return fail('base_branch_missing', baseRef.message);
    const baseSha = baseRef.sha;

    const baseCommit = await client.getCommit(installationId, owner, repo, baseSha);
    if (!baseCommit.ok) return fail('tree_creation_failed', baseCommit.message, '', baseSha);

    const tree = await client.createTree(installationId, owner, repo, baseCommit.treeSha, files);
    if (!tree.ok) return fail('tree_creation_failed', tree.message, '', baseSha);

    const message = buildCommitMessage(review, { runId, reviewId: review._id!, executionId });
    const commit = await client.createCommit(installationId, owner, repo, message, tree.sha, [baseSha]);
    if (!commit.ok) return fail('commit_creation_failed', commit.message, '', baseSha);

    // Section 5: stale base branch protection. `baseSha` was read moments
    // ago, above; re-reading it now catches a base branch that moved
    // during THIS publish attempt. Nothing has been made visible yet — the
    // tree and commit objects just built have no ref pointing at them, so
    // stopping here leaves no trace to clean up (see the module comment).
    const recheckedRef = await client.getRef(installationId, owner, repo, review.branch);
    if (!recheckedRef.ok) return fail('base_branch_missing', recheckedRef.message, '', baseSha, commit.sha);
    if (recheckedRef.sha !== baseSha) {
      return fail(
        'base_branch_changed',
        `base branch '${review.branch}' moved from '${baseSha}' to '${recheckedRef.sha}' during publishing; refusing to publish against a newer, unreviewed base`,
        '',
        baseSha,
        commit.sha,
      );
    }

    const branch = generateBranchName(runId, executionId);
    const branchNameCheck = validateBranchName(branch, review.branch);
    if (!branchNameCheck.ok) {
      return fail('invalid_branch_name', branchNameCheck.message, branch, baseSha, commit.sha);
    }

    // A branch at this exact deterministic name should never already exist
    // (idempotency was already checked above, before any attempt began) —
    // if GitHub reports one anyway, it belongs to something else. Refuse
    // rather than guess it is safe to reuse.
    const preflightRef = await client.getRef(installationId, owner, repo, branch);
    if (preflightRef.ok) {
      return fail('branch_conflict', `branch '${branch}' already exists and was not created by this publish attempt`, branch, baseSha, commit.sha);
    }

    const created = await client.createBranch(installationId, owner, repo, branch, commit.sha);
    if (!created.ok) {
      if (created.kind === 'ref_already_exists') {
        return fail('branch_conflict', created.message, branch, baseSha, commit.sha);
      }
      // Ambiguous (timeout/transient) failure: reconcile before giving up —
      // the push may have actually landed. See the module comment.
      const reconciled = await client.getRef(installationId, owner, repo, branch);
      if (!(reconciled.ok && reconciled.sha === commit.sha)) {
        return fail('branch_creation_failed', created.message, branch, baseSha, commit.sha);
      }
    }

    // Verify remote state (Section 4/12): confirm the branch really does
    // point at the commit just built, rather than assuming a 2xx meant that.
    const verifyRef = await client.getRef(installationId, owner, repo, branch);
    if (!verifyRef.ok || verifyRef.sha !== commit.sha) {
      return fail('push_verification_failed', 'the published branch does not point at the expected commit', branch, baseSha, commit.sha);
    }

    await audit.append({
      actor: GITHUB_PUBLISH_SYSTEM_ACTOR,
      action: 'github.branch.created',
      subjectType: 'changeExecution',
      subjectId: executionId,
      detail: { runId: runId.toHexString(), branch, commitSha: commit.sha },
    });

    const { title, body } = buildPullRequestContent(review, execution, { runId, reviewId: review._id!, executionId });
    let pullRequestNumber: number;
    let pullRequestUrl: string;

    const pr = await client.createPullRequest(installationId, owner, repo, { title, body, head: branch, base: review.branch });
    if (pr.ok) {
      pullRequestNumber = pr.number;
      pullRequestUrl = pr.htmlUrl;
    } else if (pr.kind === 'pull_request_already_exists') {
      const found = await client.findPullRequestForBranch(installationId, owner, repo, branch, review.branch);
      if (!found.ok || found.pullRequest === null) {
        return fail('pull_request_creation_failed', pr.message, branch, baseSha, commit.sha);
      }
      pullRequestNumber = found.pullRequest.number;
      pullRequestUrl = found.pullRequest.htmlUrl;
    } else {
      // Ambiguous (timeout/transient) failure: reconcile before giving up.
      const found = await client.findPullRequestForBranch(installationId, owner, repo, branch, review.branch);
      if (!found.ok || found.pullRequest === null) {
        return fail('pull_request_creation_failed', pr.message, branch, baseSha, commit.sha);
      }
      pullRequestNumber = found.pullRequest.number;
      pullRequestUrl = found.pullRequest.htmlUrl;
    }

    await audit.append({
      actor: GITHUB_PUBLISH_SYSTEM_ACTOR,
      action: 'github.pr.created',
      subjectType: 'changeExecution',
      subjectId: executionId,
      detail: { runId: runId.toHexString(), pullRequestNumber, branch },
    });

    const { publication, created: recorded } = await publications.createIfAbsent({
      runId,
      reviewId: review._id!,
      executionId,
      owner,
      repo,
      baseBranch: review.branch,
      branch,
      baseSha,
      commitSha: commit.sha,
      status: 'published',
      pullRequestNumber,
      pullRequestUrl,
      failureCategory: null,
      failureMessage: null,
    });
    if (!recorded) return toPublishResult(runId, publication);

    logger.child({ runId: runId.toHexString() }).info('github publish succeeded', {
      executionId: executionId.toHexString(),
      branch,
      pullRequestNumber,
    });

    return {
      ok: true,
      runId,
      executionId,
      reviewId: review._id!,
      owner,
      repo,
      baseBranch: review.branch,
      branch,
      commitSha: commit.sha,
      pullRequestNumber,
      pullRequestUrl,
    };
  }

  return {
    async publishApprovedChanges(runId: ObjectId, executionId: ObjectId): Promise<PublishResult> {
      const key = `${runId.toHexString()}:${executionId.toHexString()}`;
      const existing = inFlight.get(key);
      if (existing !== undefined) return existing;

      const promise = (async (): Promise<PublishResult> => {
        try {
          return await execute(runId, executionId);
        } catch (error) {
          logger.error('github publish failed unexpectedly', {
            runId: runId.toHexString(),
            executionId: executionId.toHexString(),
            error,
          });
          return eligibilityFailure(runId, executionId, null, 'unexpected_error', 'an unexpected error occurred');
        }
      })().finally(() => inFlight.delete(key));

      inFlight.set(key, promise);
      return promise;
    },
  };
}
