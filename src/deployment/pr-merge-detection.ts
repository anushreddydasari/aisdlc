/**
 * PR merge detection — the bridge between "Pull Request Created" and
 * "Deployment Eligibility" in the pipeline diagram.
 *
 * PR Created → WAIT → Human Reviews → Human Merges → **AISDLC Detects
 * Merge** → Deployment Eligibility.
 *
 * READ-ONLY toward GitHub. The only GitHub call this module makes is
 * `GitHubAppClient.getPullRequest` — there is no merge method anywhere in
 * that interface (see client.ts's module comment) to call even by
 * accident. This module can only ever observe a merge a human already
 * performed through GitHub's own UI; it never causes one.
 *
 * "Do not assume closed means merged" (Section 5). Every branch below
 * reads GitHub's own `merged` boolean explicitly — never inferred from
 * `state === 'closed'` alone, which is exactly the mistake a naive
 * implementation would make.
 *
 * IDENTITY VERIFICATION. Before trusting a `getPullRequest` response, this
 * module confirms the PR's head/base refs match what was actually
 * published (`review-repository.ts`'s snapshot, carried on the
 * publication) — "verify the PR belongs to the correct run/publication"
 * (Section 5). A mismatch is treated as an anomaly worth investigating,
 * never silently proceeded past — the same "never guess, refuse safely"
 * posture every previous phase in this codebase applies.
 */

import type { ObjectId } from 'mongodb';

import type { AuditLog } from '../db/audit-log.ts';
import { authorizeRepositoryAccess } from '../github-app/access.ts';
import { isRetryable, type GitHubAppClient } from '../github-app/client.ts';
import type { Logger } from '../logging/logger.ts';
import type { GithubPublicationDocument, GithubPublicationRepository } from '../github-publish/publish-repository.ts';
import type { RepositoryRegistryRepository } from '../repository-registry/repository.ts';
import type { RepositorySelectionRepository } from '../repository-selection/repository.ts';
import type { DeploymentRepository } from './deployment-repository.ts';

export interface PrMergeDetectionDeps {
  readonly publications: GithubPublicationRepository;
  readonly deployments: DeploymentRepository;
  readonly selections: RepositorySelectionRepository;
  readonly registry: RepositoryRegistryRepository;
  readonly client: GitHubAppClient;
  readonly audit: AuditLog;
  readonly logger: Logger;
}

export interface PrMergeDetectionSummary {
  readonly examined: number;
  readonly merged: number;
  readonly closedUnmerged: number;
  readonly stillOpen: number;
  readonly alreadyRecorded: number;
  readonly failed: number;
}

async function detectOne(deps: PrMergeDetectionDeps, publication: GithubPublicationDocument): Promise<'merged' | 'closed_unmerged' | 'still_open' | 'failed'> {
  const { deployments, selections, registry, client, logger } = deps;
  const publicationId = publication._id;
  if (publicationId === undefined) {
    logger.error('pr merge detection: publication has no _id; skipping');
    return 'failed';
  }
  // Structurally always set for a 'published' row (see the collection's own
  // validator); re-checked rather than asserted, matching this module's
  // "never guess" posture.
  const pullRequestNumber = publication.pullRequestNumber;
  if (pullRequestNumber === null) {
    logger.error('pr merge detection: published row has no pull request number; skipping', { runId: publication.runId.toHexString() });
    return 'failed';
  }

  const selection = await selections.findByRunId(publication.runId);
  if (selection === null) {
    logger.warn('pr merge detection: no repository selection for run; skipping', { runId: publication.runId.toHexString() });
    return 'failed';
  }
  const authorized = await authorizeRepositoryAccess({ registry, client, logger }, selection);
  if (!authorized.ok) {
    logger.warn('pr merge detection: repository access failed; will retry next pass', {
      runId: publication.runId.toHexString(),
      kind: authorized.kind,
      retryable: isRetryable(authorized.kind),
    });
    return 'failed';
  }
  if (authorized.owner !== publication.owner || authorized.repo !== publication.repo) {
    logger.error('pr merge detection: repository identity mismatch; refusing to proceed', {
      runId: publication.runId.toHexString(),
      expected: `${publication.owner}/${publication.repo}`,
      actual: `${authorized.owner}/${authorized.repo}`,
    });
    return 'failed';
  }

  const pr = await client.getPullRequest(authorized.installationId, authorized.owner, authorized.repo, pullRequestNumber);
  if (!pr.ok) {
    logger.warn('pr merge detection: could not read pull request; will retry next pass', {
      runId: publication.runId.toHexString(),
      pullRequestNumber,
      kind: pr.kind,
    });
    return 'failed';
  }

  // Verify the PR belongs to THIS publication — never trust the number alone.
  if (pr.headRef !== publication.branch || pr.baseRef !== publication.baseBranch) {
    logger.error('pr merge detection: PR head/base does not match the published branch; refusing to record anything', {
      runId: publication.runId.toHexString(),
      pullRequestNumber,
      expected: `${publication.branch} -> ${publication.baseBranch}`,
      actual: `${pr.headRef} -> ${pr.baseRef}`,
    });
    return 'failed';
  }

  if (pr.state === 'open') return 'still_open';

  // Closed. Never assumed merged — read GitHub's own boolean.
  if (!pr.merged) {
    await deployments.createIfAbsent({
      runId: publication.runId,
      executionId: publication.executionId,
      publicationId,
      owner: publication.owner,
      repo: publication.repo,
      pullRequestNumber,
      mergeCommitSha: null,
      status: 'closed_unmerged',
    });
    return 'closed_unmerged';
  }

  if (pr.mergeCommitSha === null) {
    logger.error('pr merge detection: GitHub reports merged but no merge commit sha; refusing to record a deployment', {
      runId: publication.runId.toHexString(),
      pullRequestNumber,
    });
    return 'failed';
  }

  await deployments.createIfAbsent({
    runId: publication.runId,
    executionId: publication.executionId,
    publicationId,
    owner: publication.owner,
    repo: publication.repo,
    pullRequestNumber,
    mergeCommitSha: pr.mergeCommitSha,
    status: 'eligible',
  });
  return 'merged';
}

/** One pass over published-but-not-yet-merge-checked publications. Scheduling is the caller's concern — see pipeline/scheduler.ts. */
export async function detectMergedPullRequests(deps: PrMergeDetectionDeps, limit = 25): Promise<PrMergeDetectionSummary> {
  const { publications, deployments, logger } = deps;
  const candidates = await publications.findPublished(limit);

  let merged = 0;
  let closedUnmerged = 0;
  let stillOpen = 0;
  let alreadyRecorded = 0;
  let failed = 0;

  for (const publication of candidates) {
    const publicationId = publication._id;
    if (publicationId === undefined) {
      failed += 1;
      continue;
    }
    const existing = await deployments.findByPublicationId(publicationId);
    if (existing !== null) {
      alreadyRecorded += 1;
      continue;
    }

    try {
      const outcome = await detectOne(deps, publication);
      if (outcome === 'merged') merged += 1;
      else if (outcome === 'closed_unmerged') closedUnmerged += 1;
      else if (outcome === 'still_open') stillOpen += 1;
      else failed += 1;
    } catch (error) {
      failed += 1;
      logger.error('pr merge detection: publication failed unexpectedly', { publicationId: publicationId.toHexString(), error });
    }
  }

  if (candidates.length > 0) {
    logger.info('pr merge detection pass complete', { examined: candidates.length, merged, closedUnmerged, stillOpen, alreadyRecorded, failed });
  }
  return { examined: candidates.length, merged, closedUnmerged, stillOpen, alreadyRecorded, failed };
}
