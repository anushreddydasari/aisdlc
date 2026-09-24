/**
 * Real `CodingAgentProvider`, backed by OpenAI — mirrors
 * requirements/openai-analyzer.ts's shape closely: `fetch` directly against
 * the Chat Completions API (no SDK — this codebase's established pattern
 * for a single-purpose external client), structured output via a forced,
 * strict function call, an injectable `fetchFn` so tests never reach the
 * network, and an `AbortController`-based timeout.
 *
 * DIFFERS FROM openai-analyzer.ts IN ONE DELIBERATE WAY: every failure is
 * returned as a `CodingAgentProviderFailure` Result, never thrown. The
 * Requirements Agent's analyzer throws because its one caller
 * (requirements/worker.ts) already has a catch-and-mark-failed path that
 * predates this decision; the Coding Agent's failure taxonomy
 * (types.ts's `CodingAgentFailureCategory`) was designed as a discriminated
 * Result from the start — the same shape `github-app/client.ts` and
 * `github-access/service.ts` already use — so this provider matches that
 * convention instead of introducing a throw/catch boundary the rest of
 * this module never needs.
 *
 * SECRET HANDLING: the API key appears only in the `authorization` header,
 * exactly like openai-analyzer.ts — never logged, never included in a
 * returned message. `RepositoryContext` (the only repository data sent)
 * carries no credential field at all — see types.ts.
 */

import type { Logger } from '../logging/logger.ts';
import type {
  CodingAgentProvider,
  CodingAgentProviderFailure,
  CodingAgentProviderFailureKind,
  GenerateChangesInput,
  GenerateChangesResult,
  GeneratePlanInput,
  GeneratePlanResult,
  ProviderProposedChange,
} from './provider.ts';
import type { ImplementationPlan, ImplementationPlanItem, RepositoryContext } from './types.ts';
import type { RequirementsResult } from '../requirements/analyzer.ts';

export const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_TOKENS = 4096;

export const PLAN_TOOL_NAME = 'submit_implementation_plan';
export const CHANGES_TOOL_NAME = 'submit_proposed_changes';

const PLAN_ITEM_SCHEMA = {
  type: 'object',
  required: ['id', 'filePath', 'operation', 'changeDescription'],
  properties: {
    id: { type: 'string', description: "A short, unique identifier for this item, e.g. 'item-1'." },
    filePath: { type: 'string', description: 'A repository-relative path, exactly as given in the repository context.' },
    operation: { type: 'string', enum: ['create', 'modify'] },
    changeDescription: { type: 'string' },
  },
  additionalProperties: false,
} as const;

