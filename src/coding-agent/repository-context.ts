/**
 * Builds the `RepositoryContext` a Coding Agent run analyzes.
 *
 * Delegates ALL repository access to `GitHubAccessIntegration`
 * (`github-access/service.ts`), unchanged — this module never talks to
 * GitHub, `GitHubAppClient`, or a registry/selection repository directly.
 * That is what makes "the Coding Agent must never select a different
 * repository than the confirmed selection" true by construction: every
 * validation `accessRepositoryForRun` already performs (run readiness,
 * intake approval, human confirmation, live registry/branch checks) is
 * inherited for free, not re-implemented here.
 */

import type { ObjectId } from 'mongodb';

import {
  createGitHubAccessService,
  type GitHubAccessDeps,
  type GitHubAccessFailure,
  type GitHubAccessService,
} from '../github-access/service.ts';
import type { RequirementsResult } from '../requirements/analyzer.ts';
import type { RepositoryContext } from './types.ts';

/** Bounds how many files one run's context may ever include — see `createDefaultFileSelectionPolicy`. */
export const DEFAULT_MAX_CONTEXT_FILES = 25;

export interface FileSelectionInput {
  readonly requirements: RequirementsResult;
  /** Repo-relative candidate paths the caller supplied — see `CodingAgentInput.candidateFilePaths` in types.ts. */
  readonly candidatePaths: readonly string[];
}

/**
 * Chooses which of the candidate paths to actually request through GitHub
 * Access Integration. An explicit, pluggable interface — decision: "if the
 * existing system does not yet define how relevant files are selected,
 * create an explicit interface/policy... keep the first implementation
 * conservative and deterministic."
 */
export interface FileSelectionPolicy {
  /** Deterministic: the same input always produces the same output, in the same order. */
  selectFiles(input: FileSelectionInput): readonly string[];
}

/**
 * The only implementation in this phase. It does not attempt to infer
 * relevance from requirements text — `GitHubAppClient` has no
 * tree-listing capability (only `getFileContents` for an already-known
 * path; see github-app/client.ts), so there is no repository listing to
 * score in the first place, and inventing a heuristic over free text
 * without ANY ground truth to validate it against would be exactly the
 * kind of guess this phase is told to avoid. This policy's job is safety
 * (de-duplicate, bound the count) — real relevance selection is future
 * work for whichever caller eventually has a real signal for it (e.g. the
 * requirements' own `suggestedArea`, once that is wired to something more
 * concrete than free text).
 */
export function createDefaultFileSelectionPolicy(
  options: { readonly maxFiles?: number } = {},
): FileSelectionPolicy {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_CONTEXT_FILES;
  return {
    selectFiles({ candidatePaths }): readonly string[] {
      const unique = [...new Set(candidatePaths.map((p) => p.trim()).filter((p) => p !== ''))].sort();
      return unique.slice(0, maxFiles);
    },
  };
}

export type BuildRepositoryContextResult =
  | { readonly ok: true; readonly context: RepositoryContext }
  | { readonly ok: false; readonly kind: 'github_access_failure'; readonly githubFailure: GitHubAccessFailure }
  | { readonly ok: false; readonly kind: 'no_files_selected'; readonly message: string };

export interface RepositoryContextDeps {
  readonly githubAccess: GitHubAccessService;
  readonly fileSelectionPolicy: FileSelectionPolicy;
}

/** Constructs the deps this module needs directly from GitHubAccessDeps, so a caller does not have to build the service itself. */
export function createRepositoryContextDeps(
  githubAccessDeps: GitHubAccessDeps,
  fileSelectionPolicy: FileSelectionPolicy = createDefaultFileSelectionPolicy(),
): RepositoryContextDeps {
  return { githubAccess: createGitHubAccessService(githubAccessDeps), fileSelectionPolicy };
}

export async function buildRepositoryContext(
  deps: RepositoryContextDeps,
  runId: ObjectId,
  requirements: RequirementsResult,
  candidatePaths: readonly string[],
): Promise<BuildRepositoryContextResult> {
  const selected = deps.fileSelectionPolicy.selectFiles({ requirements, candidatePaths });
  if (selected.length === 0) {
    return { ok: false, kind: 'no_files_selected', message: 'no candidate files were selected for this run' };
  }

  const accessResult = await deps.githubAccess.accessRepositoryForRun(runId, selected);
  if (!accessResult.ok) {
    return { ok: false, kind: 'github_access_failure', githubFailure: accessResult };
  }

  return {
    ok: true,
    context: {
      repositoryId: accessResult.repositoryId,
      owner: accessResult.owner,
      repo: accessResult.repo,
      branch: accessResult.branch,
      defaultBranch: accessResult.defaultBranch,
      visibility: accessResult.visibility,
      files: accessResult.files,
    },
  };
}
