/**
 * Proposal integrity hashing.
 *
 * A structured-object hash, not a plain-text one — `intake/hash.ts`'s
 * `contentHash` (order-independent, canonicalized JSON) is the right tool
 * here, the same reason `intake/repository.ts`'s `hashSnapshot` uses it
 * rather than `coding-agent/changes.ts`'s `hashFileContent` (plain sha256,
 * built for a single file's raw text, not a structured plan/changes pair).
 *
 * This hash is what makes "the approval applies to exactly the proposal
 * that will be executed" true: `changeReviews.proposalHash` is uniquely
 * indexed, so a regenerated proposal — even byte-identical plan text with
 * items reordered — either collides with an existing row (same content) or
 * creates a new one (different content), never silently overwrites.
 */

import { contentHash } from '../intake/hash.ts';
import type { ImplementationPlan, ProposedChange } from './types.ts';

/**
 * Deterministic across property insertion order (`contentHash` sorts object
 * keys) but NOT across array order — `plan.items` and `proposedChanges`
 * order is preserved and contributes to the hash, matching how `canonicalize`
 * treats array order as content everywhere else in this codebase.
 */
export function computeProposalHash(
  plan: ImplementationPlan,
  proposedChanges: readonly ProposedChange[],
): string {
  return contentHash({ plan, proposedChanges });
}
