/**
 * GitHub Access Integration — the service that connects an approved,
 * confirmed run to real repository content.
 *
 * This is the missing link between two already-complete systems:
 * repository-selection/ (which produces a human-confirmed repository
 * mapping for a run) and github-app/ (which can authenticate to GitHub and
 * read a file, given an authorization decision). Nothing here reimplements
 * either — it validates the run/intake/selection chain itself (work
 * neither existing module owns) and otherwise delegates:
 *
 *   - Repository/branch authorization, URL validation, live registry
 *     re-checks, and installation-token issuance: `authorizeRepositoryAccess`
 *     in github-app/access.ts, unchanged.
 *   - Repository metadata and file reads: `GitHubAppClient`
 *     (github-app/client.ts), unchanged — the mock in this phase, the real
 *     client once a caller supplies one.
 *   - Audit trail: `AuditLog` (db/audit-log.ts), unchanged.
 *
 * READ-ONLY. Nothing here writes to GitHub, creates a branch, commits, or
 * opens a pull request — see docs/github-access-integration.md.
 *
 * WHY THERE IS NO NEW PERSISTED "ACCESS STATUS". `repositorySelections`
 * already has a unique index on `runId`, so a run can only ever have ONE
 * confirmed repository — that uniqueness is what "the same run cannot
 * create multiple conflicting repository-access operations" actually
 * reduces to: two calls for the same run necessarily target the same
 * repository and branch, so they cannot conflict, only duplicate work.
 * Duplicate CONCURRENT work is de-duplicated in-process (see `inFlight`
 * below), the same shape as token-issuer.ts's own de-duplication. Adding a
 * persisted "access already ran" collection would be a second, competing
 * source of truth for run progress — exactly what this phase was told not
 * to introduce — and there is still no consumer (no Coding Agent) whose
 * actual needs would tell us what that state should even look like.
 *
 * WHY THERE IS NO NEW SCHEDULER. This module exports a single callable
 * entry point, `accessRepositoryForRun`, the same shape as
 * `authorizeRepositoryAccess` before it. A background loop that calls it
 * automatically (mirroring orchestrator/scheduler.ts or
 * repository-selection/scheduler.ts) is reasonable future work, but
 * building one now — before the Coding Agent exists to consume a
 * `GitHubAccessResult` — would be scaffolding around a consumer that
 * cannot yet specify what it needs (how to react to a failure, whether to
 * retry, how long to hold results). See docs/github-access-integration.md.
 */

import type { ObjectId } from 'mongodb';

import type { AuditLog } from '../db/audit-log.ts';
import type { Logger } from '../logging/logger.ts';
import type { IntakeRepository } from '../intake/repository.ts';
import type { RunDocument, RunsRepository } from '../orchestrator/repository.ts';
import type { RepositoryRegistryRepository } from '../repository-registry/repository.ts';
import type { RepositorySelectionRepository } from '../repository-selection/repository.ts';
import { authorizeRepositoryAccess } from '../github-app/access.ts';
import type { GitHubAccessFailureKind, GitHubAppClient } from '../github-app/client.ts';

/** Recorded as every audit entry's actor. Never a human or another system component's identity. */
export const GITHUB_ACCESS_SYSTEM_ACTOR = 'system:github-access';

/**
 * A run is only ever eligible for GitHub access while it is in one of
 * these states. `cancelled` and `failed` are terminal-negative; `succeeded`
 * is terminal-positive but this phase has nothing left to do for it (a
 * future Coding Agent re-read would be its own, deliberate decision, not
 * an accidental fallthrough here).
 */
const READY_RUN_STATUSES: readonly RunDocument['status'][] = ['queued', 'running'];

/**
 * Every way this service can fail, classified once so a caller never has
 * to re-derive "should I retry this?" — the same discipline
 * `github-app/client.ts`'s `GitHubAccessFailureKind` already established.
 *
 * The first eight are OUR OWN validation of the run/intake/selection
 * chain — they never reach `authorizeRepositoryAccess` or a GitHub call at
 * all. The rest are `GitHubAccessFailureKind` values, renamed to this
 * service's own vocabulary by `mapGitHubFailureKind` below (never
 * re-derived ad hoc at a second call site — see that function's comment).
 */
