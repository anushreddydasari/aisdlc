/**
 * Applies an approved set of proposed changes to a fresh, disposable local
 * working copy — never to the real repository. There is no git clone
 * anywhere in this codebase; "local working copy" is a temp directory this
 * module creates, writes into, and — on any failure — removes completely.
 *
 * TRUST NOTHING FROM THE CODING AGENT'S OWN CONTEXT. Every file this
 * function is about to overwrite (`operation: 'modify'`) is re-verified
 * against `currentFileContents`, which the caller must obtain via a FRESH
 * `GitHubAccessService` read taken immediately before calling this function
 * — never from whatever content the Coding Agent originally saw. If a
 * file's live content hash no longer matches `originalContentHash`, this
 * refuses the entire execution (`stale_file`) rather than silently
 * overwriting a newer change — see docs/change-execution.md's "Stale-file
 * detection".
 *
 * PATH SAFETY IS RE-CHECKED HERE, not merely trusted from when the Coding
 * Agent originally validated it — defence in depth, reusing
 * `coding-agent/path-safety.ts` directly rather than reimplementing it
 * (Section 6's explicit instruction).
 *
 * ATOMICITY (Section 7). Every file is validated BEFORE any file is
 * written: the working directory is only ever created once every proposed
 * change has passed path-safety and stale-hash checks, so a rejected
 * proposal never leaves a partially-written working copy. If a write itself
 * fails partway through (a filesystem error), the whole temp directory is
 * removed before returning failure — no caller ever observes a partially
 * applied working copy.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';

import { hashFileContent } from '../coding-agent/changes.ts';
import { validatePath, type PathSafetyFailureReason } from '../coding-agent/path-safety.ts';
import type { AppliedChange, ProposedChange } from './types.ts';

export type LocalApplyFailureReason = 'invalid_path' | 'unauthorized_file' | 'stale_file' | 'write_failed';

export interface LocalApplyFailure {
  readonly ok: false;
  readonly reason: LocalApplyFailureReason;
  readonly message: string;
  readonly filePath?: string;
}

export interface LocalApplySuccess {
  readonly ok: true;
  /** The temp directory the changes were written into. The caller is responsible for removing it once validation has run. */
  readonly workingDirectory: string;
  readonly appliedChanges: readonly AppliedChange[];
}

export type LocalApplyResult = LocalApplySuccess | LocalApplyFailure;

export interface ApplyChangesLocallyInput {
  readonly runId: string;
  readonly proposedChanges: readonly ProposedChange[];
  /**
   * Live content for every `modify` target, keyed by repo-relative path,
   * read fresh immediately before this call — see the module comment. Not
   * required to include `create` targets (see docs/change-execution.md's
   * "Current limitations" for why a concurrent create-path collision is not
   * detected in this phase).
   */
  readonly currentFileContents: ReadonlyMap<string, string>;
}

function pathSafetyReasonToLocalApplyReason(reason: PathSafetyFailureReason): LocalApplyFailureReason {
  switch (reason) {
    case 'credential_or_secret_file':
    case 'unauthorized_configuration_file':
      return 'unauthorized_file';
    case 'invalid_path':
    case 'absolute_path':
    case 'path_traversal':
      return 'invalid_path';
  }
}

/**
 * Splits a repo-relative path into filesystem segments and rejoins under
 * `root` with the platform separator — `validatePath` already guarantees
 * `path` uses only `/`, contains no `..` segment, and is not absolute, so
 * this join can never escape `root`.
 */
function resolveUnderRoot(root: string, repoRelativePath: string): string {
  return join(root, ...repoRelativePath.split('/'));
}

export async function applyChangesLocally(input: ApplyChangesLocallyInput): Promise<LocalApplyResult> {
  const { proposedChanges, currentFileContents } = input;

  // Pass 1: validate every change BEFORE writing anything, so a rejected
  // proposal never leaves a partially-written working copy behind.
  for (const change of proposedChanges) {
    const pathResult = validatePath(change.filePath);
    if (!pathResult.ok) {
      return {
        ok: false,
        reason: pathSafetyReasonToLocalApplyReason(pathResult.reason),
        message: pathResult.message,
        filePath: change.filePath,
      };
    }

    if (change.operation === 'modify') {
      const liveContent = currentFileContents.get(change.filePath);
      if (liveContent === undefined) {
        return {
          ok: false,
          reason: 'stale_file',
          message: `'${change.filePath}' could not be re-read from the repository immediately before applying; refusing rather than trusting stale Coding Agent context`,
          filePath: change.filePath,
        };
      }
      const liveHash = hashFileContent(liveContent);
      if (liveHash !== change.originalContentHash) {
        return {
          ok: false,
          reason: 'stale_file',
          message: `'${change.filePath}' has changed since this proposal was reviewed (original hash '${change.originalContentHash}', current hash '${liveHash}'); refusing to overwrite`,
          filePath: change.filePath,
        };
      }
    }
  }

  let workingDirectory: string;
  try {
    workingDirectory = await mkdtemp(join(tmpdir(), `aisdlc-change-execution-${input.runId}-`));
  } catch (error) {
    return {
      ok: false,
      reason: 'write_failed',
      message: `failed to create a local working directory: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const applied: AppliedChange[] = [];
  try {
    for (const change of proposedChanges) {
      const destination = resolveUnderRoot(workingDirectory, change.filePath);
      // resolveUnderRoot only ever produces a path under workingDirectory —
      // asserted defensively rather than trusted, in case a future change
      // to validatePath's accepted character set ever widens what reaches here.
      if (!destination.startsWith(workingDirectory + sep) && destination !== workingDirectory) {
        return {
          ok: false,
          reason: 'invalid_path',
          message: `'${change.filePath}' resolved outside the working directory`,
          filePath: change.filePath,
        };
      }
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, change.proposedContent, 'utf8');
      applied.push({ path: change.filePath, operation: change.operation });
    }
  } catch (error) {
    await rm(workingDirectory, { recursive: true, force: true });
    return {
      ok: false,
      reason: 'write_failed',
      message: `failed to write a local working copy: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return { ok: true, workingDirectory, appliedChanges: applied };
}
