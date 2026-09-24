import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createLogger } from '../logging/logger.ts';
import type { RequirementsResult } from '../requirements/analyzer.ts';
import {
  MAX_SUGGESTED_FILES,
  createOpenAiFileSuggester,
  exclusionReason,
  filterEditableFiles,
  heuristicSuggestion,
  validateSuggestedPaths,
  type FileSuggestionInput,
} from './file-suggestion.ts';

const logger = createLogger({ write: () => {} });

// The real my-profile repository's files.
const MY_PROFILE = [
  { path: 'hdp.jpg', size: 120000 },
  { path: 'index.html', size: 3712 },
  { path: 'resume.pdf', size: 90000 },
  { path: 'styles.css', size: 5100 },
];

function requirements(overrides: Partial<RequirementsResult> = {}): RequirementsResult {
  return {
    summary: 'Add a Contact section to index.html',
    problemStatement: 'Visitors cannot contact the owner.',
    functionalRequirements: ['Add an email link', 'Style it like the other sections'],
    acceptanceCriteria: [],
    assumptions: [],
    risks: [],
    suggestedArea: 'index.html',
    ...overrides,
  };
}

function input(overrides: Partial<FileSuggestionInput> = {}): FileSuggestionInput {
  return {
    title: 'Add a Contact section to index.html',
    description: 'Add a "Contact" section with an email link, styled consistently with styles.css.',
    requirements: requirements(),
    files: filterEditableFiles(MY_PROFILE),
    ...overrides,
  };
}

describe('filterEditableFiles / exclusionReason', () => {
  it('keeps text files and drops images, PDFs, vendor/build folders, lock files, minified and oversized files', () => {
    assert.deepEqual(filterEditableFiles(MY_PROFILE).map((f) => f.path), ['index.html', 'styles.css']);
    assert.equal(exclusionReason({ path: 'node_modules/x/index.js', size: 1 }), 'dependency or build folder');
    assert.equal(exclusionReason({ path: 'web/dist/app.js', size: 1 }), 'dependency or build folder');
    assert.equal(exclusionReason({ path: 'package-lock.json', size: 1 }), 'lock file');
    assert.equal(exclusionReason({ path: 'app.min.js', size: 1 }), 'minified file');
    assert.equal(exclusionReason({ path: 'big.json', size: 900_000 }), 'too large to rewrite');
    assert.equal(exclusionReason({ path: 'src/index.ts', size: 900 }), null);
  });
});

describe('heuristicSuggestion', () => {
  it('picks the files the ticket names, most relevant first', () => {
    assert.deepEqual(heuristicSuggestion(input()).paths, ['index.html', 'styles.css']);
  });

  it('uses the analysis suggested area', () => {
    const s = heuristicSuggestion(
      input({
        title: 'Fix a typo',
        description: 'There is a typo.',
        requirements: requirements({ summary: 'Fix a typo', functionalRequirements: [], suggestedArea: 'src/api' }),
        files: ['src/api/server.ts', 'README.md', 'src/db/x.ts', 'docs/y.md'].map((path) => ({ path, size: 1 })),
      }),
    );
    assert.deepEqual(s.paths, ['src/api/server.ts']);
  });

  it('suggests every file in a tiny repository with no match, and nothing in a larger one', () => {
    const vague = { title: 'Improve it', description: 'Make it better.', requirements: null };
    assert.deepEqual(heuristicSuggestion(input({ ...vague, files: [{ path: 'a.txt', size: 1 }] })).paths, ['a.txt']);
    const many = ['a.ts', 'b.ts', 'c.ts', 'd.ts'].map((path) => ({ path, size: 1 }));
    assert.deepEqual(heuristicSuggestion(input({ ...vague, files: many })).paths, []);
  });
});

describe('validateSuggestedPaths', () => {
  it('keeps only real, distinct paths in order, strips ./, and caps the count', () => {
    const files = Array.from({ length: 20 }, (_, i) => ({ path: `f${i}.ts`, size: 1 }));
    assert.deepEqual(validateSuggestedPaths(['./f1.ts', 'f1.ts', 'invented.ts', 3, 'f2.ts'], files), ['f1.ts', 'f2.ts']);
    assert.equal(validateSuggestedPaths(files.map((f) => f.path), files).length, MAX_SUGGESTED_FILES);
    assert.deepEqual(validateSuggestedPaths('not an array', files), []);
  });
});

function openAiReply(args: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: 'select_relevant_files', arguments: JSON.stringify(args) } }] } }] }),
      { status, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;
}

describe('createOpenAiFileSuggester', () => {
  it("returns the model's choice, keeping only real paths", async () => {
    let sent = '';
    const reply = openAiReply({ paths: ['index.html', 'made-up.js'], reason: 'The section goes in index.html.' });
    const fetchFn = (async (u: string | URL | Request, init?: RequestInit) => {
      sent = String(init?.body);
      return reply(u, init);
    }) as typeof fetch;
    const s = await createOpenAiFileSuggester({ apiKey: 'k', model: 'm', logger, fetchFn }).suggest(input());
    assert.deepEqual(s, { paths: ['index.html'], reason: 'The section goes in index.html.', source: 'llm' });
    assert.ok(sent.includes('index.html (3712 bytes)'), 'the file list is sent');
    assert.ok(!sent.includes('resume.pdf'), 'filtered files are never offered');
  });

  it('falls back to keyword matching when the API fails or answers nothing usable', async () => {
    const failing = [
      openAiReply({ paths: ['nothing-real.js'], reason: 'x' }),
      openAiReply({}, 500),
      (async () => {
        throw new Error('network down');
      }) as typeof fetch,
    ];
    for (const fetchFn of failing) {
      const s = await createOpenAiFileSuggester({ apiKey: 'k', model: 'm', logger, fetchFn }).suggest(input());
      assert.equal(s.source, 'heuristic');
      assert.deepEqual(s.paths, ['index.html', 'styles.css']);
    }
  });

  it('does not call the API for a repository with no editable files', async () => {
    let called = false;
    const fetchFn = (async () => {
      called = true;
      return new Response('{}');
    }) as typeof fetch;
    const s = await createOpenAiFileSuggester({ apiKey: 'k', model: 'm', logger, fetchFn }).suggest(input({ files: [] }));
    assert.deepEqual(s.paths, []);
    assert.equal(called, false);
  });
});