export type GitHubAccessFailureCategory =
  | 'run_not_found'
  | 'run_not_ready'
  | 'intake_item_not_found'
  | 'intake_not_approved'
  | 'selection_missing'
  | 'selection_not_confirmed'
  | 'repository_inactive'
  | 'invalid_configuration'
  | 'branch_not_allowed'
  | 'authentication_failure'
  | 'authorization_failure'
  | 'repository_not_found'
  | 'branch_not_found'
  | 'file_not_found'
  | 'rate_limited'
  | 'timeout'
  | 'transient_github_error'
  | 'invalid_response'
  | 'unexpected_redirect'
  | 'unexpected_error';

/** Whether another attempt could plausibly succeed. Only true for conditions that are transient by nature. */
export function isRetryableCategory(category: GitHubAccessFailureCategory): boolean {
  return category === 'rate_limited' || category === 'timeout' || category === 'transient_github_error';
}

/**
 * Maps a `github-app/client.ts` failure onto this service's own category
 * vocabulary. A `switch` with no `default`, so TypeScript refuses to
 * compile if `GitHubAccessFailureKind` ever gains a member this function
 * does not account for — the same exhaustiveness discipline
 * client.test.ts's "covers every failure kind exactly once" test enforces
 * at the other end of this mapping.
 */
export function mapGitHubFailureKind(kind: GitHubAccessFailureKind): GitHubAccessFailureCategory {
  switch (kind) {
    case 'selection_not_confirmed':
      return 'selection_not_confirmed';
    case 'unsupported_repository_url':
      return 'invalid_configuration';
    case 'repository_inactive':
      return 'repository_inactive';
    case 'invalid_installation_configuration':
      return 'invalid_configuration';
    case 'branch_not_allowed':
      return 'branch_not_allowed';
    case 'installation_not_found':
      return 'repository_not_found';
    case 'branch_not_found':
      return 'branch_not_found';
    case 'file_not_found':
      return 'file_not_found';
    case 'authentication_failed':
      return 'authentication_failure';
    case 'insufficient_permission':
      return 'authorization_failure';
    case 'rate_limited':
      return 'rate_limited';
    case 'timeout':
      return 'timeout';
    case 'transient':
      return 'transient_github_error';
    case 'malformed':
      return 'invalid_response';
    case 'unexpected_redirect':
      return 'unexpected_redirect';
    // Write-only kinds (see github-publish/) — structurally unreachable
    // here, since this service never calls a write method. Handled rather
    // than defaulted, so this switch stays exhaustive and total.
    case 'ref_already_exists':
    case 'pull_request_already_exists':
      return 'unexpected_error';
  }
}

export interface GitHubAccessFileResult {
  readonly path: string;
  readonly content: string;
}

export interface GitHubAccessSuccess {
  readonly ok: true;
  readonly runId: ObjectId;
  readonly intakeItemId: ObjectId;
  readonly repositoryId: string;
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  readonly defaultBranch: string;
  readonly visibility: 'public' | 'private' | 'internal';
  readonly files: readonly GitHubAccessFileResult[];
}

export interface GitHubAccessFailure {
  readonly ok: false;
  readonly runId: ObjectId;
  /** Null only when the failure occurred before the intake item could be resolved (e.g. the run itself does not exist). */
  readonly intakeItemId: ObjectId | null;
  /** Null until a repository selection was found — never guessed. */
  readonly repositoryId: string | null;
  readonly category: GitHubAccessFailureCategory;
  /** Safe for logs and audit details: never carries a token, key, or file content. */
  readonly message: string;
  readonly retryable: boolean;
  /** Only meaningful when `category === 'rate_limited'`. */
  readonly retryAfterMs?: number;
  /** The specific path that failed, when the run/repository/branch were all otherwise valid. */
  readonly failedPath?: string;
}

export type GitHubAccessResult = GitHubAccessSuccess | GitHubAccessFailure;

