/**
 * Requirements Agent: turns an intake item's snapshot into a structured
 * requirements analysis for the later Coding Agent.
 *
 * This version is a stub (decision: no real LLM call yet). analyzeRequirements()
 * is a pure, deterministic string transform — no network access, no clock
 * read, no randomness — and the only collection this module writes to is
 * `requirementsAnalyses`. `intakeItems` is read-only input; nothing here ever
 * calls a write method on the intake repository.
 *
 * Ordering mirrors src/enrichment/worker.ts's enrichDelivery:
 *
 *   ensure a pending row exists (idempotent) -> validate -> analyze -> store
 *
 * A completed row is only re-analyzed when the intake snapshot's hash has
 * changed since — the same parity `checkpoints.inputHash` gives run resume.
 * Duplicate protection is `requirementsAnalyses.intakeItemId_unique` plus
 * createPending()'s idempotent create.
 */

import type { AuditLog } from '../db/audit-log.ts';
import { hashSnapshot, type IntakeItemDocument, type IntakeSnapshot } from '../intake/repository.ts';
import type { Logger } from '../logging/logger.ts';
import { STUB_ANALYZER_VERSION, analyzeRequirements, type RequirementsResult } from './analyzer.ts';
import { validateSnapshotForRequirements } from './validation.ts';
import type { RequirementsAnalysisDocument, RequirementsRepository } from './repository.ts';

export type RequirementsOutcome =
  | 'completed'
  | 'skipped_up_to_date'
  | 'failed_validation'
  | 'failed_analysis';

export interface RequirementsAgentDeps {
  readonly repository: RequirementsRepository;
  readonly audit: AuditLog;
  readonly logger: Logger;
  readonly now?: () => Date;
  /**
   * Injectable so a real agent replaces only this, not the pipeline around
   * it. May return synchronously (the deterministic stub) or a Promise (an
   * LLM-backed analyzer, e.g. createLlmRequirementsAnalyzer in
   * openai-analyzer.ts) — either is awaited below.
   */
  readonly analyze?: (snapshot: IntakeSnapshot) => RequirementsResult | Promise<RequirementsResult>;
  readonly agentVersion?: string;
}

export interface RequirementsAgentResult {
  readonly outcome: RequirementsOutcome;
  readonly document: RequirementsAnalysisDocument;
}

export async function runRequirementsAgent(
  intakeItem: IntakeItemDocument,
  deps: RequirementsAgentDeps,
): Promise<RequirementsAgentResult> {
  const { repository, audit, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const analyze = deps.analyze ?? analyzeRequirements;
  const agentVersion = deps.agentVersion ?? STUB_ANALYZER_VERSION;

  const intakeItemId = intakeItem._id;
  if (intakeItemId === undefined) {
    throw new TypeError('intake item has no _id; it must be read from the database first');
  }

  const inputHash = hashSnapshot(intakeItem.snapshot);

  const { created, document: pending } = await repository.createPending({
    intakeItemId,
    issueKey: intakeItem.issueKey,
    inputHash,
  });

  if (created) {
    await audit.append({
      actor: 'svc:requirements-agent',
      action: 'requirements.pending',
      subjectType: 'intakeItem',
      subjectId: intakeItemId,
      detail: { issueKey: intakeItem.issueKey },
    });
  }

  if (pending.status === 'completed' && pending.inputHash === inputHash) {
    // Same content already analyzed; re-running would only produce an
    // identical result, so this is a no-op rather than a second write.
    logger.info('requirements analysis already up to date', { issueKey: intakeItem.issueKey });
    return { outcome: 'skipped_up_to_date', document: pending };
  }

  const validation = validateSnapshotForRequirements(intakeItem.snapshot);
  if (!validation.ok) {
    const failed = await repository.markFailed(intakeItemId, {
      message: validation.reason,
      inputHash,
      agentVersion,
      now: now(),
    });
    await audit.append({
      actor: 'svc:requirements-agent',
      action: 'requirements.failed',
      subjectType: 'intakeItem',
      subjectId: intakeItemId,
      detail: { issueKey: intakeItem.issueKey, reason: validation.reason },
    });
    logger.warn('requirements analysis failed validation', {
      issueKey: intakeItem.issueKey,
      reason: validation.reason,
    });
    return { outcome: 'failed_validation', document: failed };
  }

  let result: RequirementsResult;
  try {
    result = await analyze(intakeItem.snapshot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = await repository.markFailed(intakeItemId, {
      message,
      inputHash,
      agentVersion,
      now: now(),
    });
    await audit.append({
      actor: 'svc:requirements-agent',
      action: 'requirements.failed',
      subjectType: 'intakeItem',
      subjectId: intakeItemId,
      detail: { issueKey: intakeItem.issueKey, reason: message },
    });
    logger.error('requirements analysis threw', { issueKey: intakeItem.issueKey, error });
    return { outcome: 'failed_analysis', document: failed };
  }

  const completed = await repository.markCompleted(intakeItemId, {
    result,
    inputHash,
    agentVersion,
    now: now(),
  });
  await audit.append({
    actor: 'svc:requirements-agent',
    action: 'requirements.completed',
    subjectType: 'intakeItem',
    subjectId: intakeItemId,
    detail: { issueKey: intakeItem.issueKey, agentVersion },
  });
  logger.info('requirements analysis completed', { issueKey: intakeItem.issueKey });
  return { outcome: 'completed', document: completed };
}
