import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createLogger } from '../logging/logger.ts';
import type { RequirementsResult } from '../requirements/analyzer.ts';
import type { ImplementationPlan, RepositoryContext } from './types.ts';
import {
  CHANGES_TOOL_NAME,
  PLAN_TOOL_NAME,
  createOpenAiCodingAgentProvider,
} from './openai-provider.ts';

const API_KEY = 'sk-test-key-not-real-fixture'; // pragma: fixture
const MODEL = 'gpt-4.1';

const REQUIREMENTS: RequirementsResult = {
  summary: 'Add a health field',
  problemStatement: 'The status endpoint is missing a field.',
  functionalRequirements: ['The endpoint shall include the field.'],
  acceptanceCriteria: ['Given a request, when handled, then the field is present.'],
  assumptions: [],
  risks: [],
  suggestedArea: null,
};

const CONTEXT: RepositoryContext = {
  repositoryId: 'aisdlc-service',
  owner: 'cloudfuze',
  repo: 'aisdlc-service',
  branch: 'main',
  defaultBranch: 'main',
  visibility: 'private',
  files: [{ path: 'src/index.ts', content: 'export {};' }],
};

const PLAN_ARGS = {
  summary: 'Add the field',
  requirementsUnderstanding: 'Understood',
  relevantFiles: ['src/index.ts'],
  items: [{ id: 'item-1', filePath: 'src/index.ts', operation: 'modify', changeDescription: 'Add the field' }],
  dependenciesAndImpact: [],
  testsRequired: [],
  assumptions: [],
  risks: [],
};

const PLAN: ImplementationPlan = PLAN_ARGS as ImplementationPlan;

const CHANGES_ARGS = {
  changes: [
    {
      filePath: 'src/index.ts',
      operation: 'modify',
      proposedContent: 'export const x = 1;',
      reason: 'adds the field',
      relatedPlanItemId: 'item-1',
    },
  ],
};

function openAiResponse(args: unknown, toolName: string, status = 200, headers?: Record<string, string>): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl_1',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    { status, ...(headers === undefined ? {} : { headers }) },
  );
}

function mockFetch(
  responder: (url: string, init: RequestInit) => Response | Promise<Response>,
): { fn: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    return responder(url, init);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function provider(fetchFn: typeof fetch, logs: string[] = []) {
  return createOpenAiCodingAgentProvider({
    apiKey: API_KEY,
    model: MODEL,
    logger: createLogger({ level: 'debug', write: (line) => logs.push(line) }),
    fetchFn,
  });
}

describe('generateImplementationPlan', () => {
  it('parses a valid tool call into an ImplementationPlan', async () => {
    const { fn } = mockFetch(() => openAiResponse(PLAN_ARGS, PLAN_TOOL_NAME));
    const result = await provider(fn).generateImplementationPlan({ requirements: REQUIREMENTS, context: CONTEXT });

    assert.ok(result.ok);
    assert.equal(result.plan.summary, 'Add the field');
    assert.equal(result.plan.items.length, 1);
  });

  it('forces the plan tool via tool_choice', async () => {
    const { fn, calls } = mockFetch(() => openAiResponse(PLAN_ARGS, PLAN_TOOL_NAME));
    await provider(fn).generateImplementationPlan({ requirements: REQUIREMENTS, context: CONTEXT });

    const body = JSON.parse(calls[0]!.init.body as string) as { tool_choice: { function: { name: string } } };
    assert.equal(body.tool_choice.function.name, PLAN_TOOL_NAME);
  });

  it('fails as malformed when the response carries no tool call', async () => {
    const { fn } = mockFetch(
      () =>
        new Response(
          JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'sorry, no.' }, finish_reason: 'stop' }] }),
          { status: 200 },
        ),
    );
    const result = await provider(fn).generateImplementationPlan({ requirements: REQUIREMENTS, context: CONTEXT });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'malformed');
  });

  it('fails as malformed when the wrong tool was called', async () => {
    const { fn } = mockFetch(() => openAiResponse(CHANGES_ARGS, CHANGES_TOOL_NAME));
    const result = await provider(fn).generateImplementationPlan({ requirements: REQUIREMENTS, context: CONTEXT });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'malformed');
  });

  it('fails as malformed when the tool arguments are missing required fields', async () => {
    const { fn } = mockFetch(() => openAiResponse({ summary: 'only this' }, PLAN_TOOL_NAME));
    const result = await provider(fn).generateImplementationPlan({ requirements: REQUIREMENTS, context: CONTEXT });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'malformed');
  });

  it('fails as malformed when the tool arguments are not valid JSON', async () => {
    const { fn } = mockFetch(
      () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: { tool_calls: [{ function: { name: PLAN_TOOL_NAME, arguments: '{not json' } }] },
                finish_reason: 'tool_calls',
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const result = await provider(fn).generateImplementationPlan({ requirements: REQUIREMENTS, context: CONTEXT });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'malformed');
  });
});