export interface GitHubAccessDeps {
  readonly runs: RunsRepository;
  readonly intake: IntakeRepository;
  readonly selections: RepositorySelectionRepository;
  readonly registry: RepositoryRegistryRepository;
  readonly client: GitHubAppClient;
  readonly audit: AuditLog;
  readonly logger: Logger;
}

export interface GitHubAccessService {
  /**
   * Validates the run, its intake item, and its confirmed repository
   * selection, authorizes GitHub access, and reads `filePaths` at the
   * confirmed branch. `filePaths` is a plain parameter, not a value this
   * service invents: there is no Coding Agent yet to define "the files an
   * AISDLC run needs," so that decision belongs to whatever future caller
   * knows the answer, not to this module.
   *
   * Concurrent calls for the SAME runId share one execution rather than
   * each doing the work independently — see the module comment's
   * "duplicate access" discussion.
   */
  accessRepositoryForRun(runId: ObjectId, filePaths: readonly string[]): Promise<GitHubAccessResult>;
}

export function createGitHubAccessService(deps: GitHubAccessDeps): GitHubAccessService {
  const { runs, intake, selections, registry, client, audit, logger } = deps;
  const inFlight = new Map<string, Promise<GitHubAccessResult>>();

  async function fail(
    runId: ObjectId,
    intakeItemId: ObjectId | null,
    repositoryId: string | null,
    category: GitHubAccessFailureCategory,
    message: string,
    extra: { retryAfterMs?: number; failedPath?: string } = {},
  ): Promise<GitHubAccessFailure> {
    const retryable = isRetryableCategory(category);
    const child = logger.child({ runId: runId.toHexString() });
    child.warn('github access failed', { category, retryable, message });

    await audit.append({
      actor: GITHUB_ACCESS_SYSTEM_ACTOR,
      action: 'github.access.failed',
      subjectType: 'run',
      subjectId: runId,
      detail: {
        category,
        retryable,
        ...(intakeItemId === null ? {} : { intakeItemId: intakeItemId.toHexString() }),
        ...(repositoryId === null ? {} : { repositoryId }),
        ...(extra.failedPath === undefined ? {} : { failedPath: extra.failedPath }),
      },
    });

    return {
      ok: false,
      runId,
      intakeItemId,
      repositoryId,
      category,
      message,
      retryable,
      ...(extra.retryAfterMs === undefined ? {} : { retryAfterMs: extra.retryAfterMs }),
      ...(extra.failedPath === undefined ? {} : { failedPath: extra.failedPath }),
    };
  }

  async function run(runId: ObjectId, filePaths: readonly string[]): Promise<GitHubAccessResult> {
    await audit.append({
      actor: GITHUB_ACCESS_SYSTEM_ACTOR,
      action: 'github.access.started',
      subjectType: 'run',
      subjectId: runId,
      detail: { filePaths: [...filePaths] },
    });

    const theRun = await runs.findById(runId);
    if (theRun === null) {
      return fail(runId, null, null, 'run_not_found', `no run '${runId.toHexString()}'`);
    }

    if (!READY_RUN_STATUSES.includes(theRun.status)) {
      return fail(
        runId,
        theRun.intakeItemId,
        null,
        'run_not_ready',
        `run status is '${theRun.status}', not one of ${READY_RUN_STATUSES.join('/')}`,
      );
    }

    // The canonical lookup is by issueKey (IntakeRepository has no
    // findById); intakeItemId is then cross-checked as a consistency
    // guard, not trusted blindly from the run document alone.
    const item = await intake.findByIssueKey(theRun.issueKey);
    if (item === null || item._id === undefined || !item._id.equals(theRun.intakeItemId)) {
      return fail(
        runId,
        theRun.intakeItemId,
        null,
        'intake_item_not_found',
        `run '${runId.toHexString()}' has no matching, consistent intake item`,
      );
    }
    if (item.status !== 'approved') {
      return fail(runId, theRun.intakeItemId, null, 'intake_not_approved', `intake item status is '${item.status}'`);
    }

    const selection = await selections.findByRunId(runId);
    if (selection === null) {
      return fail(runId, theRun.intakeItemId, null, 'selection_missing', 'no repository selection exists for this run');
    }
    if (selection.status !== 'selected' || selection.confirmedBy === null) {
      return fail(
        runId,
        theRun.intakeItemId,
        selection.selectedRepositoryId,
        'selection_not_confirmed',
        `selection status is '${selection.status}'`,
      );
    }

    const authorized = await authorizeRepositoryAccess({ registry, client, logger }, selection);
    if (!authorized.ok) {
      return fail(
        runId,
        theRun.intakeItemId,
        selection.selectedRepositoryId,
        mapGitHubFailureKind(authorized.kind),
        authorized.message,
        authorized.retryAfterMs === undefined ? {} : { retryAfterMs: authorized.retryAfterMs },
      );
    }

    await audit.append({
      actor: GITHUB_ACCESS_SYSTEM_ACTOR,
      action: 'github.repository.accessed',
      subjectType: 'run',
      subjectId: runId,
      detail: {
        repositoryId: selection.selectedRepositoryId,
        owner: authorized.owner,
        repo: authorized.repo,
        branch: authorized.branch,
      },
    });

    const metadata = await client.getRepositoryMetadata(authorized.installationId, authorized.owner, authorized.repo);
    if (!metadata.ok) {
      return fail(
        runId,
        theRun.intakeItemId,
        selection.selectedRepositoryId,
        mapGitHubFailureKind(metadata.kind),
        metadata.message,
        metadata.retryAfterMs === undefined ? {} : { retryAfterMs: metadata.retryAfterMs },
      );
    }

    const files: GitHubAccessFileResult[] = [];
    for (const path of filePaths) {
      const fileResult = await client.getFileContents(
        authorized.installationId,
        authorized.owner,
        authorized.repo,
        path,
        authorized.branch,
      );
      if (!fileResult.ok) {
        return fail(
          runId,
          theRun.intakeItemId,
          selection.selectedRepositoryId,
          mapGitHubFailureKind(fileResult.kind),
          fileResult.message,
          {
            ...(fileResult.retryAfterMs === undefined ? {} : { retryAfterMs: fileResult.retryAfterMs }),
            failedPath: path,
          },
        );
      }
      files.push({ path, content: fileResult.content });
    }

    // File paths are fine to audit (they are already-authorized source
    // locations, not secret); file CONTENT never appears in an audit
    // detail or a log line — see the module comment.
    await audit.append({
      actor: GITHUB_ACCESS_SYSTEM_ACTOR,
      action: 'github.files.accessed',
      subjectType: 'run',
      subjectId: runId,
      detail: { repositoryId: selection.selectedRepositoryId, fileCount: files.length, paths: filePaths },
    });

    await audit.append({
      actor: GITHUB_ACCESS_SYSTEM_ACTOR,
      action: 'github.access.succeeded',
      subjectType: 'run',
      subjectId: runId,
      detail: { repositoryId: selection.selectedRepositoryId, owner: authorized.owner, repo: authorized.repo, branch: authorized.branch },
    });

    logger.child({ runId: runId.toHexString() }).info('github access succeeded', {
      repositoryId: selection.selectedRepositoryId,
      fileCount: files.length,
    });

    return {
      ok: true,
      runId,
      intakeItemId: theRun.intakeItemId,
      repositoryId: selection.selectedRepositoryId!,
      owner: authorized.owner,
      repo: authorized.repo,
      branch: authorized.branch,
      defaultBranch: metadata.metadata.defaultBranch,
      visibility: metadata.metadata.visibility,
      files,
    };
  }

  return {
    async accessRepositoryForRun(runId: ObjectId, filePaths: readonly string[]): Promise<GitHubAccessResult> {
      const key = runId.toHexString();
      const existing = inFlight.get(key);
      if (existing !== undefined) return existing;

      const promise = (async (): Promise<GitHubAccessResult> => {
        try {
          return await run(runId, filePaths);
        } catch (error) {
          logger.error('github access failed unexpectedly', { runId: key, error });
          return fail(runId, null, null, 'unexpected_error', 'an unexpected error occurred');
        }
      })().finally(() => inFlight.delete(key));

      inFlight.set(key, promise);
      return promise;
    },
  };
}
