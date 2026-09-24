import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { ObjectId } from 'mongodb';

import type { FileSuggester, FileSuggestionInput } from '../coding-agent/file-suggestion.ts';
import type { GitHubFileListResult } from '../github-access/service.ts';
import { createLogger } from '../logging/logger.ts';
import { renderConsoleUi } from './console-ui.ts';
import { BEARER_PREFIX } from './operator-auth.ts';
import { handleGetSuggestedFiles, type SuggestedFilesDeps } from './suggested-files.ts';

const TOKEN = 'op_test_token_value_not_real'; // pragma: fixture
const RUN_ID = new ObjectId();
const INTAKE_ID = new ObjectId();

function request(options: { authorization?: string | null } = {}): IncomingMessage {
  const stream = Readable.from([Buffer.alloc(0)]) as unknown as IncomingMessage;
  const authorization = options.authorization === undefined ? `${BEARER_PREFIX}${TOKEN}` : options.authorization;
  stream.headers = (authorization === null ? {} : { authorization }) as IncomingMessage['headers'];
  return stream;
}

const LISTED: GitHubFileListResult = {
  ok: true,
  runId: RUN_ID,
  repositoryId: 'my-profile',
  owner: 'anushreddydasari',
  repo: 'my-profile',
  branch: 'master',
  files: [
    { path: 'hdp.jpg', size: 120000 },
    { path: 'index.html', size: 3712 },
    { path: 'resume.pdf', size: 90000 },
    { path: 'styles.css', size: 5100 },
  ],
  truncated: false,
};

function deps(listed: GitHubFileListResult = LISTED, seen: FileSuggestionInput[] = []): SuggestedFilesDeps {
  const suggester: FileSuggester = {
    async suggest(input) {
      seen.push(input);
      return { paths: ['index.html'], reason: 'The section goes in index.html.', source: 'llm' };
    },
  };
  return {
    logger: createLogger({ write: () => {} }),
    operatorToken: TOKEN,
    suggester,
    sources: {
      runs: { async findById() { return { _id: RUN_ID, issueKey: 'LOCAL-1', intakeItemId: INTAKE_ID } as never; } },
      intake: {
        async findByIssueKey() {
          return { _id: INTAKE_ID, issueKey: 'LOCAL-1', snapshot: { title: 'Fix contact email', description: 'Replace the email in index.html' } } as never;
        },
      },
      requirements: {
        async findByIntakeItemId() {
          return { status: 'completed', result: { summary: 'Fix email', suggestedArea: 'index.html' } } as never;
        },
      },
      githubAccess: { async listFilesForRun() { return listed; } },
    },
  };
}

describe('GET /runs/:runId/suggested-files', () => {
  it('refuses a missing token and a malformed run id', async () => {
    assert.equal((await handleGetSuggestedFiles(request({ authorization: null }), deps(), RUN_ID.toHexString())).statusCode, 401);
    assert.equal((await handleGetSuggestedFiles(request({ authorization: `${BEARER_PREFIX}wrong` }), deps(), RUN_ID.toHexString())).statusCode, 401);
    assert.equal((await handleGetSuggestedFiles(request(), deps(), 'nope')).statusCode, 400);
  });

  it('suggests from the editable files only, and reports what it hid', async () => {
    const seen: FileSuggestionInput[] = [];
    const result = await handleGetSuggestedFiles(request(), deps(LISTED, seen), RUN_ID.toHexString());
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body['suggested'], ['index.html']);
    assert.equal(result.body['source'], 'llm');
    assert.equal(result.body['repository'], 'anushreddydasari/my-profile');
    assert.equal(result.body['branch'], 'master');
    assert.deepEqual((result.body['files'] as { path: string }[]).map((f) => f.path), ['index.html', 'styles.css']);
    assert.deepEqual(result.body['excluded'], [
      { path: 'hdp.jpg', why: 'binary file' },
      { path: 'resume.pdf', why: 'binary file' },
    ]);
    // The suggester reasons over the ticket and its analysis, and never sees binaries.
    assert.equal(seen[0]!.title, 'Fix contact email');
    assert.equal(seen[0]!.requirements?.suggestedArea, 'index.html');
    assert.deepEqual(seen[0]!.files.map((f) => f.path), ['index.html', 'styles.css']);
  });

  it('passes a GitHub access refusal through, without suggesting anything', async () => {
    const refused: GitHubFileListResult = {
      ok: false,
      runId: RUN_ID,
      intakeItemId: INTAKE_ID,
      repositoryId: 'my-profile',
      category: 'selection_not_confirmed',
      message: "selection status is 'pending'",
      retryable: false,
    };
    const result = await handleGetSuggestedFiles(request(), deps(refused), RUN_ID.toHexString());
    assert.equal(result.statusCode, 409);
    assert.equal(result.body['error'], 'selection_not_confirmed');
  });
});

describe('the console', () => {
  it('fetches the suggestion for a run and pre-fills only an untouched box', () => {
    const html = renderConsoleUi({ ticketCreatorUrl: null, codingAgentEnabled: true });
    assert.match(html, /'\/runs\/' \+ encodeURIComponent\(runId\) \+ '\/suggested-files'/);
    assert.match(html, /if \(!fileDrafts\[runId\]\) fileDrafts\[runId\] = r\.data\.suggested\.join\(', '\);/);
  });
});
