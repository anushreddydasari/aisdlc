/**
 * POST /ingest — inbound Neutara webhook.
 *
 * Phase 3 records the delivery and stops. No intake item is created; that
 * needs an issue description the webhook does not carry, so enrichment is
 * Phase 4 and deliveries queue as `pending` until then.
 *
 * Order is load-bearing:
 *
 *   content-type → read raw body → VERIFY SIGNATURE → parse → validate →
 *   record → audit
 *
 * Nothing is parsed before the signature is checked. Parsing attacker-
 * controlled JSON is work performed on behalf of an unauthenticated caller,
 * and a signature failure writes nothing at all — otherwise anyone who can
 * reach the endpoint can fill the database.
 *
 * Returns a result rather than writing to the response, so the whole decision
 * tree is testable without a socket.
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import type { AuditLog } from '../db/audit-log.ts';
import { ACCEPTED_WEBHOOK_EVENTS } from '../db/collections.ts';
import type { WebhookDeliveryRepository, RecordableStatus } from '../db/webhook-deliveries.ts';
import type { Logger } from '../logging/logger.ts';
import { DEFAULT_MAX_BODY_BYTES, readRawBody } from './body.ts';
import { SIGNATURE_HEADER, verifySignature } from './signature.ts';
import { validateIssueEvent } from './ingest-payload.ts';

export interface IngestDeps {
  readonly logger: Logger;
  /** NEUTARA_WEBHOOK_SECRET. Absent means refuse everything. */
  readonly webhookSecret: string | undefined;
  /** Absent while the database is unreachable. */
  readonly deliveries: WebhookDeliveryRepository | undefined;
  readonly audit: AuditLog | undefined;
  readonly maxBodyBytes?: number;
}

export interface IngestResult {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
}

const UNAUTHORIZED: IngestResult = { statusCode: 401, body: { error: 'unauthorized' } };
const INVALID: IngestResult = { statusCode: 400, body: { error: 'invalid_request' } };
const UNAVAILABLE: IngestResult = { statusCode: 503, body: { error: 'unavailable' } };

export function computeDeliveryId(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

function isJsonContentType(header: string | undefined): boolean {
  if (header === undefined) return false;
  // `application/json; charset=utf-8` is what the sender actually sets.
  return header.split(';')[0]!.trim().toLowerCase() === 'application/json';
}

export async function handleIngest(
  req: IncomingMessage,
  deps: IngestDeps,
): Promise<IngestResult> {
  const { logger } = deps;

  if (!isJsonContentType(req.headers['content-type'])) {
    return { statusCode: 415, body: { error: 'unsupported_media_type' } };
  }

  const read = await readRawBody(req, { maxBytes: deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES });
  if (!read.ok) {
    if (read.reason === 'too_large') {
      logger.warn('ingest rejected: body too large');
      return { statusCode: 413, body: { error: 'payload_too_large' } };
    }
    logger.warn('ingest aborted while reading body');
    return INVALID;
  }

  const signature = verifySignature({
    secret: deps.webhookSecret,
    body: read.body,
    header: req.headers[SIGNATURE_HEADER] as string | undefined,
  });
  if (!signature.valid) {
    // The reason is logged but never returned: distinguishable responses for
    // "missing", "malformed" and "wrong" hand a caller a free oracle.
    logger.warn('ingest rejected: signature', { reason: signature.reason });
    return UNAUTHORIZED;
  }

  const deliveryId = computeDeliveryId(read.body);
  const child = logger.child({ deliveryId });

  // Everything past this point is authenticated, so recording is safe.
  if (deps.deliveries === undefined || deps.audit === undefined) {
    // Neutara does not retry, so this event is lost. Logged loudly for that
    // reason rather than treated as a routine 503.
    child.error('ingest rejected: database unavailable; delivery will not be retried upstream');
    return UNAVAILABLE;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.body.toString('utf8'));
  } catch {
    return record(deps, child, { deliveryId, status: 'invalid', invalidReason: 'malformed_json' }, INVALID);
  }

  const validation = validateIssueEvent(parsed);
  const payload = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;

  if (!validation.ok) {
    if (validation.reason === 'unknown_event') {
      // Valid shape, event we do not handle. Recorded, not an error: a 4xx
      // would make Neutara drop an event we merely chose not to process.
      const eventName = (payload?.['event'] as string | undefined) ?? null;
      return record(
        deps,
        child,
        { deliveryId, status: 'ignored', issueKey: readIssueKey(payload), payload },
        { statusCode: 202, body: { status: 'ignored', deliveryId } },
        { event: eventName },
      );
    }
    child.warn('ingest payload invalid', { reason: validation.reason });
    return record(
      deps,
      child,
      { deliveryId, status: 'invalid', invalidReason: validation.reason, payload },
      INVALID,
    );
  }

  if (validation.unknownFields.length > 0) {
    // Tolerated, never fatal. Surfaced so upstream drift is visible.
    child.info('ingest payload carried unknown fields', { fields: validation.unknownFields });
  }

  const accepted = ACCEPTED_WEBHOOK_EVENTS.includes(validation.event.event);
  const status: RecordableStatus = accepted ? 'pending' : 'ignored';

  return record(
    deps,
    child,
    {
      deliveryId,
      status,
      event: validation.event.event,
      issueKey: validation.event.issue.key,
      eventTimestamp: validation.eventTimestamp,
      payload,
    },
    {
      statusCode: 202,
      body: accepted
        ? { status: 'accepted', deliveryId, issueKey: validation.event.issue.key }
        : { status: 'ignored', deliveryId },
    },
  );
}

function readIssueKey(payload: Record<string, unknown> | null): string | null {
  const issue = payload?.['issue'];
  if (typeof issue !== 'object' || issue === null) return null;
  const key = (issue as Record<string, unknown>)['key'];
  return typeof key === 'string' && key !== '' ? key : null;
}

/** Records the delivery, audits it, and maps a duplicate onto 200. */
async function record(
  deps: IngestDeps,
  logger: Logger,
  input: Parameters<WebhookDeliveryRepository['record']>[0],
  onRecorded: IngestResult,
  auditExtra: Record<string, unknown> = {},
): Promise<IngestResult> {
  const deliveries = deps.deliveries!;
  const audit = deps.audit!;

  let result;
  try {
    result = await deliveries.record(input);
  } catch (error) {
    logger.error('failed to record webhook delivery', { error });
    return UNAVAILABLE;
  }

  if (!result.recorded) {
    // A replay. No audit entry: nothing new happened.
    return { statusCode: 200, body: { status: 'duplicate', deliveryId: input.deliveryId } };
  }

  const action =
    input.status === 'pending'
      ? 'webhook.received'
      : input.status === 'ignored'
        ? 'webhook.ignored'
        : 'webhook.invalid';

  try {
    await audit.append({
      actor: 'source:webhook',
      action,
      subjectType: 'webhookDelivery',
      subjectId: result.id,
      // Never ticket text: identifiers and outcome only.
      detail: {
        deliveryId: input.deliveryId,
        ...(input.event === undefined || input.event === null ? {} : { event: input.event }),
        ...(input.issueKey === undefined || input.issueKey === null
          ? {}
          : { issueKey: input.issueKey }),
        ...(input.invalidReason === undefined || input.invalidReason === null
          ? {}
          : { reason: input.invalidReason }),
        ...auditExtra,
      },
    });
  } catch (error) {
    // The delivery is already stored. Losing the audit entry is bad, but
    // answering 5xx would make Neutara drop an event we have safely kept.
    logger.error('recorded delivery but failed to audit it', { error });
  }

  return onRecorded;
}
