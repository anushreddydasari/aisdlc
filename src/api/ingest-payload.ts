/**
 * Validation for the Neutara webhook payload.
 *
 * A pure function over already-parsed JSON. It mirrors `IssueEventPayload` in
 * Neutara's connector-service; that type is the contract, not ours to choose.
 *
 * Unknown fields are ACCEPTED, not rejected. Neutara does not retry a failed
 * delivery, so rejecting an unrecognised field would silently destroy events
 * the moment upstream adds one. The whole payload is stored regardless, so
 * nothing is lost by tolerating them — they are reported instead, for a log
 * counter, so drift is visible without being fatal.
 */

import { WEBHOOK_EVENTS, type WebhookEvent } from '../db/collections.ts';

export interface NeutaraIssue {
  readonly key: string;
  readonly cf_key?: string;
  readonly summary: string;
  readonly type: string;
  readonly priority: string;
  readonly status?: string;
  readonly assignee?: string;
  readonly reporter?: string;
  readonly department?: string;
  readonly spaceKey: string;
  readonly spaceName?: string;
  readonly url: string;
}

export interface NeutaraIssueEvent {
  readonly event: WebhookEvent;
  readonly timestamp: string;
  readonly issue: NeutaraIssue;
  readonly change?: { readonly field: string; readonly from?: string; readonly to?: string };
  readonly actor?: string;
}

export type PayloadValidation =
  | {
      readonly ok: true;
      readonly event: NeutaraIssueEvent;
      readonly eventTimestamp: Date;
      /** Top-level keys we do not know about. Logged, never fatal. */
      readonly unknownFields: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

/** Caps, so one pathological ticket cannot approach the 16 MB document limit. */
const LIMITS = {
  key: 64,
  summary: 512,
  type: 64,
  priority: 64,
  spaceKey: 64,
  url: 2048,
  optional: 256,
} as const;

const KNOWN_TOP_LEVEL = new Set(['event', 'timestamp', 'issue', 'change', 'actor']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(
  source: Record<string, unknown>,
  path: string,
  field: string,
  max: number,
  allowEmpty = false,
): { ok: true; value: string } | { ok: false; reason: string } {
  const value = source[field];
  if (value === undefined || value === null) return { ok: false, reason: `missing_field:${path}` };
  if (typeof value !== 'string') return { ok: false, reason: `invalid_type:${path}` };
  if (!allowEmpty && value.trim() === '') return { ok: false, reason: `missing_field:${path}` };
  if (value.length > max) return { ok: false, reason: `too_long:${path}` };
  return { ok: true, value };
}

function optionalString(
  source: Record<string, unknown>,
  path: string,
  field: string,
  max: number,
): { ok: true; value: string | undefined } | { ok: false; reason: string } {
  const value = source[field];
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== 'string') return { ok: false, reason: `invalid_type:${path}` };
  if (value.length > max) return { ok: false, reason: `too_long:${path}` };
  return { ok: true, value };
}

export function validateIssueEvent(body: unknown): PayloadValidation {
  if (!isRecord(body)) return { ok: false, reason: 'not_an_object' };

  const event = body['event'];
  if (typeof event !== 'string') return { ok: false, reason: 'missing_field:event' };
  if (!(WEBHOOK_EVENTS as readonly string[]).includes(event)) {
    // Distinct from a malformed field: an event we simply do not handle is
    // recorded as `ignored`, not `invalid`.
    return { ok: false, reason: 'unknown_event' };
  }

  const timestampRaw = body['timestamp'];
  if (typeof timestampRaw !== 'string' || timestampRaw.trim() === '') {
    return { ok: false, reason: 'missing_field:timestamp' };
  }
  const eventTimestamp = new Date(timestampRaw);
  if (Number.isNaN(eventTimestamp.getTime())) return { ok: false, reason: 'invalid_timestamp' };

  const issueRaw = body['issue'];
  if (!isRecord(issueRaw)) return { ok: false, reason: 'missing_field:issue' };

  const required: [string, string, number, boolean][] = [
    ['issue.key', 'key', LIMITS.key, false],
    // Summary may legitimately be blank on a sparse ticket; length still caps.
    ['issue.summary', 'summary', LIMITS.summary, true],
    ['issue.type', 'type', LIMITS.type, false],
    ['issue.priority', 'priority', LIMITS.priority, true],
    ['issue.spaceKey', 'spaceKey', LIMITS.spaceKey, false],
    ['issue.url', 'url', LIMITS.url, true],
  ];
  const values: Record<string, string> = {};
  for (const [path, field, max, allowEmpty] of required) {
    const result = requiredString(issueRaw, path, field, max, allowEmpty);
    if (!result.ok) return { ok: false, reason: result.reason };
    values[field] = result.value;
  }

  const optionals: [string, string][] = [
    ['issue.cf_key', 'cf_key'],
    ['issue.status', 'status'],
    ['issue.assignee', 'assignee'],
    ['issue.reporter', 'reporter'],
    ['issue.department', 'department'],
    ['issue.spaceName', 'spaceName'],
  ];
  const optionalValues: Record<string, string | undefined> = {};
  for (const [path, field] of optionals) {
    const result = optionalString(issueRaw, path, field, LIMITS.optional);
    if (!result.ok) return { ok: false, reason: result.reason };
    optionalValues[field] = result.value;
  }

  let change: NeutaraIssueEvent['change'];
  const changeRaw = body['change'];
  if (changeRaw !== undefined && changeRaw !== null) {
    if (!isRecord(changeRaw)) return { ok: false, reason: 'invalid_type:change' };
    const field = requiredString(changeRaw, 'change.field', 'field', LIMITS.optional);
    if (!field.ok) return { ok: false, reason: field.reason };
    const from = optionalString(changeRaw, 'change.from', 'from', LIMITS.optional);
    if (!from.ok) return { ok: false, reason: from.reason };
    const to = optionalString(changeRaw, 'change.to', 'to', LIMITS.optional);
    if (!to.ok) return { ok: false, reason: to.reason };
    change = {
      field: field.value,
      ...(from.value === undefined ? {} : { from: from.value }),
      ...(to.value === undefined ? {} : { to: to.value }),
    };
  }

  const actor = optionalString(body, 'actor', 'actor', LIMITS.optional);
  if (!actor.ok) return { ok: false, reason: actor.reason };

  const issue: NeutaraIssue = {
    key: values['key']!,
    summary: values['summary']!,
    type: values['type']!,
    priority: values['priority']!,
    spaceKey: values['spaceKey']!,
    url: values['url']!,
    ...(optionalValues['cf_key'] === undefined ? {} : { cf_key: optionalValues['cf_key'] }),
    ...(optionalValues['status'] === undefined ? {} : { status: optionalValues['status'] }),
    ...(optionalValues['assignee'] === undefined ? {} : { assignee: optionalValues['assignee'] }),
    ...(optionalValues['reporter'] === undefined ? {} : { reporter: optionalValues['reporter'] }),
    ...(optionalValues['department'] === undefined
      ? {}
      : { department: optionalValues['department'] }),
    ...(optionalValues['spaceName'] === undefined
      ? {}
      : { spaceName: optionalValues['spaceName'] }),
  };

  return {
    ok: true,
    event: {
      event: event as WebhookEvent,
      timestamp: timestampRaw,
      issue,
      ...(change === undefined ? {} : { change }),
      ...(actor.value === undefined ? {} : { actor: actor.value }),
    },
    eventTimestamp,
    unknownFields: Object.keys(body).filter((key) => !KNOWN_TOP_LEVEL.has(key)),
  };
}
