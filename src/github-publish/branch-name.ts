/**
 * Deterministic AISDLC branch naming and safety.
 *
 * Deterministic and unique BY CONSTRUCTION: `aisdlc/<runId hex>/<executionId
 * hex>` derives entirely from two already-unique MongoDB ObjectIds, never
 * from anything an LLM or a human supplies — the same "generated, not
 * accepted as input" discipline `originalContentHash` uses in
 * coding-agent/changes.ts. Two calls for the SAME execution always produce
 * the SAME branch name, which is exactly what makes
 * `publish-service.ts`'s "does this branch already exist" idempotency
 * check meaningful.
 *
 * `validateBranchName` is defence in depth on top of that construction
 * guarantee — a conservative, hand-written git ref-name validator (this
 * project has no git binary to ask), reusing the same "reject, never
 * normalize" philosophy `coding-agent/path-safety.ts` established for file
 * paths. It is never expected to reject a name `generateBranchName`
 * itself produced; it exists for the same reason `local-apply.ts`
 * re-checks path safety even on content the Coding Agent already
 * validated once.
 */

import type { ObjectId } from 'mongodb';

const AISDLC_BRANCH_PREFIX = 'aisdlc/';

/** `aisdlc/<runId hex>/<executionId hex>` — see the module comment for why this is safe to treat as globally unique. */
export function generateBranchName(runId: ObjectId, executionId: ObjectId): string {
  return `${AISDLC_BRANCH_PREFIX}${runId.toHexString()}/${executionId.toHexString()}`;
}

export type BranchNameFailureReason = 'invalid_ref_name' | 'protected_branch';

export interface BranchNameFailure {
  readonly ok: false;
  readonly reason: BranchNameFailureReason;
  readonly message: string;
}

export type BranchNameResult = { readonly ok: true } | BranchNameFailure;

function fail(reason: BranchNameFailureReason, message: string): BranchNameFailure {
  return { ok: false, reason, message };
}

/** Branch names this workflow must never target, regardless of what `baseBranch` names — a last-resort net below the "never named baseBranch" check. */
const ALWAYS_PROTECTED_BRANCH_NAMES = new Set(['main', 'master']);

/** A conservative, git-ref-safe segment: no leading dot/dash, no control/shell-meta characters, no whitespace. */
const SAFE_REF_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Validates a branch name's SHAPE and its relationship to `baseBranch` —
 * never whether it exists on GitHub, which is `getRef`'s job. Rejects,
 * never normalizes.
 */
export function validateBranchName(branch: string, baseBranch: string): BranchNameResult {
  // Checked FIRST, before any structural/shape check below: "this is the
  // base branch" or "this is a conventionally-protected name" is a more
  // specific, more actionable refusal reason than "wrong prefix" — worth
  // surfacing even for an input that also happens to fail shape checks.
  if (branch.toLowerCase() === baseBranch.toLowerCase()) {
    return fail('protected_branch', 'branch name must not equal the base branch');
  }
  if (ALWAYS_PROTECTED_BRANCH_NAMES.has(branch.toLowerCase())) {
    return fail('protected_branch', `'${branch}' is a protected branch name and is never a valid AISDLC publish target`);
  }

  if (branch.trim() === '' || branch !== branch.trim()) {
    return fail('invalid_ref_name', 'branch name is empty or has leading/trailing whitespace');
  }
  if (branch.includes('\0')) return fail('invalid_ref_name', 'branch name contains a NUL byte');
  if (branch.includes('..')) return fail('invalid_ref_name', "branch name contains a '..' sequence");
  if (branch.startsWith('/') || branch.endsWith('/') || branch.includes('//')) {
    return fail('invalid_ref_name', 'branch name has a leading/trailing/doubled slash');
  }
  if (branch.endsWith('.lock')) return fail('invalid_ref_name', "branch name must not end with '.lock'");
  if (branch.includes('\\')) return fail('invalid_ref_name', 'branch name uses a backslash separator, which git refs never accept');

  const segments = branch.split('/');
  for (const segment of segments) {
    if (!SAFE_REF_SEGMENT_PATTERN.test(segment)) {
      return fail('invalid_ref_name', `'${segment}' is not a safe git ref-name segment`);
    }
  }
  if (!branch.startsWith(AISDLC_BRANCH_PREFIX)) {
    return fail('invalid_ref_name', `branch name must start with '${AISDLC_BRANCH_PREFIX}'`);
  }

  return { ok: true };
}
