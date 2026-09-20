/**
 * Phase 4 enrichment: turns a recorded webhook delivery into an intake item.
 *
 * Phase 3 stops at a queue because the webhook carries no issue description,
 * which `IntakeSnapshot` requires and `sourceHash` covers. This worker closes
 * that gap: drain `pending`, fetch the full issue from Neutara, build the
 * snapshot, create the intake item, mark the delivery `enriched`.
 *
 * Ordering is deliberate and matters for correctness:
 *
 *   fetch → validate → create intake item → mark delivery enriched
 *
 * The intake item is created only after a successful fetch, and the delivery
 * is settled only after the item exists. A crash between the last two steps
 * leaves the delivery `pending` with the item already created — the next run
 * re-creates idempotently (unique `issueKey`, `create()` returns the existing
 * item) and settles the delivery. Re-processing is therefore safe; losing the
 * link is not, so the link is written last.
 *
 * The item is keyed by the CANONICAL issue key taken from the response, not by
 * whatever identifier the delivery happened to name. Neutara tickets carry both
 * an internal key and a customer-facing `cfKey`, and either can address a fetch;
 * normalising to the canonical one here is what stops the same ticket becoming
 * two intake items when it is referenced both ways.
 */

import type { ObjectId } from 'mongodb';

import type { WebhookDeliveryDocument, WebhookDeliveryRepository } from '../db/webhook-deliveries.ts';
import type { IntakeRepository, IntakeSnapshot, IntakeSnapshotMeta } from '../intake/repository.ts';
import type { Logger } from '../logging/logger.ts';
import { isRetryable, type NeutaraClient, type NeutaraIssue } from '../neutara/client.ts';

/** First retry after a minute, doubling, capped so recovery stays timely. */
export const RETRY_BASE_MS = 60_000;
export const RETRY_MAX_MS = 60 * 60_000;

export type EnrichmentOutcome =
  | 'enriched'
  | 'retry_scheduled'
  | 'failed_permanently'
  | 'skipped_no_issue_key';

export interface EnrichmentDeps {
  readonly deliveries: WebhookDeliveryRepository;
  readonly intake: IntakeRepository;
  readonly client: NeutaraClient;
  readonly logger: Logger;
  readonly now?: () => Date;
}

/** Exponential backoff from the attempt count already recorded. */
export function backoffMs(attempts: number): number {
  const exponent = Math.max(0, attempts);
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** exponent);
}

/**
 * Maps a Neutara issue onto the intake snapshot.
 *
 * `title` comes from `summary`, `project` from `spaceKey`, and `reporter`
 * from the reporter object's email in preference to its display name — an
 * email is stable where a display name changes when someone's name does, and
 * a display-name change should not invalidate checkpoints.
 */
export function toSnapshot(issue: NeutaraIssue): IntakeSnapshot {
  return {
    title: issue.summary,
    description: issue.description ?? '',
    issueType: issue.type ?? 'task',
    priority: issue.priority ?? null,
    reporter: issue.reporter?.email ?? issue.reporter?.displayName ?? null,
    project: issue.spaceKey ?? null,
    labels: issue.labels ?? [],
    parentKey: issue.parentKey ?? null,
  };
}

/** Everything worth keeping that must not move the hash. */
export function toSnapshotMeta(issue: NeutaraIssue, fetchedAt: Date): IntakeSnapshotMeta {
  return {
    createdAt: issue.createdAt ?? null,
    cfKey: issue.cfKey ?? null,
    status: issue.status?.name ?? null,
    assignee: issue.assignee?.email ?? issue.assignee?.displayName ?? null,
    spaceName: issue.spaceName ?? null,
    fetchedAt,
  };
}

