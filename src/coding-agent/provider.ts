/**
 * The Coding Agent's LLM/provider abstraction.
 *
 * Mirrors `github-app/client.ts`'s shape deliberately: a `CodingAgentProvider`
 * interface, every method returning a Result rather than throwing, and one
 * mock implementation in this file plus one real implementation in
 * openai-provider.ts — the same "interface, mock, real" split already used
 * throughout this codebase (`GitHubAppClient`/`mock-client.ts`/`real-client.ts`,
 * `RepositoryRegistryRepository`, `AuditLog`).
 *
 * WHAT THE PROVIDER RECEIVES: `RepositoryContext` (owner/repo/branch/files —
 * see types.ts) and a `RequirementsResult`. Neither carries a credential of
 * any kind — `RepositoryContext` has no token field, by construction, not
 * by convention. openai-provider.ts's prompt-building is covered by a test
 * that asserts the built request never contains anything token-, JWT- or
 * key-shaped.
 */

import type { RequirementsResult } from '../requirements/analyzer.ts';
import type { ImplementationPlan, ProposedChangeOperation, RepositoryContext } from './types.ts';

/**
 * Every way calling the provider can fail, classified once — the same
 * shape `GitHubAccessFailureKind` already established for GitHub calls,
 * because a provider call has the same failure modes: an auth problem, a
 * rate limit, a timeout, a transient error, or a response that is not the
 * shape asked for.
 */
export type CodingAgentProviderFailureKind =
  | 'authentication_failed'
  | 'rate_limited'
  | 'timeout'
  | 'transient'
  | 'malformed'
  | 'unexpected_error';

/** Whether another attempt could plausibly succeed. */
export function isProviderFailureRetryable(kind: CodingAgentProviderFailureKind): boolean {
  return kind === 'rate_limited' || kind === 'timeout' || kind === 'transient';
}

export interface CodingAgentProviderFailure {
  readonly ok: false;
  readonly kind: CodingAgentProviderFailureKind;
  /** Safe for logs: never carries an API key or repository content. */
  readonly message: string;
  readonly retryAfterMs?: number;
}

/**
 * A plan item exactly as the provider proposed it, before this codebase's
 * own hash computation is attached — see changes.ts. The provider is never
 * trusted to compute `originalContentHash` itself.
 */
export type ProviderProposedChange = {
  readonly filePath: string;
  readonly operation: ProposedChangeOperation;
  readonly proposedContent: string;
  readonly reason: string;
  readonly relatedPlanItemId: string;
};

export interface GeneratePlanInput {
  readonly requirements: RequirementsResult;
  readonly context: RepositoryContext;
}

export type GeneratePlanResult = { readonly ok: true; readonly plan: ImplementationPlan } | CodingAgentProviderFailure;

export interface GenerateChangesInput {
  readonly requirements: RequirementsResult;
  readonly context: RepositoryContext;
  readonly plan: ImplementationPlan;
}

export type GenerateChangesResult =
  | { readonly ok: true; readonly changes: readonly ProviderProposedChange[] }
  | CodingAgentProviderFailure;

/**
 * Two separate operations, not one combined call — decision: "the first
 * Coding Agent operation should generate an implementation plan. Do not
 * immediately generate/apply code." A caller (service.ts) validates the
 * plan before ever calling `generateProposedChanges`, so an LLM that
 * produces a nonsensical plan never gets the chance to propose file
 * content at all.
 */
export interface CodingAgentProvider {
  generateImplementationPlan(input: GeneratePlanInput): Promise<GeneratePlanResult>;
  generateProposedChanges(input: GenerateChangesInput): Promise<GenerateChangesResult>;
}

export interface MockCodingAgentProviderConfig {
  readonly planResult?: GeneratePlanResult;
  readonly changesResult?: GenerateChangesResult;
}

/**
 * Deterministic, in-memory `CodingAgentProvider` — the only implementation
 * a test should ever need. Returns exactly the Result objects a test
 * configures, defaulting to a minimal, always-valid plan/changes pair
 * matching whatever `RepositoryContext` it is given, so a test that does
 * not care about plan/change content can still exercise a full successful
 * flow with no configuration at all.
 */
export function createMockCodingAgentProvider(config: MockCodingAgentProviderConfig = {}): CodingAgentProvider {
  return {
    async generateImplementationPlan(input: GeneratePlanInput): Promise<GeneratePlanResult> {
      if (config.planResult !== undefined) return config.planResult;
      const firstFile = input.context.files[0];
      return {
        ok: true,
        plan: {
          summary: `Address: ${input.requirements.summary}`,
          requirementsUnderstanding: input.requirements.problemStatement,
          relevantFiles: firstFile ? [firstFile.path] : [],
          items: firstFile
            ? [
                {
                  id: 'item-1',
                  filePath: firstFile.path,
                  operation: 'modify',
                  changeDescription: 'Mock change description.',
                },
              ]
            : [],
          dependenciesAndImpact: [],
          testsRequired: [],
          assumptions: [],
          risks: [],
        },
      };
    },

    async generateProposedChanges(input: GenerateChangesInput): Promise<GenerateChangesResult> {
      if (config.changesResult !== undefined) return config.changesResult;
      return {
        ok: true,
        changes: input.plan.items.map((item) => ({
          filePath: item.filePath,
          operation: item.operation,
          proposedContent: `// mock proposed content for ${item.filePath}\n`,
          reason: item.changeDescription,
          relatedPlanItemId: item.id,
        })),
      };
    },
  };
}
