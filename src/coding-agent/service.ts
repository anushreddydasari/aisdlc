/**
 * The Coding Agent service — the foundation this phase builds.
 *
 * Approved Run → Requirements → Confirmed Repository → GitHub Access
 * Integration → Repository Context → Coding Agent → Repository Analysis →
 * Implementation Plan → Proposed Changes → Validation → Human Review.
 *
 * READ-ONLY. This service never writes to GitHub — see repository-context.ts,
 * which only ever calls `GitHubAccessIntegration.accessRepositoryForRun`
 * (itself read-only). It stops after producing a plan and proposed
 * changes; nothing here applies them. The interfaces in types.ts
 * (`ProposedChange`, `CodingAgentResult`) are exactly the boundary a future
 * phase's human-review-and-apply workflow would consume — this phase
 * defines that boundary but does not cross it.
 *
 * ORDER OF VALIDATION, and why: this service looks up the run itself
 * first (cheaply, via `runs.findById`) ONLY to obtain `intakeItemId`, so a
 * missing-requirements failure can be reported before any GitHub call is
 * made — not to re-validate run readiness, intake approval, or selection
 * confirmation, all of which remain `github-access/service.ts`'s sole
 * authority and are re-checked, live, when `buildRepositoryContext` calls
 * it. This is a deliberate, small overlap (one extra, cheap `runs.findById`)
 * traded for failing fast on a cheap check before an expensive one — the
 * same trade-off `access.ts` already makes when it re-checks the live
 * registry rather than trusting a selection's confirmation-time snapshot.
 *
 * IDEMPOTENCY: no new persisted "coding agent already ran" state — see
 * github-access/service.ts's module comment for the same reasoning,
 * which applies identically here: `repositorySelections.runId`'s
 * uniqueness already means a run has exactly one confirmed repository, so
 * repeated or concurrent execution can only ever reproduce the same
 * analysis, never conflict. Concurrent calls for the same run are
 * de-duplicated in-process, the same `inFlight` map shape
 * github-access/service.ts and token-issuer.ts both already use.
 */

import type { ObjectId } from 'mongodb';

import type { AuditLog } from '../db/audit-log.ts';
import type { Logger } from '../logging/logger.ts';
import type { RunsRepository } from '../orchestrator/repository.ts';
import type { RequirementsRepository } from '../requirements/repository.ts';
import { generateImplementationPlan } from './plan.ts';
import { generateProposedChanges } from './changes.ts';
import { buildRepositoryContext, type RepositoryContextDeps } from './repository-context.ts';
import type { CodingAgentProvider } from './provider.ts';
import { isProviderFailureRetryable } from './provider.ts';
import {
  isRetryableCategory,
  mapProviderFailureKind,
  type CodingAgentFailure,
  type CodingAgentFailureCategory,
  type CodingAgentInput,
  type CodingAgentResult,
} from './types.ts';

/** Recorded as every audit entry's actor. Never a human or another system component's identity. */
export const CODING_AGENT_SYSTEM_ACTOR = 'system:coding-agent';

export interface CodingAgentDeps {
  readonly runs: RunsRepository;
  readonly requirements: RequirementsRepository;
  readonly repositoryContext: RepositoryContextDeps;
  readonly provider: CodingAgentProvider;
  readonly audit: AuditLog;
  readonly logger: Logger;
}

export interface CodingAgentService {
  run(input: CodingAgentInput): Promise<CodingAgentResult>;
}

