/**
 * Suggests which repository files a Coding Agent run should read and
 * change, so an operator no longer has to type them.
 *
 * Input is the confirmed branch's real file list (github-access/service.ts
 * `listFilesForRun` — names and sizes, never content) plus the ticket and
 * its requirements analysis. Output is a SUGGESTION: the console pre-fills
 * the Coding Agent's file box with it, the operator sees and can edit it,
 * and the Coding Agent itself is unchanged — it still reads only the paths
 * it is finally given, and Gate 3 still shows every proposed change.
 *
 * Three rules keep it honest:
 *   1. Only files that exist can be suggested. Whatever the LLM answers is
 *      intersected with the real list; an invented path is dropped, never
 *      passed on.
 *   2. Only files that can sensibly be edited as text are offered at all:
 *      binaries, dependency/build folders, lock files, minified bundles and
 *      very large files are filtered out before the LLM sees the list.
 *   3. Any LLM failure falls back to a deterministic keyword match, and the
 *      result says which one produced it (`source`).
 */

import type { GitHubTreeFile } from '../github-app/client.ts';
import type { Logger } from '../logging/logger.ts';
import type { RequirementsResult } from '../requirements/analyzer.ts';
import { OPENAI_API_URL } from './openai-provider.ts';

/** At most this many files are suggested — a focused context gives the Coding Agent better results. */
export const MAX_SUGGESTED_FILES = 8;
/** At most this many paths are sent to the LLM, to bound the prompt on large repositories. */
export const MAX_LISTED_PATHS = 1500;
/** Files larger than this are not offered: the Coding Agent rewrites whole files. */
export const MAX_EDITABLE_FILE_BYTES = 200_000;

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'tif', 'tiff', 'psd',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'zip', 'gz', 'tgz', 'tar', 'rar', '7z', 'jar', 'war',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'mp4', 'mov', 'avi', 'wav', 'webm', 'ogg',
  'exe', 'dll', 'so', 'dylib', 'bin', 'class', 'pyc', 'o', 'a',
]);
const EXCLUDED_DIRECTORIES = ['node_modules/', 'dist/', 'build/', 'out/', 'coverage/', 'vendor/', '.git/', '.next/', 'target/', '__pycache__/'];
const LOCK_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'composer.lock', 'Gemfile.lock', 'poetry.lock', 'Cargo.lock']);

function extension(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Why a file is not offered, or null when it is editable. */
export function exclusionReason(file: GitHubTreeFile): string | null {
  const path = file.path;
  if (EXCLUDED_DIRECTORIES.some((d) => path.startsWith(d) || path.includes(`/${d}`))) return 'dependency or build folder';
  if (LOCK_FILES.has(basename(path))) return 'lock file';
  if (BINARY_EXTENSIONS.has(extension(path))) return 'binary file';
  if (/\.min\.(js|css)$/i.test(path)) return 'minified file';
  if (file.size > MAX_EDITABLE_FILE_BYTES) return 'too large to rewrite';
  return null;
}

export function filterEditableFiles(files: readonly GitHubTreeFile[]): GitHubTreeFile[] {
  return files.filter((f) => exclusionReason(f) === null);
}

export interface FileSuggestionInput {
  readonly title: string;
  readonly description: string;
  readonly requirements: RequirementsResult | null;
  /** Already filtered by `filterEditableFiles`. */
  readonly files: readonly GitHubTreeFile[];
}

export interface FileSuggestion {
  readonly paths: readonly string[];
  /** One short sentence, shown to the operator. */
  readonly reason: string;
  readonly source: 'llm' | 'heuristic';
}

export interface FileSuggester {
  suggest(input: FileSuggestionInput): Promise<FileSuggestion>;
}

/**
 * Path segments too common to signal relevance: a ticket mentioning "src"
 * or "css" says nothing about WHICH file under src/ or which stylesheet.
 * An exact file name ("styles.css") still matches, via the name check.
 */
const GENERIC_SEGMENTS = new Set([
  'src', 'lib', 'app', 'apps', 'packages', 'pkg', 'main', 'test', 'tests', 'spec', 'docs', 'public', 'assets', 'static', 'www',
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'css', 'scss', 'html', 'htm', 'md', 'json', 'yml', 'yaml', 'txt', 'xml', 'svg',
]);

function ticketText(input: FileSuggestionInput): string {
  const r = input.requirements;
  return [input.title, input.description, r?.summary, r?.problemStatement, ...(r?.functionalRequirements ?? []), r?.suggestedArea]
    .filter((s): s is string => typeof s === 'string' && s !== '')
    .join('\n');
}

/**
 * Deterministic keyword match: a file scores for every ticket word found in
 * its path, and scores highly when its exact file name (e.g. `index.html`)
 * or the analysis's suggested area names it. Also the fallback whenever the
 * LLM is unavailable.
 */
export function heuristicSuggestion(input: FileSuggestionInput): { paths: string[]; reason: string } {
  const text = ticketText(input).toLowerCase();
  const words = new Set(text.split(/[^a-z0-9]+/).filter((w) => w.length >= 3));
  const area = (input.requirements?.suggestedArea ?? '').toLowerCase();

  const scored = input.files.map((f) => {
    const path = f.path.toLowerCase();
    const name = basename(path);
    const stem = name.replace(/\.[^.]+$/, '');
    let score = 0;
    if (text.includes(name)) score += 10;
    if (area !== '' && (area.includes(name) || path.includes(area))) score += 8;
    for (const segment of path.split(/[/._-]+/)) if (segment.length >= 3 && !GENERIC_SEGMENTS.has(segment) && words.has(segment)) score += 2;
    if (words.has(stem)) score += 2;
    return { path: f.path, score };
  });

  const hits = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  if (hits.length > 0) {
    return { paths: hits.slice(0, MAX_SUGGESTED_FILES).map((h) => h.path), reason: 'Matched file names mentioned in the ticket and its requirements.' };
  }
  // A tiny repository: every editable file is a reasonable starting point.
  if (input.files.length > 0 && input.files.length <= 3) {
    return { paths: input.files.map((f) => f.path), reason: 'The repository has only a few editable files, so all of them are suggested.' };
  }
  return { paths: [], reason: 'No file clearly matches the ticket — choose the files yourself.' };
}

export function createHeuristicFileSuggester(): FileSuggester {
  return {
    async suggest(input) {
      return { ...heuristicSuggestion(input), source: 'heuristic' };
    },
  };
}

export const SELECT_FILES_TOOL = {
  type: 'function',
  function: {
    name: 'select_relevant_files',
    description: 'Choose the repository files a developer would need to read and change to implement the ticket.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['paths', 'reason'],
      properties: {
        paths: {
          type: 'array',
          description: `Paths copied exactly from the provided list, most important first, at most ${MAX_SUGGESTED_FILES}. A path not in the list is ignored.`,
          items: { type: 'string' },
        },
        reason: { type: 'string', description: 'One short sentence explaining the choice.' },
      },
    },
  },
} as const;

