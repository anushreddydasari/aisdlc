/**
 * Coding Agent — shared result models and failure taxonomy.
 *
 * This module holds ONLY types and pure mapping functions; every other
 * coding-agent/ file imports from here rather than each defining its own
 * shape, the same "one shared vocabulary" discipline github-access/service.ts
 * established for `GitHubAccessFailureCategory`.
 *
 * READ-ONLY BY DESIGN. Nothing in this module, or anywhere in coding-agent/,
 * writes to GitHub. `ProposedChange` describes a change for a human to
 * review — see docs/coding-agent.md's "Human-review boundary" — it is never
 * applied automatically.
 */

import type { ObjectId } from 'mongodb';

import type { CodingAgentProviderFailureKind } from './provider.ts';

/**
 * The confirmed repository this run's Coding Agent output was produced
 * against. Carries no credential of any kind — see the module comment.
 */
export interface RepositoryContextFile {
  readonly path: string;
  readonly content: string;
}

export interface RepositoryContext {
  readonly repositoryId: string;
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  readonly defaultBranch: string;
  readonly visibility: 'public' | 'private' | 'internal';
  readonly files: readonly RepositoryContextFile[];
}

export type ProposedChangeOperation = 'create' | 'modify';

/**
 * One line item in an implementation plan. Deliberately carries `operation`
 * (create/modify) even though the literal requirement list for a plan did
 * not name it — it is what lets plan validation check "does this file
 * reference make sense" precisely (a `modify` must name a file already in
 * `RepositoryContext`; a `create` must name one that is not), the same
 * check `ProposedChange` needs, reused rather than re-derived — see
 * path-safety.ts's `validateFileReference`.
 */
export interface ImplementationPlanItem {
  readonly id: string;
  readonly filePath: string;
  readonly operation: ProposedChangeOperation;
  readonly changeDescription: string;
}

export interface ImplementationPlan {
  readonly summary: string;
  readonly requirementsUnderstanding: string;
  readonly relevantFiles: readonly string[];
  readonly items: readonly ImplementationPlanItem[];
  readonly dependenciesAndImpact: readonly string[];
  readonly testsRequired: readonly string[];
  readonly assumptions: readonly string[];
  readonly risks: readonly string[];
}

export interface ProposedChange {
  readonly filePath: string;
  readonly operation: ProposedChangeOperation;
  /**
   * sha256 of the ORIGINAL file content, computed by this codebase — never
   * by the LLM, which cannot be trusted to compute a real hash. Null for
   * `create` (no original exists). Required (non-null) for `modify`,
   * enforced by validation — see changes.ts.
   */
  readonly originalContentHash: string | null;
  readonly proposedContent: string;
  readonly reason: string;
  /** Must reference an `ImplementationPlanItem.id` from the same result. */
  readonly relatedPlanItemId: string;
}

export interface CodingAgentInput {
  readonly runId: ObjectId;
  /**
   * Repo-relative candidate paths the caller believes are relevant. There
   * is no repository-tree-listing capability yet (`GitHubAppClient` only
   * reads one already-known path at a time — see github-app/client.ts), so
   * this phase cannot discover relevance on its own; see
   * repository-context.ts's `FileSelectionPolicy` for the deterministic,
   * non-crawling policy applied to this list.
   */
  readonly candidateFilePaths: readonly string[];
}

export interface CodingAgentSuccess {
  readonly ok: true;
  readonly runId: ObjectId;
  readonly intakeItemId: ObjectId;
  readonly repositoryId: string;
  readonly plan: ImplementationPlan;
  readonly proposedChanges: readonly ProposedChange[];
}

/**
 * Every way this service can fail, classified once — the same discipline
 * `GitHubAccessFailureCategory` already established. The first three are
 * OUR OWN validation of the run/requirements/candidate-paths input and
 * never reach a provider or GitHub call.
 *
 * `github_access_failure` always WRAPS its underlying `GitHubAccessFailureCategory`
 * as one category — including a GitHub-side timeout or rate limit — with
 * `retryable`/`retryAfterMs` passed through explicitly (see service.ts's
 * `fail()`); this module does not re-explode that whole taxonomy a second
 * time. `provider_failure` mostly does the same for
 * `CodingAgentProviderFailureKind`, EXCEPT `timeout` and `rate_limited`,
 * which get their own top-level categories here — a caller deciding
 * whether and how long to wait before retrying benefits from knowing
 * "the LLM call was rate limited" specifically, the same reason
 * `rate_limited` is its own category on the GitHub side too, just
 * reached by a different path (unwrapped here, wrapped there — GitHub's
 * own category already carries this distinction one level up, so
 * unwrapping it again for `github_access_failure` would be redundant).
 */
export type CodingAgentFailureCategory =
  | 'invalid_input'
  | 'missing_requirements'
  | 'repository_context_failure'
  | 'github_access_failure'
  | 'provider_failure'
  | 'timeout'
  | 'rate_limited'
  | 'malformed_model_output'
  | 'validation_failure'
  | 'unsafe_proposed_change'
  | 'unexpected_error';

/**
 * The DEFAULT retryability for a category with no more specific
 * information. `github_access_failure` and `provider_failure` override
 * this with the underlying system's own determination (see service.ts's
 * `fail()`), because `provider_failure` alone cannot tell "the API key was
 * rejected" (not retryable) apart from "the connection dropped" (worth
 * retrying) — both collapse to the same category name for a human reading
 * a report, but only one is worth retrying automatically.
 */
export function isRetryableCategory(category: CodingAgentFailureCategory): boolean {
  return category === 'timeout' || category === 'rate_limited';
}

export interface CodingAgentFailure {
  readonly ok: false;
  readonly runId: ObjectId;
  /** Null only when the failure occurred before the intake item could be resolved (e.g. the run itself does not exist). */
  readonly intakeItemId: ObjectId | null;
  /** Null until a repository was confirmed and accessed. */
  readonly repositoryId: string | null;
  readonly category: CodingAgentFailureCategory;
  /** Safe for logs and audit details: never carries a token, key, or file content. */
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}

export type CodingAgentResult = CodingAgentSuccess | CodingAgentFailure;

/**
 * Maps a provider-level failure kind onto this service's own category
 * vocabulary — see provider.ts and the `CodingAgentFailureCategory` doc
 * comment above for why `timeout` and `rate_limited` are unwrapped into
 * their own top-level categories here while everything else collapses to
 * `provider_failure`.
 */
export function mapProviderFailureKind(kind: CodingAgentProviderFailureKind): CodingAgentFailureCategory {
  switch (kind) {
    case 'timeout':
      return 'timeout';
    case 'rate_limited':
      return 'rate_limited';
    case 'authentication_failed':
    case 'transient':
    case 'unexpected_error':
      return 'provider_failure';
    case 'malformed':
      return 'malformed_model_output';
  }
}
