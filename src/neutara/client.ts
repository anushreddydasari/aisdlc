/**
 * Read-only client for the Neutara REST API.
 *
 * Phase 4 needs exactly one call: fetch an issue by key, because the webhook
 * payload carries no description. The token is read-only through Phase 7, so
 * this client issues GET and nothing else.
 *
 * The request URL is always built from the CONFIGURED base URL plus the issue
 * key. The webhook payload contains an `issue.url`, and following it would be
 * an SSRF primitive — a signed payload is authenticated, not trusted to name
 * which host we contact.
 *
 * Contract confirmed against the Neutara implementation:
 *   GET {base}/api/issues/{KEY}
 *   Authorization: Bearer nta_...          (jira-pg-api.ts resolveUserId)
 *   Accept: application/json
 * The response body is `formatIssue()`, whose `description` is converted from
 * ADF to HTML and may be truncated by the server when the response is large.
 */

import type { Logger } from '../logging/logger.ts';

/** The subset of Neutara's issue DTO this service consumes. */
export interface NeutaraIssue {
  readonly key: string;
  readonly cfKey?: string | null;
  readonly summary: string;
  readonly description?: string | null;
  readonly type?: string | null;
  readonly priority?: string | null;
  readonly status?: { readonly name?: string | null } | null;
  readonly spaceKey?: string | null;
  readonly spaceName?: string | null;
  readonly reporter?: { readonly email?: string | null; readonly displayName?: string | null } | null;
  readonly assignee?: { readonly email?: string | null; readonly displayName?: string | null } | null;
  readonly parentKey?: string | null;
  readonly labels?: readonly string[] | null;
  readonly createdAt?: string | null;
}

export type FetchFailureKind =
  /** The issue does not exist. Retrying will not help. */
  | 'not_found'
  /** Token rejected, expired or revoked. Retrying will not help. */
  | 'unauthorized'
  /** Response was not the shape we require. Retrying will not help. */
  | 'malformed'
  /** Body exceeded the ceiling. Retrying will not help. */
  | 'too_large'
  /** 5xx, 429, or a transport failure. Worth retrying. */
  | 'transient';

export type FetchIssueResult =
  | { readonly ok: true; readonly issue: NeutaraIssue }
  | {
      readonly ok: false;
      readonly kind: FetchFailureKind;
      /** Safe for logs and for storage in lastError. Never carries the token. */
      readonly message: string;
      readonly status?: number;
    };

/** Whether another attempt could plausibly succeed. */
export function isRetryable(kind: FetchFailureKind): boolean {
  return kind === 'transient';
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
/** A ticket with embedded base64 images can be megabytes; this bounds it. */
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface NeutaraClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly logger: Logger;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  /** Injectable so tests can mock HTTP without a server. */
  readonly fetchFn?: typeof fetch;
}

export interface NeutaraClient {
  getIssue(issueKey: string): Promise<FetchIssueResult>;
}

/** `{base}/api/issues/{key}`, with the key escaped and no double slashes. */
export function buildIssueUrl(baseUrl: string, issueKey: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/issues/${encodeURIComponent(issueKey)}`;
}

function asNeutaraIssue(value: unknown): NeutaraIssue | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  // `key` and `summary` are the two fields an intake item cannot be built
  // without; everything else is optional and defaulted downstream.
  if (typeof record['key'] !== 'string' || record['key'] === '') return null;
  if (typeof record['summary'] !== 'string') return null;
  return record as unknown as NeutaraIssue;
}

/**
 * Whether a response actually answers the identifier we asked for.
 *
 * A Neutara ticket carries TWO identifiers. `key` is the internal, canonical
 * one (`L2B-30058`); `cfKey` is the customer-facing one people see and quote
 * (`CF-31002`). `GET /issues/{key}` accepts either, because the handler runs
 * the requested value through `resolveCfKey` before the lookup — so a fetch
 * addressed by a `CF-*` identifier comes back under the ticket's CANONICAL
 * key, with the requested value carried in `cfKey`.
 *
 * Comparing only against `key` therefore rejected every CF-addressed fetch as
 * `malformed`; and because `malformed` is not retryable, the delivery failed
 * permanently instead of being retried. Confirmed by a read-only smoke test:
 * HTTP 200, valid `key` and `summary`, `key` !== the requested `CF-*` value.
 *
 * Either identifier is accepted. Anything else is a genuine mismatch and must
 * stay a rejection, because attributing one issue's content to another is
 * worse than fetching nothing.
 *
 * The comparison is exact rather than case-insensitive. Neutara upper-cases
 * the key on lookup and returns it canonically, so a case difference would
 * mean the response did not come from the path we requested — not something
 * to paper over here.
 */
export function matchesRequestedIdentifier(issue: NeutaraIssue, requested: string): boolean {
  if (requested === '') return false;
  if (issue.key === requested) return true;
  return typeof issue.cfKey === 'string' && issue.cfKey !== '' && issue.cfKey === requested;
}

export function createNeutaraClient(options: NeutaraClientOptions): NeutaraClient {
  const { baseUrl, token, logger } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const doFetch = options.fetchFn ?? fetch;

  return {
    async getIssue(issueKey: string): Promise<FetchIssueResult> {
      const url = buildIssueUrl(baseUrl, issueKey);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await doFetch(url, {
          method: 'GET',
          headers: {
            // The only place the token appears. It is never logged, never
            // stored, and never included in a failure message.
            authorization: `Bearer ${token}`,
            accept: 'application/json',
          },
          signal: controller.signal,
        });

        if (response.status === 404) {
          return { ok: false, kind: 'not_found', status: 404, message: 'issue not found' };
        }
        if (response.status === 401 || response.status === 403) {
          return {
            ok: false,
            kind: 'unauthorized',
            status: response.status,
            message: 'neutara rejected the credential',
          };
        }
        if (response.status === 429 || response.status >= 500) {
          return {
            ok: false,
            kind: 'transient',
            status: response.status,
            message: `neutara returned ${response.status}`,
          };
        }
        if (!response.ok) {
          return {
            ok: false,
            kind: 'malformed',
            status: response.status,
            message: `neutara returned ${response.status}`,
          };
        }

        const declared = Number(response.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > maxResponseBytes) {
          return { ok: false, kind: 'too_large', message: 'response exceeds the size ceiling' };
        }

        const text = await response.text();
        if (Buffer.byteLength(text, 'utf8') > maxResponseBytes) {
          return { ok: false, kind: 'too_large', message: 'response exceeds the size ceiling' };
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return { ok: false, kind: 'malformed', message: 'response was not valid JSON' };
        }

        const issue = asNeutaraIssue(parsed);
        if (issue === null) {
          return { ok: false, kind: 'malformed', message: 'response was missing key or summary' };
        }
        if (!matchesRequestedIdentifier(issue, issueKey)) {
          // A mismatched identifier means we would attribute one issue's
          // content to another — worse than fetching nothing.
          return { ok: false, kind: 'malformed', message: 'response was for a different issue' };
        }

        return { ok: true, issue };
      } catch (error) {
        const aborted = error instanceof Error && error.name === 'AbortError';
        const message = aborted ? `request timed out after ${timeoutMs}ms` : 'request failed';
        // `error` is passed through the redacting logger; the message stored
        // on the delivery is the fixed string above, never the raw error.
        logger.warn('neutara request failed', { issueKey, timedOut: aborted, error });
        return { ok: false, kind: 'transient', message };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