const SYSTEM_PROMPT =
  'You select files for a coding task. You are given a ticket and the list of files in a repository (paths and sizes only). ' +
  'Return only paths that appear in the list, exactly as written. Prefer the smallest set that lets the change be made correctly: ' +
  'the file(s) to modify plus any file whose content is needed to match existing conventions (for example the stylesheet for a page). ' +
  `Never more than ${MAX_SUGGESTED_FILES}.`;

export interface OpenAiFileSuggesterOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly logger: Logger;
  readonly timeoutMs?: number;
  /** Injectable so tests never reach the network. */
  readonly fetchFn?: typeof fetch;
}

/** Keeps only real, distinct paths, in the LLM's order, capped. */
export function validateSuggestedPaths(answer: unknown, files: readonly GitHubTreeFile[]): string[] {
  if (!Array.isArray(answer)) return [];
  const known = new Set(files.map((f) => f.path));
  const out: string[] = [];
  for (const p of answer) {
    if (typeof p !== 'string') continue;
    const path = p.trim().replace(/^\.?\//, '');
    if (known.has(path) && !out.includes(path)) out.push(path);
    if (out.length >= MAX_SUGGESTED_FILES) break;
  }
  return out;
}

export function createOpenAiFileSuggester(options: OpenAiFileSuggesterOptions): FileSuggester {
  const { apiKey, model, logger } = options;
  const doFetch = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;

  return {
    async suggest(input) {
      const fallback = (why: string): FileSuggestion => {
        logger.warn('file suggestion fell back to keyword matching', { reason: why });
        return { ...heuristicSuggestion(input), source: 'heuristic' };
      };
      if (input.files.length === 0) return { paths: [], reason: 'The repository has no editable files.', source: 'heuristic' };

      const listed = input.files.slice(0, MAX_LISTED_PATHS).map((f) => `${f.path} (${f.size} bytes)`).join('\n');
      const userPrompt = `TICKET\n${ticketText(input)}\n\nFILES IN THE REPOSITORY\n${listed}`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await doFetch(OPENAI_API_URL, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            max_tokens: 512,
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: userPrompt },
            ],
            tools: [SELECT_FILES_TOOL],
            tool_choice: { type: 'function', function: { name: SELECT_FILES_TOOL.function.name } },
          }),
          signal: controller.signal,
        });
      } catch (error) {
        return fallback(error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'request failed');
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) return fallback(`openai returned ${response.status}`);

      try {
        const parsed = (await response.json()) as { choices?: { message?: { tool_calls?: { function?: { name?: string; arguments?: string } }[] } }[] };
        const call = parsed.choices?.[0]?.message?.tool_calls?.find((c) => c.function?.name === SELECT_FILES_TOOL.function.name);
        if (call?.function?.arguments === undefined) return fallback('no tool call in response');
        const args = JSON.parse(call.function.arguments) as { paths?: unknown; reason?: unknown };
        const paths = validateSuggestedPaths(args.paths, input.files);
        if (paths.length === 0) return fallback('no valid paths in response');
        const reason = typeof args.reason === 'string' && args.reason.trim() !== '' ? args.reason.trim().slice(0, 300) : 'Chosen by the model from the repository file list.';
        return { paths, reason, source: 'llm' };
      } catch {
        return fallback('response was not valid JSON');
      }
    },
  };
}