const PLAN_TOOL_PARAMETERS = {
  type: 'object',
  required: [
    'summary',
    'requirementsUnderstanding',
    'relevantFiles',
    'items',
    'dependenciesAndImpact',
    'testsRequired',
    'assumptions',
    'risks',
  ],
  properties: {
    summary: { type: 'string', description: 'One-paragraph summary of the requested change.' },
    requirementsUnderstanding: { type: 'string', description: 'Your understanding of the requirements, in your own words.' },
    relevantFiles: { type: 'array', items: { type: 'string' }, description: 'Every repository-relative path this plan touches.' },
    items: { type: 'array', items: PLAN_ITEM_SCHEMA },
    dependenciesAndImpact: { type: 'array', items: { type: 'string' } },
    testsRequired: { type: 'array', items: { type: 'string' } },
    assumptions: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
} as const;

export const PLAN_TOOL = {
  type: 'function',
  function: {
    name: PLAN_TOOL_NAME,
    description: 'Submit the structured implementation plan for this change. Call this exactly once.',
    parameters: PLAN_TOOL_PARAMETERS,
    strict: true,
  },
} as const;

const CHANGE_SCHEMA = {
  type: 'object',
  required: ['filePath', 'operation', 'proposedContent', 'reason', 'relatedPlanItemId'],
  properties: {
    filePath: { type: 'string' },
    operation: { type: 'string', enum: ['create', 'modify'] },
    proposedContent: { type: 'string', description: 'The full proposed file content after this change.' },
    reason: { type: 'string' },
    relatedPlanItemId: { type: 'string', description: 'Must match an id from the implementation plan.' },
  },
  additionalProperties: false,
} as const;

const CHANGES_TOOL_PARAMETERS = {
  type: 'object',
  required: ['changes'],
  properties: {
    changes: { type: 'array', items: CHANGE_SCHEMA },
  },
  additionalProperties: false,
} as const;

export const CHANGES_TOOL = {
  type: 'function',
  function: {
    name: CHANGES_TOOL_NAME,
    description: 'Submit the proposed file changes implementing the plan. Call this exactly once.',
    parameters: CHANGES_TOOL_PARAMETERS,
    strict: true,
  },
} as const;

const PLAN_SYSTEM_PROMPT =
  'You are the Coding Agent in an automated software delivery pipeline. You ' +
  'produce a structured implementation plan from approved requirements and a ' +
  'repository context. You do not write final code in this step — only a ' +
  'plan. Reference only file paths that appear in the repository context ' +
  '(for a modify) or that plausibly belong in it (for a create); never ' +
  'invent a path outside the repository, never reference credentials or ' +
  'secrets, never propose CI/CD or deployment configuration changes. You ' +
  'MUST respond by calling the submit_implementation_plan tool exactly once.';

const CHANGES_SYSTEM_PROMPT =
  'You are the Coding Agent, now turning an already-approved implementation ' +
  'plan into proposed file changes. Every change must correspond to exactly ' +
  'one plan item, by id. Do not propose a change for a file or purpose the ' +
  'plan did not already describe. Never propose a change to a credential, ' +
  'secret, or CI/CD/deployment configuration file. You are NOT applying ' +
  'these changes — they will be reviewed by a human before anything is ' +
  'written anywhere. You MUST respond by calling the submit_proposed_changes ' +
  'tool exactly once.';

function buildRepositorySection(context: RepositoryContext): string {
  const lines = [
    `Repository: ${context.owner}/${context.repo} (${context.visibility})`,
    `Branch: ${context.branch}`,
    '',
    'Files:',
  ];
  for (const file of context.files) {
    lines.push(`--- ${file.path} ---`, file.content, '');
  }
  return lines.join('\n');
}

function buildRequirementsSection(requirements: RequirementsResult): string {
  return [
    `Summary: ${requirements.summary}`,
    `Problem statement: ${requirements.problemStatement}`,
    `Functional requirements:\n${requirements.functionalRequirements.map((r) => `- ${r}`).join('\n')}`,
    `Acceptance criteria:\n${requirements.acceptanceCriteria.map((r) => `- ${r}`).join('\n')}`,
  ].join('\n\n');
}

export interface OpenAiCodingAgentProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly logger: Logger;
  readonly timeoutMs?: number;
  readonly maxTokens?: number;
  /** Injectable so tests can mock the API without a network call. */
  readonly fetchFn?: typeof fetch;
}

interface OpenAiToolCall {
  readonly function: { readonly name: string; readonly arguments: string };
}

function isToolCall(value: unknown): value is OpenAiToolCall {
  if (typeof value !== 'object' || value === null) return false;
  const fn = (value as { function?: unknown }).function;
  return (
    typeof fn === 'object' &&
    fn !== null &&
    typeof (fn as { name?: unknown }).name === 'string' &&
    typeof (fn as { arguments?: unknown }).arguments === 'string'
  );
}

function failure(kind: CodingAgentProviderFailureKind, message: string, retryAfterMs?: number): CodingAgentProviderFailure {
  return { ok: false, kind, message, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
}

/** Shared request/response mechanics for both tool calls — status mapping, timeout, tool-call extraction. Returns the raw parsed tool arguments, unvalidated: each caller (plan vs. changes) parses its own shape. */
async function callTool(
  options: OpenAiCodingAgentProviderOptions,
  systemPrompt: string,
  userPrompt: string,
  tool: typeof PLAN_TOOL | typeof CHANGES_TOOL,
): Promise<{ ok: true; args: unknown } | CodingAgentProviderFailure> {
  const { apiKey, model, logger } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const doFetch = options.fetchFn ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await doFetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        // The only place the key appears. Never logged, never returned.
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        tools: [tool],
        tool_choice: { type: 'function', function: { name: tool.function.name } },
      }),
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    logger.error('coding agent llm call failed', { timedOut: aborted, error });
    clearTimeout(timer);
    return aborted ? failure('timeout', `openai request timed out after ${timeoutMs}ms`) : failure('transient', 'openai request failed');
  }
  clearTimeout(timer);

  if (response.status === 401) return failure('authentication_failed', 'openai rejected the API key');
  if (response.status === 429) {
    const retryAfterHeader = response.headers.get('retry-after');
    const retryAfterMs = retryAfterHeader !== null && Number.isFinite(Number(retryAfterHeader)) ? Number(retryAfterHeader) * 1000 : undefined;
    return failure('rate_limited', 'openai rate limited the request', retryAfterMs);
  }
  if (response.status >= 500) return failure('transient', `openai returned ${response.status}`);
  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    logger.error('openai api returned a non-2xx status', { status: response.status, bodyLength: bodyText.length });
    return failure('malformed', `openai api returned ${response.status}`);
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return failure('malformed', 'openai response was not valid JSON');
  }

  const choice = (parsed as { choices?: unknown[] })?.choices?.[0] as
    | { message?: { tool_calls?: unknown[] }; finish_reason?: unknown }
    | undefined;
  const toolCall = choice?.message?.tool_calls?.find(isToolCall);
  if (toolCall === undefined) {
    logger.error('openai response carried no tool call', { finishReason: choice?.finish_reason });
    return failure('malformed', `openai response did not call the ${tool.function.name} tool`);
  }
  if (toolCall.function.name !== tool.function.name) {
    return failure('malformed', `openai called an unexpected tool '${toolCall.function.name}'`);
  }

  try {
    return { ok: true, args: JSON.parse(toolCall.function.arguments) };
  } catch {
    return failure('malformed', 'openai tool call arguments were not valid JSON');
  }
}