export function createCodingAgentService(deps: CodingAgentDeps): CodingAgentService {
  const { runs, requirements, repositoryContext, provider, audit, logger } = deps;
  const inFlight = new Map<string, Promise<CodingAgentResult>>();

  async function fail(
    runId: ObjectId,
    intakeItemId: ObjectId | null,
    repositoryId: string | null,
    category: CodingAgentFailureCategory,
    message: string,
    extra: { retryable?: boolean; retryAfterMs?: number } = {},
  ): Promise<CodingAgentFailure> {
    const retryable = extra.retryable ?? isRetryableCategory(category);
    const child = logger.child({ runId: runId.toHexString() });
    child.warn('coding agent failed', { category, retryable, message });

    await audit.append({
      actor: CODING_AGENT_SYSTEM_ACTOR,
      action: 'coding-agent.failed',
      subjectType: 'run',
      subjectId: runId,
      detail: {
        category,
        retryable,
        ...(intakeItemId === null ? {} : { intakeItemId: intakeItemId.toHexString() }),
        ...(repositoryId === null ? {} : { repositoryId }),
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
    };
  }

  async function execute(input: CodingAgentInput): Promise<CodingAgentResult> {
    const { runId, candidateFilePaths } = input;

    await audit.append({
      actor: CODING_AGENT_SYSTEM_ACTOR,
      action: 'coding-agent.started',
      subjectType: 'run',
      subjectId: runId,
      detail: { candidateFilePaths: [...candidateFilePaths] },
    });

    if (candidateFilePaths.length === 0) {
      return fail(runId, null, null, 'invalid_input', 'candidateFilePaths must include at least one path');
    }

    // Obtains intakeItemId cheaply so a missing-requirements failure can be
    // reported before any GitHub call — see the module comment. Run
    // readiness itself is re-checked, authoritatively, inside
    // buildRepositoryContext below.
    const theRun = await runs.findById(runId);
    if (theRun === null) {
      return fail(runId, null, null, 'invalid_input', `no run '${runId.toHexString()}'`);
    }

    const analysis = await requirements.findByIntakeItemId(theRun.intakeItemId);
    if (analysis === null || analysis.status !== 'completed' || analysis.result === null) {
      return fail(
        runId,
        theRun.intakeItemId,
        null,
        'missing_requirements',
        analysis === null
          ? 'no requirements analysis exists for this run\'s intake item'
          : `requirements analysis status is '${analysis.status}', not 'completed'`,
      );
    }
    const requirementsResult = analysis.result;

    const contextResult = await buildRepositoryContext(repositoryContext, runId, requirementsResult, candidateFilePaths);
    if (!contextResult.ok) {
      if (contextResult.kind === 'github_access_failure') {
        const gh = contextResult.githubFailure;
        return fail(runId, gh.intakeItemId, gh.repositoryId, 'github_access_failure', gh.message, {
          retryable: gh.retryable,
          ...(gh.retryAfterMs === undefined ? {} : { retryAfterMs: gh.retryAfterMs }),
        });
      }
      return fail(runId, theRun.intakeItemId, null, 'repository_context_failure', contextResult.message);
    }
    const context = contextResult.context;

    await audit.append({
      actor: CODING_AGENT_SYSTEM_ACTOR,
      action: 'coding-agent.repository-context.created',
      subjectType: 'run',
      subjectId: runId,
      detail: { repositoryId: context.repositoryId, branch: context.branch, fileCount: context.files.length },
    });

    const planResult = await generateImplementationPlan({ provider }, requirementsResult, context);
    if (!planResult.ok) {
      if (planResult.kind === 'provider_failure') {
        const p = planResult.provider;
        return fail(
          runId,
          theRun.intakeItemId,
          context.repositoryId,
          mapProviderFailureKind(p.kind),
          p.message,
          { retryable: isProviderFailureRetryable(p.kind), ...(p.retryAfterMs === undefined ? {} : { retryAfterMs: p.retryAfterMs }) },
        );
      }
      return fail(runId, theRun.intakeItemId, context.repositoryId, planResult.kind, planResult.message);
    }
    const plan = planResult.plan;

    await audit.append({
      actor: CODING_AGENT_SYSTEM_ACTOR,
      action: 'coding-agent.plan.created',
      subjectType: 'run',
      subjectId: runId,
      detail: { repositoryId: context.repositoryId, itemCount: plan.items.length },
    });

    const changesResult = await generateProposedChanges({ provider }, requirementsResult, context, plan);
    if (!changesResult.ok) {
      if (changesResult.kind === 'provider_failure') {
        const p = changesResult.provider;
        return fail(
          runId,
          theRun.intakeItemId,
          context.repositoryId,
          mapProviderFailureKind(p.kind),
          p.message,
          { retryable: isProviderFailureRetryable(p.kind), ...(p.retryAfterMs === undefined ? {} : { retryAfterMs: p.retryAfterMs }) },
        );
      }
      return fail(runId, theRun.intakeItemId, context.repositoryId, changesResult.kind, changesResult.message);
    }
    const proposedChanges = changesResult.changes;

    await audit.append({
      actor: CODING_AGENT_SYSTEM_ACTOR,
      action: 'coding-agent.changes.proposed',
      subjectType: 'run',
      subjectId: runId,
      detail: {
        repositoryId: context.repositoryId,
        changeCount: proposedChanges.length,
        paths: proposedChanges.map((c) => c.filePath),
      },
    });

    logger.child({ runId: runId.toHexString() }).info('coding agent produced a plan and proposed changes', {
      repositoryId: context.repositoryId,
      itemCount: plan.items.length,
      changeCount: proposedChanges.length,
    });

    return {
      ok: true,
      runId,
      intakeItemId: theRun.intakeItemId,
      repositoryId: context.repositoryId,
      plan,
      proposedChanges,
    };
  }

  return {
    async run(input: CodingAgentInput): Promise<CodingAgentResult> {
      const key = input.runId.toHexString();
      const existing = inFlight.get(key);
      if (existing !== undefined) return existing;

      const promise = (async (): Promise<CodingAgentResult> => {
        try {
          return await execute(input);
        } catch (error) {
          logger.error('coding agent failed unexpectedly', { runId: key, error });
          return fail(input.runId, null, null, 'unexpected_error', 'an unexpected error occurred');
        }
      })().finally(() => inFlight.delete(key));

      inFlight.set(key, promise);
      return promise;
    },
  };
}
