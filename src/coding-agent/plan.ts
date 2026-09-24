/**
 * Implementation-plan generation and validation.
 *
 * "The first Coding Agent operation should generate an implementation
 * plan. Do not immediately generate/apply code." — this module's job ends
 * at a VALIDATED plan; changes.ts is the only caller allowed to proceed
 * past it, and only with a plan this module has already accepted.
 *
 * Every validation failure here is `malformed` (the provider did not even
 * produce the right shape) or a `validation_failure` (the shape is right,
 * but the content is unusable) — never a silent repair. There is no
 * "best-effort fix up the LLM's output" path anywhere in this file.
 */

import { validateFileReference } from './path-safety.ts';
import type { CodingAgentProvider, GeneratePlanInput as ProviderPlanInput } from './provider.ts';
import type { ImplementationPlan, RepositoryContext } from './types.ts';
import type { RequirementsResult } from '../requirements/analyzer.ts';

export type GenerateImplementationPlanResult =
  | { readonly ok: true; readonly plan: ImplementationPlan }
  | { readonly ok: false; readonly kind: 'provider_failure'; readonly provider: Awaited<ReturnType<CodingAgentProvider['generateImplementationPlan']>> & { ok: false } }
  | { readonly ok: false; readonly kind: 'malformed_model_output'; readonly message: string }
  | { readonly ok: false; readonly kind: 'validation_failure'; readonly message: string };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/**
 * Structural shape checks only — "does this even look like an
 * ImplementationPlan". Content-level checks (file references, scope) are
 * `validatePlanContent` below; keeping them separate makes each failure's
 * `kind` ('malformed_model_output' vs 'validation_failure') honest about
 * which layer actually rejected it.
 */
function isWellShapedPlan(value: unknown): value is ImplementationPlan {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  if (!isNonEmptyString(p['summary'])) return false;
  if (!isNonEmptyString(p['requirementsUnderstanding'])) return false;
  if (!isStringArray(p['relevantFiles'])) return false;
  if (!isStringArray(p['dependenciesAndImpact'])) return false;
  if (!isStringArray(p['testsRequired'])) return false;
  if (!isStringArray(p['assumptions'])) return false;
  if (!isStringArray(p['risks'])) return false;
  if (!Array.isArray(p['items'])) return false;
  for (const item of p['items']) {
    if (typeof item !== 'object' || item === null) return false;
    const i = item as Record<string, unknown>;
    if (!isNonEmptyString(i['id'])) return false;
    if (!isNonEmptyString(i['filePath'])) return false;
    if (i['operation'] !== 'create' && i['operation'] !== 'modify') return false;
    if (!isNonEmptyString(i['changeDescription'])) return false;
  }
  return true;
}

/**
 * Content-level validation, once the shape is already known-good:
 *
 *   - at least one item (an empty plan proposes nothing to review)
 *   - item ids are unique (ProposedChange.relatedPlanItemId must resolve unambiguously)
 *   - every item's (filePath, operation) makes sense against the repository context
 *   - the plan does not reference a path outside its own declared `relevantFiles` ∪
 *     the repository context — a deterministic STRUCTURAL consistency check, not a
 *     semantic judgement of "is this really related to the requirements" (which
 *     would need the LLM's own judgement to verify — see docs/coding-agent.md)
 */
function validatePlanContent(plan: ImplementationPlan, context: RepositoryContext): string | null {
  if (plan.items.length === 0) return 'plan has no items';

  const ids = new Set<string>();
  for (const item of plan.items) {
    if (ids.has(item.id)) return `plan item id '${item.id}' is used more than once`;
    ids.add(item.id);
  }

  const declaredScope = new Set([...plan.relevantFiles, ...context.files.map((f) => f.path)]);
  for (const item of plan.items) {
    const reference = validateFileReference(item.filePath, item.operation, context.files);
    if (!reference.ok) return `plan item '${item.id}': ${reference.message}`;
    if (!declaredScope.has(item.filePath)) {
      return `plan item '${item.id}' references '${item.filePath}', which the plan never declared as relevant`;
    }
  }

  return null;
}

export interface GenerateImplementationPlanDeps {
  readonly provider: CodingAgentProvider;
}

export async function generateImplementationPlan(
  deps: GenerateImplementationPlanDeps,
  requirements: RequirementsResult,
  context: RepositoryContext,
): Promise<GenerateImplementationPlanResult> {
  const input: ProviderPlanInput = { requirements, context };
  const result = await deps.provider.generateImplementationPlan(input);
  if (!result.ok) return { ok: false, kind: 'provider_failure', provider: result };

  if (!isWellShapedPlan(result.plan)) {
    return { ok: false, kind: 'malformed_model_output', message: 'implementation plan is missing required fields' };
  }

  const contentError = validatePlanContent(result.plan, context);
  if (contentError !== null) {
    return { ok: false, kind: 'validation_failure', message: contentError };
  }

  return { ok: true, plan: result.plan };
}