/** Narrows parsed tool arguments into ImplementationPlan. Returns null (not a throw) on any defect — the caller turns that into a `malformed` failure. */
function parsePlanArgs(args: unknown): ImplementationPlan | null {
  if (typeof args !== 'object' || args === null) return null;
  const a = args as Record<string, unknown>;
  if (!Array.isArray(a['items'])) return null;
  const items: ImplementationPlanItem[] = [];
  for (const raw of a['items']) {
    if (typeof raw !== 'object' || raw === null) return null;
    const i = raw as Record<string, unknown>;
    if (typeof i['id'] !== 'string' || typeof i['filePath'] !== 'string') return null;
    if (i['operation'] !== 'create' && i['operation'] !== 'modify') return null;
    if (typeof i['changeDescription'] !== 'string') return null;
    items.push({ id: i['id'], filePath: i['filePath'], operation: i['operation'], changeDescription: i['changeDescription'] });
  }
  const strings = (value: unknown): string[] | null => (Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : null);
  const relevantFiles = strings(a['relevantFiles']);
  const dependenciesAndImpact = strings(a['dependenciesAndImpact']);
  const testsRequired = strings(a['testsRequired']);
  const assumptions = strings(a['assumptions']);
  const risks = strings(a['risks']);
  if (
    typeof a['summary'] !== 'string' ||
    typeof a['requirementsUnderstanding'] !== 'string' ||
    relevantFiles === null ||
    dependenciesAndImpact === null ||
    testsRequired === null ||
    assumptions === null ||
    risks === null
  ) {
    return null;
  }
  return { summary: a['summary'], requirementsUnderstanding: a['requirementsUnderstanding'], relevantFiles, items, dependenciesAndImpact, testsRequired, assumptions, risks };
}

function parseChangesArgs(args: unknown): readonly ProviderProposedChange[] | null {
  if (typeof args !== 'object' || args === null) return null;
  const a = args as Record<string, unknown>;
  if (!Array.isArray(a['changes'])) return null;
  const changes: ProviderProposedChange[] = [];
  for (const raw of a['changes']) {
    if (typeof raw !== 'object' || raw === null) return null;
    const c = raw as Record<string, unknown>;
    if (typeof c['filePath'] !== 'string') return null;
    if (c['operation'] !== 'create' && c['operation'] !== 'modify') return null;
    if (typeof c['proposedContent'] !== 'string') return null;
    if (typeof c['reason'] !== 'string') return null;
    if (typeof c['relatedPlanItemId'] !== 'string') return null;
    changes.push({
      filePath: c['filePath'],
      operation: c['operation'],
      proposedContent: c['proposedContent'],
      reason: c['reason'],
      relatedPlanItemId: c['relatedPlanItemId'],
    });
  }
  return changes;
}

export function createOpenAiCodingAgentProvider(options: OpenAiCodingAgentProviderOptions): CodingAgentProvider {
  return {
    async generateImplementationPlan(input: GeneratePlanInput): Promise<GeneratePlanResult> {
      const userPrompt = `${buildRequirementsSection(input.requirements)}\n\n${buildRepositorySection(input.context)}`;
      const result = await callTool(options, PLAN_SYSTEM_PROMPT, userPrompt, PLAN_TOOL);
      if (!result.ok) return result;

      const plan = parsePlanArgs(result.args);
      if (plan === null) return failure('malformed', 'implementation plan tool call arguments were not the expected shape');
      return { ok: true, plan };
    },

    async generateProposedChanges(input: GenerateChangesInput): Promise<GenerateChangesResult> {
      const userPrompt = [
        buildRequirementsSection(input.requirements),
        buildRepositorySection(input.context),
        `Implementation plan:\n${JSON.stringify(input.plan, null, 2)}`,
      ].join('\n\n');
      const result = await callTool(options, CHANGES_SYSTEM_PROMPT, userPrompt, CHANGES_TOOL);
      if (!result.ok) return result;

      const changes = parseChangesArgs(result.args);
      if (changes === null) return failure('malformed', 'proposed changes tool call arguments were not the expected shape');
      return { ok: true, changes };
    },
  };
}
