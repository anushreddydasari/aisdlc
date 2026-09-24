/**
 * GET /runs/:runId/suggested-files — which files the Coding Agent should
 * read and change for this run, suggested from the confirmed branch's real
 * file list (coding-agent/file-suggestion.ts).
 *
 * Read-only and advisory: it lists the repository through
 * `GitHubAccessService.listFilesForRun` — which applies every run /
 * approval / confirmed-selection / registry check the Coding Agent itself
 * is subject to — and returns a suggestion the console pre-fills. Nothing
 * here triggers the Coding Agent or changes any state; POST
 * /runs/:runId/coding-agent is still the only way to run it, with the
 * paths the operator finally submits.
 *
 * Mounted only when the GitHub App is configured, like the Coding Agent route.
 */

import type { IncomingMessage } from 'node:http';
import { ObjectId } from 'mongodb';

import type { FileSuggester } from '../coding-agent/file-suggestion.ts';
import { exclusionReason, filterEditableFiles } from '../coding-agent/file-suggestion.ts';
import type { GitHubAccessService } from '../github-access/service.ts';
import type { IntakeRepository } from '../intake/repository.ts';
import type { Logger } from '../logging/logger.ts';
import type { RunsRepository } from '../orchestrator/repository.ts';
import type { RequirementsRepository } from '../requirements/repository.ts';
import { AUTHORIZATION_HEADER, verifyOperatorToken } from './operator-auth.ts';

export interface SuggestedFilesDeps {
  readonly logger: Logger;
  /** OPERATOR_TOKEN. Absent means every request is refused. */
  readonly operatorToken: string | undefined;
  /** Absent while the database is unreachable. */
  readonly sources:
    | {
        readonly runs: Pick<RunsRepository, 'findById'>;
        readonly intake: Pick<IntakeRepository, 'findByIssueKey'>;
        readonly requirements: Pick<RequirementsRepository, 'findByIntakeItemId'>;
        readonly githubAccess: Pick<GitHubAccessService, 'listFilesForRun'>;
      }
    | undefined;
  readonly suggester: FileSuggester;
}

export interface SuggestedFilesResult {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
}

export async function handleGetSuggestedFiles(req: IncomingMessage, deps: SuggestedFilesDeps, runIdParam: string): Promise<SuggestedFilesResult> {
  const child = deps.logger.child({ route: 'runs.suggested-files' });

  const auth = verifyOperatorToken({ token: deps.operatorToken, header: req.headers[AUTHORIZATION_HEADER] as string | undefined });
  if (!auth.valid) {
    child.warn('suggested files rejected: unauthorized', { reason: auth.reason });
    return { statusCode: 401, body: { error: 'unauthorized' } };
  }
  if (deps.sources === undefined) return { statusCode: 503, body: { error: 'unavailable' } };
  if (!/^[0-9a-fA-F]{24}$/.test(runIdParam)) return { statusCode: 400, body: { error: 'invalid_request', field: 'runId' } };
  const runId = new ObjectId(runIdParam);
  const { runs, intake, requirements, githubAccess } = deps.sources;

  const listed = await githubAccess.listFilesForRun(runId);
  if (!listed.ok) {
    return {
      statusCode: listed.category === 'run_not_found' ? 404 : 409,
      body: { error: listed.category, detail: listed.message, retryable: listed.retryable },
    };
  }

  // listFilesForRun already proved the run and its approved intake item
  // exist; these reads only fetch the ticket text the suggester reasons over.
  const run = await runs.findById(runId);
  const item = run === null ? null : await intake.findByIssueKey(run.issueKey);
  const analysis = item?._id === undefined ? null : await requirements.findByIntakeItemId(item._id);

  const editable = filterEditableFiles(listed.files);
  const suggestion = await deps.suggester.suggest({
    title: item?.snapshot.title ?? '',
    description: item?.snapshot.description ?? '',
    requirements: analysis?.status === 'completed' ? analysis.result : null,
    files: editable,
  });

  child.info('files suggested', { runId: runIdParam, suggested: suggestion.paths.length, source: suggestion.source, listed: listed.files.length });
  return {
    statusCode: 200,
    body: {
      repository: `${listed.owner}/${listed.repo}`,
      branch: listed.branch,
      suggested: suggestion.paths,
      reason: suggestion.reason,
      source: suggestion.source,
      files: editable.map((f) => ({ path: f.path, size: f.size })),
      excluded: listed.files.filter((f) => exclusionReason(f) !== null).map((f) => ({ path: f.path, why: exclusionReason(f) })),
      truncated: listed.truncated,
    },
  };
}
