/**
 * Commit message and pull-request content — pure, offline, and reused
 * nowhere else. Built entirely from data this codebase already has
 * (`ChangeReviewDocument`, `ChangeExecutionDocument`) — no new dependency
 * on `RequirementsRepository` or anything else.
 *
 * SAFE BY CONSTRUCTION. Every field these functions read is either an
 * identifier (an ObjectId's hex string, a file path, an operation name) or
 * a short human-authored plan field (`plan.summary`,
 * `plan.requirementsUnderstanding`) — never `ProposedChange.proposedContent`
 * (a full file body) and never anything from `AuditEntryInput.detail`.
 * `secret-safe content` tests assert this directly.
 */

import type { ObjectId } from 'mongodb';

import type { ChangeReviewDocument } from '../change-execution/review-repository.ts';
import type { ChangeExecutionDocument } from '../change-execution/execution-repository.ts';

/** A conservative subject-line length: leaves room for the `AISDLC: ` prefix under the conventional 72-character limit. */
const SUBJECT_MAX_LENGTH = 72;

function truncate(text: string, maxLength: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export interface PublishIdentifiers {
  readonly runId: ObjectId;
  readonly reviewId: ObjectId;
  readonly executionId: ObjectId;
}

/**
 * One commit containing every approved change. References identifiers
 * only — never file content, matching Section 7's "do not include...
 * unnecessary internal information."
 */
export function buildCommitMessage(review: ChangeReviewDocument, ids: PublishIdentifiers): string {
  const subject = `AISDLC: ${truncate(review.plan.summary, SUBJECT_MAX_LENGTH - 'AISDLC: '.length)}`;
  return [
    subject,
    '',
    `Run: ${ids.runId.toHexString()}`,
    `Review: ${ids.reviewId.toHexString()}`,
    `Execution: ${ids.executionId.toHexString()}`,
    '',
    `${review.proposedChanges.length} file(s) changed.`,
  ].join('\n');
}

export interface PullRequestContent {
  readonly title: string;
  readonly body: string;
}

function validationLine(name: string, result: { readonly ok: boolean; readonly summary: string } | undefined): string {
  if (result === undefined) return `- ${name}: not run`;
  return `- ${name}: ${result.ok ? '✅ passed' : '❌ failed'} — ${result.summary}`;
}

/**
 * Built entirely from `review` (plan, proposed-change paths/operations) and
 * `execution` (applied changes, validation summary) — see the module
 * comment for what is deliberately excluded.
 */
export function buildPullRequestContent(
  review: ChangeReviewDocument,
  execution: ChangeExecutionDocument,
  ids: PublishIdentifiers,
): PullRequestContent {
  const title = `AISDLC: ${truncate(review.plan.summary, 100)}`;

  const changedFiles = execution.appliedChanges.length > 0 ? execution.appliedChanges : review.proposedChanges.map((c) => ({ path: c.filePath, operation: c.operation }));

  const body = [
    '## Summary',
    review.plan.requirementsUnderstanding,
    '',
    '## Implemented changes',
    ...changedFiles.map((c) => `- \`${c.operation}\`: \`${c.path}\``),
    '',
    '## Validation results',
    validationLine('Tests', execution.validation?.tests),
    validationLine('Typecheck', execution.validation?.typecheck),
    validationLine('Build', execution.validation?.build),
    '',
    '## AISDLC references',
    `- Run: \`${ids.runId.toHexString()}\``,
    `- Review: \`${ids.reviewId.toHexString()}\``,
    `- Execution: \`${ids.executionId.toHexString()}\``,
    '',
    '---',
    '_Generated through the approved AISDLC workflow: Coding Agent → Human Review → Local Execution → Local Validation → this pull request. Merge remains a human-controlled decision._',
  ].join('\n');

  return { title, body };
}
