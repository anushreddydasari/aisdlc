/**
 * Triggers the Coding Agent for a confirmed run and records its output as a
 * pending change review — the bridge between "GitHub Access / Coding
 * Agent" and "Human Change Review" in the pipeline diagram.
 *
 * NOT a scheduler-polled worker, deliberately. `CodingAgentInput.candidateFilePaths`
 * has no automatic source — coding-agent/repository-context.ts's own
 * documented limitation is "there is no repository-tree-listing
 * capability yet... candidateFilePaths is supplied by the caller." A blind
 * poller would have nothing truthful to supply. This function is invoked
 * once, explicitly, by an operator (see api/coding-agent.ts) who supplies
 * the paths — the same "a human decision this codebase does not invent an
 * automatic answer for" posture already documented for that limitation.
 * A future phase that adds real file-discovery would only need to change
 * the CALLER of this function, not this function itself.
 *
 * `CodingAgentSuccess` carries no owner/repo/branch (deliberately — see
 * its own module comment). `authorizeRepositoryAccess` (github-app/access.ts)
 * is reused, not reimplemented, to obtain them from the run's confirmed
 * selection — the same function `github-publish/publish-service.ts`
 * already reuses for the identical reason.
 */

import type { ObjectId } from 'mongodb';

import type { ChangeReviewDocument, ChangeReviewRepository } from '../change-execution/review-repository.ts';
import type { CodingAgentService } from '../coding-agent/service.ts';
import { isRetryable } from '../github-app/client.ts';
import { authorizeRepositoryAccess } from '../github-app/access.ts';
import type { GitHubAppClient } from '../github-app/client.ts';
import type { Logger } from '../logging/logger.ts';
import type { RepositoryRegistryRepository } from '../repository-registry/repository.ts';
import type { RepositorySelectionRepository } from '../repository-selection/repository.ts';

export type TriggerCodingAgentFailureCategory = 'repository_access_failure' | 'coding_agent_failure';

export interface TriggerCodingAgentSuccess {
  readonly ok: true;
  readonly review: ChangeReviewDocument;
  /** False when an identical proposal already had a review row — see ChangeReviewRepository.createIfAbsent. */
  readonly created: boolean;
}

export interface TriggerCodingAgentFailure {
  readonly ok: false;
  readonly category: TriggerCodingAgentFailureCategory;
  readonly message: string;
  readonly retryable: boolean;
}

export type TriggerCodingAgentResult = TriggerCodingAgentSuccess | TriggerCodingAgentFailure;

export interface TriggerCodingAgentDeps {
  readonly codingAgent: CodingAgentService;
  readonly reviews: ChangeReviewRepository;
  readonly selections: RepositorySelectionRepository;
  readonly registry: RepositoryRegistryRepository;
  readonly client: GitHubAppClient;
  readonly logger: Logger;
}

export async function triggerCodingAgent(
  deps: TriggerCodingAgentDeps,
  runId: ObjectId,
  candidateFilePaths: readonly string[],
): Promise<TriggerCodingAgentResult> {
  const { codingAgent, reviews, selections, registry, client, logger } = deps;

  const selection = await selections.findByRunId(runId);
  if (selection === null) {
    return { ok: false, category: 'repository_access_failure', message: 'no repository selection exists for this run', retryable: false };
  }
  const authorized = await authorizeRepositoryAccess({ registry, client, logger }, selection);
  if (!authorized.ok) {
    return { ok: false, category: 'repository_access_failure', message: authorized.message, retryable: isRetryable(authorized.kind) };
  }

  const result = await codingAgent.run({ runId, candidateFilePaths });
  if (!result.ok) {
    return { ok: false, category: 'coding_agent_failure', message: result.message, retryable: result.retryable };
  }

  const { review, created } = await reviews.createIfAbsent({
    runId: result.runId,
    intakeItemId: result.intakeItemId,
    repositoryId: result.repositoryId,
    owner: authorized.owner,
    repo: authorized.repo,
    branch: authorized.branch,
    plan: result.plan,
    proposedChanges: result.proposedChanges,
  });

  return { ok: true, review, created };
}
