import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createLogger } from '../logging/logger.ts';
import type { IntakeSnapshot } from '../intake/repository.ts';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  OPENAI_API_URL,
  REQUIREMENTS_TOOL_NAME,
  createLlmRequirementsAnalyzer,
  parseToolInput,
  parseUsage,
} from './openai-analyzer.ts';

const API_KEY = 'sk-test-key-not-real-fixture'; // pragma: fixture
const MODEL = 'gpt-4.1';

const SNAPSHOT: IntakeSnapshot = {
  title: 'Login fails for SSO users',
  description: 'Users see a blank page after redirect.',
  issueType: 'bug',
  priority: 'high',
  project: 'AISDLC',
  labels: ['sso', 'auth'],
  parentKey: 'AIS-0',
};

const TOOL_ARGS = {
  summary: 'SSO login redirect produces a blank page',
  problemStatement: 'Users are not routed back to the app after SSO redirect.',
  functionalRequirements: ['The system shall complete the SSO redirect and render the app.'],
  acceptanceCriteria: ['Given an SSO login, when redirect completes, then the app renders.'],
  assumptions: ['The identity provider itself is functioning correctly.'],
  risks: ['Root cause across browsers is not yet confirmed.'],
  suggestedArea: 'auth-service',
};

function openAiResponse(
  args: unknown = TOOL_ARGS,
  toolName: string = REQUIREMENTS_TOOL_NAME,
): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl_1',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: toolName, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    }),
    { status: 200 },
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

function analyzer(fetchFn: typeof fetch, logs: string[] = []) {
  return createLlmRequirementsAnalyzer({
    apiKey: API_KEY,
    model: MODEL,
    logger: createLogger({ write: (line) => logs.push(line) }),
    fetchFn,
  });
}

describe('a successful analysis', () => {
  it('returns the parsed tool call arguments as a RequirementsResult', async () => {
    const { fn } = mockFetch(() => openAiResponse());
    const result = await analyzer(fn)(SNAPSHOT);

    assert.equal(result.summary, TOOL_ARGS.summary);
    assert.deepEqual(result.functionalRequirements, TOOL_ARGS.functionalRequirements);
    assert.deepEqual(result.acceptanceCriteria, TOOL_ARGS.acceptanceCriteria);
    assert.deepEqual(result.assumptions, TOOL_ARGS.assumptions);
    assert.deepEqual(result.risks, TOOL_ARGS.risks);
    assert.equal(result.suggestedArea, 'auth-service');
  });

  it('sends the documented request shape, forcing the tool via tool_choice', async () => {
    const { fn, calls } = mockFetch(() => openAiResponse());
    await analyzer(fn)(SNAPSHOT);

    const call = calls[0]!;
    assert.equal(call.url, OPENAI_API_URL);
    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers['authorization'], `Bearer ${API_KEY}`);
    assert.equal(headers['content-type'], 'application/json');

    const body = JSON.parse(call.init.body as string);
    assert.equal(body.model, MODEL);
    assert.equal(body.tool_choice.type, 'function');
    assert.equal(body.tool_choice.function.name, REQUIREMENTS_TOOL_NAME);
    assert.equal(body.tools[0].type, 'function');
    assert.equal(body.tools[0].function.name, REQUIREMENTS_TOOL_NAME);
    assert.equal(body.tools[0].function.strict, true);
    assert.deepEqual(body.tools[0].function.parameters.required, [
      'summary',
      'problemStatement',
      'functionalRequirements',
      'acceptanceCriteria',
      'assumptions',
      'risks',
      'suggestedArea',
    ]);
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.messages[1].role, 'user');
    assert.match(body.messages[1].content, /Login fails for SSO users/);
    assert.match(body.messages[1].content, /Users see a blank page after redirect\./);
  });

  it('treats a null suggestedArea as null', async () => {
    const { fn } = mockFetch(() => openAiResponse({ ...TOOL_ARGS, suggestedArea: null }));
    const result = await analyzer(fn)(SNAPSHOT);
    assert.equal(result.suggestedArea, null);
  });

  it('never logs or leaks the api key', async () => {
    const logs: string[] = [];
    const { fn } = mockFetch(() => openAiResponse());
    await analyzer(fn, logs)(SNAPSHOT);
    assert.ok(logs.every((line) => !line.includes(API_KEY)));
  });
});

