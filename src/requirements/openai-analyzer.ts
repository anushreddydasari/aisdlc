/**
 * LLM-backed Requirements Agent, backed by OpenAI.
 *
 * Same role as analyzeRequirements() in analyzer.ts — turn an intake
 * snapshot into a RequirementsResult — but via a real call to the OpenAI
 * Chat Completions API instead of deterministic string rules. It is a
 * drop-in for RequirementsAgentDeps.analyze in worker.ts, which is why it
 * returns exactly RequirementsResult and throws (never swallows) on
 * failure: worker.ts already catches a throwing analyzer and marks the row
 * `failed` with the error message, so nothing about validation,
 * persistence, retry or duplicate handling needed to change for this.
 *
 * Calls the REST API directly with `fetch`, the same way
 * src/neutara/client.ts does, rather than adding the `openai` SDK — this
 * project's established pattern for a single-purpose external client (one
 * endpoint, one call shape), and it keeps the request/response fully
 * visible and testable with a mocked fetchFn rather than an SDK's internal
 * transport. No new dependency was needed.
 *
 * Structured output via a forced, strict function call: `tool_choice` pins
 * the model to calling `submit_requirements_analysis`, and the function's
 * `parameters` schema is marked `strict: true`, so the arguments OpenAI
 * returns are guaranteed to match the schema shape (every property
 * present, no extras) rather than merely being "probably JSON-shaped" free
 * text. The result is parsed from that guaranteed-shaped tool call, never
 * from prose.
 *
 * The API key is used only in the `authorization` header. It is never
 * logged, never included in a thrown error's message, and never echoed
 * back — the same discipline `neutara/client.ts` holds for its bearer
 * token, and the previous Anthropic analyzer held for its key.
 *
 * Token usage (prompt/completion/total counts — never request or response
 * content) is logged unconditionally, and handed to the optional `onUsage`
 * callback so a caller can persist it — see RequirementsRepository.recordUsage
 * in repository.ts, called separately from the analysis itself so `result`
 * stays exactly RequirementsResult either way.
 */

import type { Logger } from '../logging/logger.ts';
import type { IntakeSnapshot } from '../intake/repository.ts';
import type { RequirementsResult } from './analyzer.ts';
import type { AnalysisUsage } from './repository.ts';

export const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_TOKENS = 2048;

export const REQUIREMENTS_TOOL_NAME = 'submit_requirements_analysis';

/**
 * Strict mode (OpenAI's guaranteed-schema function calling) requires every
 * property to be listed in `required` — there is no "optional" property in
 * strict mode. `suggestedArea` is therefore required but nullable, and the
 * model is instructed to supply `null` rather than omit it.
 */
const REQUIREMENTS_TOOL_PARAMETERS = {
  type: 'object',
  required: [
    'summary',
    'problemStatement',
    'functionalRequirements',
    'acceptanceCriteria',
    'assumptions',
    'risks',
    'suggestedArea',
  ],
  properties: {
    summary: { type: 'string', description: 'One-sentence summary of the ticket.' },
    problemStatement: { type: 'string', description: 'The underlying problem, in your own words.' },
    functionalRequirements: {
      type: 'array',
      items: { type: 'string' },
      description: 'Concrete, testable functional requirements implied by the ticket.',
    },
    acceptanceCriteria: {
      type: 'array',
      items: { type: 'string' },
      description: 'One acceptance criterion per functional requirement, Given/When/Then style.',
    },
    assumptions: {
      type: 'array',
      items: { type: 'string' },
      description: 'Assumptions made because the ticket does not say explicitly.',
    },
    risks: {
      type: 'array',
      items: { type: 'string' },
      description: 'Risks, ambiguities or open questions a reviewer should resolve before coding.',
    },
    suggestedArea: {
      type: ['string', 'null'],
      description:
        'The affected repository or area of the codebase, if it can be inferred. Set to null if it cannot.',
    },
  },
  additionalProperties: false,
} as const;

/** OpenAI's Chat Completions tool envelope, wrapping the schema above. */
export const REQUIREMENTS_TOOL = {
  type: 'function',
  function: {
    name: REQUIREMENTS_TOOL_NAME,
    description:
      'Submit the structured requirements analysis for this ticket. Call this ' +
      'exactly once, with your complete analysis.',
    parameters: REQUIREMENTS_TOOL_PARAMETERS,
    strict: true,
  },
} as const;

const SYSTEM_PROMPT =
  'You are the Requirements Agent in an automated software delivery pipeline. ' +
  'You turn one support/engineering ticket into a structured requirements ' +
  'analysis for a downstream Coding Agent that has not seen the ticket. Be ' +
  'concrete and specific; do not invent requirements the ticket does not ' +
  'support. You MUST respond by calling the submit_requirements_analysis tool ' +
  'exactly once — do not respond with plain text.';

function buildUserPrompt(snapshot: IntakeSnapshot): string {
  const lines = [
    `Title: ${snapshot.title}`,
    `Type: ${snapshot.issueType}`,
    `Priority: ${snapshot.priority ?? '(none)'}`,
    `Project: ${snapshot.project ?? '(none)'}`,
    `Labels: ${snapshot.labels && snapshot.labels.length > 0 ? snapshot.labels.join(', ') : '(none)'}`,
    `Parent ticket: ${snapshot.parentKey ?? '(none)'}`,
    '',
    'Description:',
    snapshot.description,
  ];
  return lines.join('\n');
}