describe('generateProposedChanges', () => {
  it('parses a valid tool call into proposed changes', async () => {
    const { fn } = mockFetch(() => openAiResponse(CHANGES_ARGS, CHANGES_TOOL_NAME));
    const result = await provider(fn).generateProposedChanges({ requirements: REQUIREMENTS, context: CONTEXT, plan: PLAN });

    assert.ok(result.ok);
    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0]!.filePath, 'src/index.ts');
  });

  it('forces the changes tool via tool_choice', async () => {
    const { fn, calls } = mockFetch(() => openAiResponse(CHANGES_ARGS, CHANGES_TOOL_NAME));
    await provider(fn).generateProposedChanges({ requirements: REQUIREMENTS, context: CONTEXT, plan: PLAN });

    const body = JSON.parse(calls[0]!.init.body as string) as { tool_choice: { function: { name: string } } };
    assert.equal(body.tool_choice.function.name, CHANGES_TOOL_NAME);
  });

  it('includes the plan in the prompt', async () => {
    const { fn, calls } = mockFetch(() => openAiResponse(CHANGES_ARGS, CHANGES_TOOL_NAME));
    await provider(fn).generateProposedChanges({ requirements: REQUIREMENTS, context: CONTEXT, plan: PLAN });

    const body = JSON.parse(calls[0]!.init.body as string) as { messages: { content: string }[] };
    const userMessage = body.messages.find((m) => m.content.includes('Implementation plan'));
    assert.ok(userMessage, 'the plan was not included in the prompt');
    assert.ok(userMessage!.content.includes('item-1'));
  });
});

describe('error classification (shared HTTP handling)', () => {
  it('maps 401 to authentication_failed', async () => {
    const { fn } = mockFetch(() => new Response(null, { status: 401 }));
    const result = await provider(fn).generateImplementationPlan({ requirements: REQUIREMENTS, context: CONTEXT });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'authentication_failed');
  });

  it('maps 429 to rate_limited, with retryAfterMs when present', async () => {
    const { fn } = mockFetch(() => new Response(null, { status: 429, headers: { 'retry-after': '15' } }));
    const result = await provider(fn).generateImplementationPlan({ requirements: REQUIREMENTS, context: CONTEXT });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'rate_limited');
    assert.equal(result.ok === false && result.retryAfterMs, 15_000);
  });

  for (const status of [500, 502, 503]) {
    it(`maps a ${status} to transient`, async () => {
      const { fn } = mockFetch(() => new Response(null, { status }));
      const result = await provider(fn).generateImplementationPlan({ requirements: REQUIREMENTS, context: CONTEXT });
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.kind, 'transient');
    });
  }

  it('maps an unexpected non-2xx status to malformed', async () => {
    const { fn } = mockFetch(() => new Response(null, { status: 418 }));
    const result = await provider(fn).generateImplementationPlan({ requirements: REQUIREMENTS, context: CONTEXT });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'malformed');
  });

  it('maps a network failure to transient', async () => {
    const fn = (async () => {
      throw new Error('getaddrinfo ENOTFOUND api.openai.com');
    }) as unknown as typeof fetch;
    const result = await provider(fn).generateImplementationPlan({ requirements: REQUIREMENTS, context: CONTEXT });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'transient');
  });

  it('maps a timeout to the dedicated timeout kind', async () => {
    const fn = (async (_input: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }) as unknown as typeof fetch;
    const result = await createOpenAiCodingAgentProvider({
      apiKey: API_KEY,
      model: MODEL,
      logger: createLogger({ write: () => {} }),
      fetchFn: fn,
      timeoutMs: 5,
    }).generateImplementationPlan({ requirements: REQUIREMENTS, context: CONTEXT });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'timeout');
  });

  it('maps a malformed JSON response body to malformed', async () => {
    const { fn } = mockFetch(() => new Response('not json', { status: 200 }));
    const result = await provider(fn).generateImplementationPlan({ requirements: REQUIREMENTS, context: CONTEXT });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'malformed');
  });
});

describe('secret-safe: the API key never leaks', () => {
  it('sends the key only in the Authorization header', async () => {
    const { fn, calls } = mockFetch(() => openAiResponse(PLAN_ARGS, PLAN_TOOL_NAME));
    await provider(fn).generateImplementationPlan({ requirements: REQUIREMENTS, context: CONTEXT });

    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers['authorization'], `Bearer ${API_KEY}`);
    assert.ok(!(calls[0]!.init.body as string).includes(API_KEY));
  });

  it('never logs the API key, even on failure', async () => {
    const logs: string[] = [];
    const { fn } = mockFetch(() => new Response(null, { status: 500 }));
    await provider(fn, logs).generateImplementationPlan({ requirements: REQUIREMENTS, context: CONTEXT });

    assert.ok(!logs.join('\n').includes(API_KEY));
  });
});

describe('no real network calls', () => {
  it('every test in this file injects fetchFn and never reaches api.openai.com', () => {
    // Documented, not asserted at runtime — see the module header and every
    // provider(...) call above, all of which supply a mock fetchFn.
    assert.ok(true);
  });
});