describe('usage extraction', () => {
  it('calls onUsage with the mapped token counts', async () => {
    const { fn } = mockFetch(() => openAiResponse());
    let captured: unknown;
    const withUsage = createLlmRequirementsAnalyzer({
      apiKey: API_KEY,
      model: MODEL,
      logger: createLogger({ write: () => {} }),
      fetchFn: fn,
      onUsage: (usage) => {
        captured = usage;
      },
    });

    await withUsage(SNAPSHOT);

    assert.deepEqual(captured, { promptTokens: 100, completionTokens: 50, totalTokens: 150 });
  });

  it('logs usage as its own structured entry, with counts only', async () => {
    const logs: string[] = [];
    const { fn } = mockFetch(() => openAiResponse());
    await analyzer(fn, logs)(SNAPSHOT);

    const usageLine = logs.find((line) => line.includes('openai requirements analysis usage'));
    assert.ok(usageLine, 'no usage log line was written');
    const parsed = JSON.parse(usageLine!);
    assert.equal(parsed['promptTokens'], 100);
    assert.equal(parsed['completionTokens'], 50);
    assert.equal(parsed['totalTokens'], 150);
    assert.equal(parsed['model'], MODEL);
  });

  it('does not call onUsage when the response carries no usage block', async () => {
    const { fn } = mockFetch(
      () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  tool_calls: [
                    {
                      id: 'call_1',
                      type: 'function',
                      function: { name: REQUIREMENTS_TOOL_NAME, arguments: JSON.stringify(TOOL_ARGS) },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            // no usage field at all
          }),
          { status: 200 },
        ),
    );
    let called = false;
    const withUsage = createLlmRequirementsAnalyzer({
      apiKey: API_KEY,
      model: MODEL,
      logger: createLogger({ write: () => {} }),
      fetchFn: fn,
      onUsage: () => {
        called = true;
      },
    });

    await withUsage(SNAPSHOT);

    assert.equal(called, false);
  });

  it('parseUsage returns null (never throws) for a malformed usage shape', () => {
    assert.equal(parseUsage({ usage: { prompt_tokens: 'not a number' } }), null);
    assert.equal(parseUsage({ usage: { prompt_tokens: 100, completion_tokens: 50 } }), null);
    assert.equal(parseUsage({}), null);
    assert.equal(parseUsage(null), null);
    assert.equal(parseUsage('not an object'), null);
  });

  it('parseUsage returns the mapped counts for a well-formed usage block', () => {
    assert.deepEqual(
      parseUsage({ usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }),
      { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    );
  });
});

describe('failure handling', () => {
  it('throws (never returns) on a non-2xx response, without leaking the body', async () => {
    const logs: string[] = [];
    const { fn } = mockFetch(() => new Response('some possibly sensitive body', { status: 500 }));
    await assert.rejects(analyzer(fn, logs)(SNAPSHOT), /openai api returned 500/);
    assert.ok(logs.every((line) => !line.includes('some possibly sensitive body')));
  });

  it('throws when the response carries no tool call', async () => {
    const { fn } = mockFetch(
      () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'I cannot help with that.' }, finish_reason: 'stop' }],
          }),
          { status: 200 },
        ),
    );
    await assert.rejects(analyzer(fn)(SNAPSHOT), /did not call the requirements tool/);
  });

  it('throws when an unexpected tool is called', async () => {
    const { fn } = mockFetch(() => openAiResponse(TOOL_ARGS, 'some_other_tool'));
    await assert.rejects(analyzer(fn)(SNAPSHOT), /unexpected tool/);
  });

  it('throws on malformed JSON body', async () => {
    const { fn } = mockFetch(() => new Response('not json', { status: 200 }));
    await assert.rejects(analyzer(fn)(SNAPSHOT), /not valid JSON/);
  });

  it('throws when the tool call arguments string is not valid JSON', async () => {
    const { fn } = mockFetch(
      () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  tool_calls: [
                    {
                      id: 'call_1',
                      type: 'function',
                      function: { name: REQUIREMENTS_TOOL_NAME, arguments: 'not json' },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          }),
          { status: 200 },
        ),
    );
    await assert.rejects(analyzer(fn)(SNAPSHOT), /arguments were not valid JSON/);
  });

  it('throws a timeout message and never leaks the key when the request is aborted', async () => {
    const logs: string[] = [];
    const fn = (async (_input: string | URL | Request, init: RequestInit = {}) => {
      return new Promise<Response>((_resolve, reject) => {
        (init.signal as AbortSignal | undefined)?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    }) as unknown as typeof fetch;

    const fastAnalyzer = createLlmRequirementsAnalyzer({
      apiKey: API_KEY,
      model: MODEL,
      logger: createLogger({ write: (line) => logs.push(line) }),
      fetchFn: fn,
      timeoutMs: 5,
    });

    await assert.rejects(fastAnalyzer(SNAPSHOT), /timed out after 5ms/);
    assert.ok(logs.every((line) => !line.includes(API_KEY)));
  });

  it('uses the default timeout when none is given', () => {
    assert.equal(DEFAULT_REQUEST_TIMEOUT_MS, 60_000);
  });
});

describe('parseToolInput', () => {
  it('names the missing field', () => {
    const { functionalRequirements: _omit, ...rest } = TOOL_ARGS;
    assert.throws(() => parseToolInput(rest), /functionalRequirements/);
  });

  it('rejects a non-string-array field', () => {
    assert.throws(
      () => parseToolInput({ ...TOOL_ARGS, risks: 'not an array' }),
      /risks.*array of strings/,
    );
  });

  it('rejects an empty summary', () => {
    assert.throws(() => parseToolInput({ ...TOOL_ARGS, summary: '  ' }), /summary/);
  });

  it('rejects a non-object input', () => {
    assert.throws(() => parseToolInput('not an object'), /not an object/);
    assert.throws(() => parseToolInput(null), /not an object/);
  });

  it('accepts a present, non-empty suggestedArea', () => {
    assert.equal(parseToolInput(TOOL_ARGS).suggestedArea, 'auth-service');
  });

  it('normalises a null suggestedArea to null', () => {
    assert.equal(parseToolInput({ ...TOOL_ARGS, suggestedArea: null }).suggestedArea, null);
  });
});