export interface OpenAiAnalyzerOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly logger: Logger;
  readonly timeoutMs?: number;
  readonly maxTokens?: number;
  /** Injectable so tests can mock the API without a network call. */
  readonly fetchFn?: typeof fetch;
  /**
   * Called once per successful response with token usage, so a caller can
   * store it (e.g. RequirementsRepository.recordUsage) without this module
   * knowing anything about Mongo or the requirements-analysis document.
   * Not called when the response carries no usage block.
   */
  readonly onUsage?: (usage: AnalysisUsage) => void;
}

/** Extracts token usage from the raw response body. Never throws — a missing or malformed usage block is not a reason to fail the analysis. */
export function parseUsage(parsed: unknown): AnalysisUsage | null {
  const usage = (parsed as { usage?: unknown })?.usage;
  if (typeof usage !== 'object' || usage === null) return null;

  const record = usage as Record<string, unknown>;
  const promptTokens = record['prompt_tokens'];
  const completionTokens = record['completion_tokens'];
  const totalTokens = record['total_tokens'];

  if (
    typeof promptTokens !== 'number' ||
    typeof completionTokens !== 'number' ||
    typeof totalTokens !== 'number'
  ) {
    return null;
  }

  return { promptTokens, completionTokens, totalTokens };
}

interface OpenAiToolCall {
  readonly id: string;
  readonly type: string;
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

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** Validates and narrows a parsed tool-call argument object into a RequirementsResult. Throws on any defect. */
export function parseToolInput(input: unknown): RequirementsResult {
  if (typeof input !== 'object' || input === null) {
    throw new Error('tool input was not an object');
  }
  const record = input as Record<string, unknown>;

  for (const field of [
    'summary',
    'problemStatement',
    'functionalRequirements',
    'acceptanceCriteria',
    'assumptions',
    'risks',
  ]) {
    if (!(field in record)) throw new Error(`tool input is missing required field '${field}'`);
  }

  if (typeof record['summary'] !== 'string' || record['summary'].trim() === '') {
    throw new Error("tool input field 'summary' must be a non-empty string");
  }
  if (typeof record['problemStatement'] !== 'string' || record['problemStatement'].trim() === '') {
    throw new Error("tool input field 'problemStatement' must be a non-empty string");
  }
  for (const field of ['functionalRequirements', 'acceptanceCriteria', 'assumptions', 'risks']) {
    if (!isStringArray(record[field])) {
      throw new Error(`tool input field '${field}' must be an array of strings`);
    }
  }
  const suggestedAreaRaw = record['suggestedArea'];
  const suggestedArea =
    typeof suggestedAreaRaw === 'string' && suggestedAreaRaw.trim() !== '' ? suggestedAreaRaw : null;

  return {
    summary: record['summary'] as string,
    problemStatement: record['problemStatement'] as string,
    functionalRequirements: record['functionalRequirements'] as string[],
    acceptanceCriteria: record['acceptanceCriteria'] as string[],
    assumptions: record['assumptions'] as string[],
    risks: record['risks'] as string[],
    suggestedArea,
  };
}

/**
 * Builds the analyzer function slotted into RequirementsAgentDeps.analyze.
 * Every failure path throws; nothing here retries — a retry is a fresh call
 * to `npm run requirements:run`, which is already idempotent (see
 * worker.ts's createPending/markFailed flow), so a retry loop inside the
 * client would duplicate logic that already exists one layer up.
 */
export function createLlmRequirementsAnalyzer(
  options: OpenAiAnalyzerOptions,
): (snapshot: IntakeSnapshot) => Promise<RequirementsResult> {
  const { apiKey, model, logger } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const doFetch = options.fetchFn ?? fetch;

  return async (snapshot: IntakeSnapshot): Promise<RequirementsResult> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await doFetch(OPENAI_API_URL, {
        method: 'POST',
        headers: {
          // The only place the key appears. Never logged, never thrown back.
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildUserPrompt(snapshot) },
          ],
          tools: [REQUIREMENTS_TOOL],
          tool_choice: { type: 'function', function: { name: REQUIREMENTS_TOOL_NAME } },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      const message = aborted
        ? `openai request timed out after ${timeoutMs}ms`
        : 'openai request failed';
      logger.error('llm requirements analysis failed', { timedOut: aborted, error });
      throw new Error(message);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // Status only; the body may echo request content back and is not
      // included in the thrown message, only in the structured log.
      const bodyText = await response.text().catch(() => '');
      logger.error('openai api returned a non-2xx status', {
        status: response.status,
        bodyLength: bodyText.length,
      });
      throw new Error(`openai api returned ${response.status}`);
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new Error('openai response was not valid JSON');
    }

    // Logged and handed off regardless of what happens below: even a
    // malformed tool call still consumed tokens worth knowing about. Counts
    // only — never the request or response content.
    const usage = parseUsage(parsed);
    if (usage !== null) {
      logger.info('openai requirements analysis usage', {
        model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
      });
      options.onUsage?.(usage);
    }

    const choice = (parsed as { choices?: unknown[] })?.choices?.[0] as
      | { message?: { tool_calls?: unknown[] }; finish_reason?: unknown }
      | undefined;
    const toolCall = choice?.message?.tool_calls?.find(isToolCall);
    if (toolCall === undefined) {
      logger.error('openai response carried no tool call', {
        finishReason: choice?.finish_reason,
      });
      throw new Error('openai response did not call the requirements tool');
    }
    if (toolCall.function.name !== REQUIREMENTS_TOOL_NAME) {
      throw new Error(`openai called an unexpected tool '${toolCall.function.name}'`);
    }

    let args: unknown;
    try {
      args = JSON.parse(toolCall.function.arguments);
    } catch {
      throw new Error('openai tool call arguments were not valid JSON');
    }

    return parseToolInput(args);
  };
}
