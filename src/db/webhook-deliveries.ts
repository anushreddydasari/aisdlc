/**
 * Inbound webhook delivery records.
 *
 * Phase 3 writes these and stops. No intake item is created here: the webhook
 * payload has no issue description, which `IntakeSnapshot` requires and
 * `sourceHash` covers, so creating an item now and enriching it later would
 * change its `sourceHash` and make every enriched item look modified to
 * checkpoint resume. Deliveries queue as `pending`; Phase 4 drains them.
 *
 * The collection therefore serves two purposes at once: signed evidence of
 * what Neutara sent, and the work queue for enrichment.
 */

import type { Collection, Db, ObjectId } from 'mongodb';

import type { Logger } from '../logging/logger.ts';
import {
  COLLECTIONS,
  WEBHOOK_DELIVERY_MAX_ATTEMPTS,
  type WebhookDeliveryStatus,
  type WebhookEvent,
} from './collections.ts';

export interface WebhookDeliveryDocument {
  _id?: ObjectId;
  /** sha256 hex of the raw request body. Unique. */
  deliveryId: string;
  event: WebhookEvent | null;
  issueKey: string | null;
  eventTimestamp: Date | null;
  payload: Record<string, unknown> | null;
  status: WebhookDeliveryStatus;
  invalidReason: string | null;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  lastError: { message: string; at: Date } | null;
  intakeItemId: ObjectId | null;
  receivedAt: Date;
  updatedAt: Date;
}

/** Phase 3 can only produce these three. `enriched` and `failed` are Phase 4. */
export type RecordableStatus = Extract<WebhookDeliveryStatus, 'pending' | 'ignored' | 'invalid'>;

export interface RecordDeliveryInput {
  readonly deliveryId: string;
  readonly status: RecordableStatus;
  readonly event?: WebhookEvent | null;
  readonly issueKey?: string | null;
  readonly eventTimestamp?: Date | null;
  readonly payload?: Record<string, unknown> | null;
  readonly invalidReason?: string | null;
  readonly receivedAt?: Date;
}

export type RecordDeliveryResult =
  | { readonly recorded: true; readonly id: ObjectId }
  /** The same delivery arrived before. The stored record is left untouched. */
  | { readonly recorded: false; readonly id: ObjectId; readonly duplicate: true };

export interface WebhookDeliveryRepository {
  record(input: RecordDeliveryInput): Promise<RecordDeliveryResult>;
  findByDeliveryId(deliveryId: string): Promise<WebhookDeliveryDocument | null>;
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;
}

export function createWebhookDeliveryRepository(
  db: Db,
  logger: Logger,
): WebhookDeliveryRepository {
  const collection: Collection<WebhookDeliveryDocument> = db.collection(
    COLLECTIONS.webhookDeliveries,
  );

  return {
    async record(input: RecordDeliveryInput): Promise<RecordDeliveryResult> {
      const now = input.receivedAt ?? new Date();
      const document: WebhookDeliveryDocument = {
        deliveryId: input.deliveryId,
        event: input.event ?? null,
        issueKey: input.issueKey ?? null,
        eventTimestamp: input.eventTimestamp ?? null,
        payload: input.payload ?? null,
        status: input.status,
        invalidReason: input.invalidReason ?? null,
        attempts: 0,
        maxAttempts: WEBHOOK_DELIVERY_MAX_ATTEMPTS,
        // Eligible immediately; Phase 4 moves this forward on each retry.
        nextAttemptAt: now,
        lastError: null,
        intakeItemId: null,
        receivedAt: now,
        updatedAt: now,
      };

      try {
        const result = await collection.insertOne(document);
        // issueKey is safe to log; payload content is not, and is never logged.
        logger.info('webhook delivery recorded', {
          deliveryId: input.deliveryId,
          status: input.status,
          event: input.event ?? null,
          issueKey: input.issueKey ?? null,
        });
        return { recorded: true, id: result.insertedId };
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;

        // A replay of the same emission. Deliberately not updated: nothing
        // new has arrived, and the first record is the evidence.
        const existing = await collection.findOne({ deliveryId: input.deliveryId });
        if (existing === null) {
          // The unique index rejected the insert but the row is not there —
          // a concurrent delete, or the TTL firing mid-flight. Surfacing it
          // beats returning a duplicate result with no record behind it.
          throw error;
        }
        logger.info('duplicate webhook delivery ignored', { deliveryId: input.deliveryId });
        return { recorded: false, id: existing._id!, duplicate: true };
      }
    },

    async findByDeliveryId(deliveryId: string): Promise<WebhookDeliveryDocument | null> {
      return collection.findOne({ deliveryId });
    },
  };
}