export async function enrichDelivery(
  delivery: WebhookDeliveryDocument,
  deps: EnrichmentDeps,
): Promise<EnrichmentOutcome> {
  const { deliveries, intake, client, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const issueKey = delivery.issueKey;

  if (issueKey === null || issueKey === '') {
    // A pending delivery with no issue key cannot be enriched by any number
    // of retries, so it is settled rather than left to spin.
    await deliveries.markFailed(delivery.deliveryId, 'delivery has no issueKey', now());
    return 'skipped_no_issue_key';
  }

  const fetched = await client.getIssue(issueKey);

  if (!fetched.ok) {
    const exhausted = delivery.attempts + 1 >= delivery.maxAttempts;
    if (!isRetryable(fetched.kind) || exhausted) {
      await deliveries.markFailed(
        delivery.deliveryId,
        `${fetched.kind}: ${fetched.message}`,
        now(),
      );
      logger.error('enrichment abandoned', {
        deliveryId: delivery.deliveryId,
        issueKey,
        kind: fetched.kind,
        attempts: delivery.attempts + 1,
        exhausted,
      });
      return 'failed_permanently';
    }

    const at = now();
    await deliveries.scheduleRetry(
      delivery.deliveryId,
      `${fetched.kind}: ${fetched.message}`,
      new Date(at.getTime() + backoffMs(delivery.attempts)),
      at,
    );
    return 'retry_scheduled';
  }

  const fetchedAt = now();
  // The CANONICAL key from the response, never the requested one. Neutara
  // resolves a customer-facing `CF-*` identifier to the ticket's internal key
  // (see matchesRequestedIdentifier), so a delivery addressed by cfKey and one
  // addressed by the canonical key name the same ticket. Storing the canonical
  // key for both is what lets the unique index on intakeItems.issueKey collapse
  // them into one item — dedupe falls out of normalisation rather than needing
  // a second lookup that could race.
  const canonicalKey = fetched.issue.key;
  const created = await intake.create({
    issueKey: canonicalKey,
    source: 'webhook',
    snapshot: toSnapshot(fetched.issue),
    snapshotMeta: toSnapshotMeta(fetched.issue, fetchedAt),
    deliveryRef: delivery._id ?? null,
    receivedAt: delivery.receivedAt,
  });

  // Settled last, and only once the item exists. `create()` is idempotent on
  // issueKey, so a delivery re-processed after a crash links the same item
  // rather than producing a second one.
  await deliveries.markEnriched(delivery.deliveryId, created.id as ObjectId, fetchedAt);

  logger.info('delivery enriched into an intake item', {
    deliveryId: delivery.deliveryId,
    issueKey: canonicalKey,
    // Present only when the delivery named the ticket by its cfKey, so the
    // normalisation is visible in the log rather than silent.
    ...(canonicalKey === issueKey ? {} : { requestedKey: issueKey }),
    createdIntakeItem: created.created,
  });
  return 'enriched';
}

export interface DrainSummary {
  readonly examined: number;
  readonly enriched: number;
  readonly retryScheduled: number;
  readonly failed: number;
}

/** One pass over the queue. Scheduling is the caller's concern. */
export async function drainPending(deps: EnrichmentDeps, limit = 25): Promise<DrainSummary> {
  const now = deps.now ?? (() => new Date());
  const due = await deps.deliveries.findPending(now(), limit);

  let enriched = 0;
  let retryScheduled = 0;
  let failed = 0;

  for (const delivery of due) {
    try {
      const outcome = await enrichDelivery(delivery, deps);
      if (outcome === 'enriched') enriched += 1;
      else if (outcome === 'retry_scheduled') retryScheduled += 1;
      else failed += 1;
    } catch (error) {
      // One bad delivery must not stop the drain. It stays pending and is
      // picked up next pass; a persistent fault reaches maxAttempts there.
      deps.logger.error('enrichment threw; leaving delivery pending', {
        deliveryId: delivery.deliveryId,
        error,
      });
    }
  }

  if (due.length > 0) {
    deps.logger.info('enrichment pass complete', {
      examined: due.length,
      enriched,
      retryScheduled,
      failed,
    });
  }
  return { examined: due.length, enriched, retryScheduled, failed };
}
