/**
 * Proposed-change generation and validation.
 *
 * Only ever called with a plan `plan.ts` has already validated — see this
 * module's caller, service.ts. `originalContentHash` is computed HERE, by
 * this codebase, from the actual `RepositoryContext` content — never
 * accepted from the provider, which cannot be trusted to compute a real
 * hash (see provider.ts's `ProviderProposedChange`, which has no hash
 * field at all).
 */

import { createHash } from 'node:crypto';

import { validateFileReference } from './path-safety.ts';
import type { CodingAgentProvider, GenerateChangesInput as ProviderChangesInput, ProviderProposedChange } from './provider.ts';
import type { ImplementationPlan, ProposedChange, RepositoryContext } from './types.ts';
import type { RequirementsResult } from '../requirements/analyzer.ts';

export type GenerateProposedChangesResult =
  | { readonly ok: true; readonly changes: readonly ProposedChange[] }
  | { readonly ok: false; readonly kind: 'provider_failure'; readonly provider: Awaited<ReturnType<CodingAgentProvider['generateProposedChanges']>> & { ok: false } }
  | { readonly ok: false; readonly kind: 'malformed_model_output'; readonly message: string }
  | { readonly ok: false; readonly kind: 'validation_failure'; readonly message: string }
  | { readonly ok: false; readonly kind: 'unsafe_proposed_change'; readonly message: string };

/** sha256 of the raw file content — plain text hashing, not the canonicalized-object hashing intake/hash.ts's `contentHash` is built for. */
export function hashFileContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isWellShapedProviderChange(value: unknown): value is ProviderProposedChange {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  if (!isNonEmptyString(c['filePath'])) return false;
  if (c['operation'] !== 'create' && c['operation'] !== 'modify') return false;
  if (typeof c['proposedContent'] !== 'string') return false;
  if (!isNonEmptyString(c['reason'])) return false;
  if (!isNonEmptyString(c['relatedPlanItemId'])) return false;
  return true;
}

export interface GenerateProposedChangesDeps {
  readonly provider: CodingAgentProvider;
}

export async function generateProposedChanges(
  deps: GenerateProposedChangesDeps,
  requirements: RequirementsResult,
  context: RepositoryContext,
  plan: ImplementationPlan,
): Promise<GenerateProposedChangesResult> {
  const input: ProviderChangesInput = { requirements, context, plan };
  const result = await deps.provider.generateProposedChanges(input);
  if (!result.ok) return { ok: false, kind: 'provider_failure', provider: result };

  if (result.changes.length === 0) {
    return { ok: false, kind: 'malformed_model_output', message: 'no proposed changes were returned' };
  }

  const planItemIds = new Set(plan.items.map((item) => item.id));
  const changes: ProposedChange[] = [];

  for (const raw of result.changes) {
    if (!isWellShapedProviderChange(raw)) {
      return { ok: false, kind: 'malformed_model_output', message: 'a proposed change is missing required fields' };
    }

    if (!planItemIds.has(raw.relatedPlanItemId)) {
      return {
        ok: false,
        kind: 'validation_failure',
        message: `proposed change for '${raw.filePath}' references unknown plan item '${raw.relatedPlanItemId}'`,
      };
    }

    const reference = validateFileReference(raw.filePath, raw.operation, context.files);
    if (!reference.ok) {
      // Every path-safety and file-reference rejection is treated as
      // `unsafe_proposed_change` here, not merely `validation_failure` —
      // decision: an actual code CHANGE proposing to touch a credential
      // file or escape the repository is a safety concern, distinct from
      // a plan ITEM merely naming a bad path (plan.ts's own
      // 'validation_failure', which proposes nothing executable yet).
      return {
        ok: false,
        kind: 'unsafe_proposed_change',
        message: `proposed change for '${raw.filePath}' is unsafe: ${reference.message}`,
      };
    }

    const existingFile = context.files.find((f) => f.path === raw.filePath);
    const originalContentHash = raw.operation === 'modify' ? hashFileContent(existingFile!.content) : null;

    changes.push({
      filePath: raw.filePath,
      operation: raw.operation,
      originalContentHash,
      proposedContent: raw.proposedContent,
      reason: raw.reason,
      relatedPlanItemId: raw.relatedPlanItemId,
    });
  }

  return { ok: true, changes };
}
