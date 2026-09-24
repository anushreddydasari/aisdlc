/**
 * Path and file-reference safety for the Coding Agent.
 *
 * Every path the LLM proposes — in an implementation-plan item or a
 * proposed change — passes through here before it is accepted into a
 * `CodingAgentResult`. On any doubt, this module REFUSES; it never
 * normalizes an unsafe path into a safe one (a `../../etc/passwd`-shaped
 * path is a validation failure, not silently rewritten to `etc/passwd`).
 */

import type { ProposedChangeOperation, RepositoryContextFile } from './types.ts';

export type PathSafetyFailureReason =
  | 'invalid_path'
  | 'absolute_path'
  | 'path_traversal'
  | 'credential_or_secret_file'
  | 'unauthorized_configuration_file';

export interface PathSafetyFailure {
  readonly ok: false;
  readonly reason: PathSafetyFailureReason;
  readonly message: string;
}

export type PathSafetyResult = { readonly ok: true } | PathSafetyFailure;

function fail(reason: PathSafetyFailureReason, message: string): PathSafetyFailure {
  return { ok: false, reason, message };
}

/**
 * Files that must never be proposed for create or modify, regardless of
 * requested scope — the same category `.githooks/pre-commit`'s credential
 * scan protects in this repository's own history. Matched against the
 * whole path, case-insensitively.
 */
const SENSITIVE_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.env(\.[A-Za-z0-9_-]+)?$/i,
  /(^|\/)\.git\//i,
  /\.(pem|key|p12|pfx|jks)$/i,
  /(^|\/)id_rsa\b/i,
  /(^|\/)id_ed25519\b/i,
  /(^|\/)\.ssh\//i,
  /(^|\/)\.aws\//i,
];

/**
 * Configuration this phase deliberately never touches — CI/CD and
 * container/deploy definitions are how a change could reach production
 * infrastructure, and this phase is READ-ONLY analysis, not deployment.
 * Narrower than "everything under .github/", which would also catch
 * ordinary issue/PR templates a future phase might legitimately propose.
 */
const UNAUTHORIZED_CONFIG_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.github\/workflows\//i,
  /(^|\/)Dockerfile(\..+)?$/i,
  /(^|\/)docker-compose(\..+)?\.ya?ml$/i,
];

/** Repo-relative path characters this phase accepts: no backslashes, no control characters, no shell metacharacters. */
const SAFE_PATH_PATTERN = /^[A-Za-z0-9_.\-/]+$/;

/**
 * Validates a repo-relative path's SHAPE and category only — it does not
 * know whether the path exists or belongs to the current
 * `RepositoryContext`; see `validateFileReference` for that.
 */
export function validatePath(path: string): PathSafetyResult {
  if (path.trim() === '' || path !== path.trim()) {
    return fail('invalid_path', 'path is empty or has leading/trailing whitespace');
  }
  if (path.includes('\0')) {
    return fail('invalid_path', 'path contains a NUL byte');
  }
  if (path.includes('://')) {
    return fail('invalid_path', 'path looks like a URL, not a repository-relative path');
  }
  // Checked before the generic backslash rejection below, so a Windows
  // absolute path (which necessarily contains a backslash) is reported by
  // its more specific, more meaningful reason.
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    return fail('absolute_path', 'path must be repository-relative, not absolute');
  }
  if (path.includes('\\')) {
    return fail('invalid_path', 'path uses a backslash separator, which this project never accepts');
  }
  // "outside the repository root" and "../ traversal" are the same
  // structural check for a repo-relative path model: there is no
  // filesystem root to resolve against, only segments. Any `..` segment
  // means the path can only be interpreted as reaching outside the repo.
  if (path.split('/').includes('..')) {
    return fail('path_traversal', "path contains a '..' segment");
  }
  if (!SAFE_PATH_PATTERN.test(path)) {
    return fail('invalid_path', 'path contains characters outside the accepted safe set');
  }
  for (const pattern of SENSITIVE_PATH_PATTERNS) {
    if (pattern.test(path)) return fail('credential_or_secret_file', `'${path}' looks like a credential or secret file`);
  }
  for (const pattern of UNAUTHORIZED_CONFIG_PATTERNS) {
    if (pattern.test(path)) {
      return fail('unauthorized_configuration_file', `'${path}' is CI/CD or deployment configuration, out of scope for this phase`);
    }
  }
  return { ok: true };
}

export type FileReferenceFailureReason =
  | PathSafetyFailureReason
  | 'invalid_operation'
  | 'modify_target_not_in_context'
  | 'create_target_already_exists';

export interface FileReferenceFailure {
  readonly ok: false;
  readonly reason: FileReferenceFailureReason;
  readonly message: string;
}

export type FileReferenceResult = { readonly ok: true } | FileReferenceFailure;

/**
 * The check both plan-item and proposed-change validation share: does this
 * (path, operation) pair make sense against the files this run was
 * actually given? A `modify` must name a file the Coding Agent actually
 * saw; a `create` must name one it did not — creating an already-existing
 * file is a `modify` mis-declared, never accepted as-is.
 */
export function validateFileReference(
  filePath: string,
  operation: ProposedChangeOperation,
  files: readonly RepositoryContextFile[],
): FileReferenceResult {
  const pathResult = validatePath(filePath);
  if (!pathResult.ok) return pathResult;

  if (operation !== 'create' && operation !== 'modify') {
    return { ok: false, reason: 'invalid_operation', message: `unsupported operation '${String(operation)}'` };
  }

  const existing = files.some((f) => f.path === filePath);
  if (operation === 'modify' && !existing) {
    return {
      ok: false,
      reason: 'modify_target_not_in_context',
      message: `'${filePath}' is not among the files this run's repository context includes`,
    };
  }
  if (operation === 'create' && existing) {
    return {
      ok: false,
      reason: 'create_target_already_exists',
      message: `'${filePath}' already exists in this run's repository context; use 'modify' instead`,
    };
  }

  return { ok: true };
}
