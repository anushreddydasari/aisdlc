/**
 * Intake repository — the domain layer for `intakeItems`.
 *
 * No HTTP here (decision P3): Phase 1 is the repository and state machine
 * only. The webhook that feeds it arrives at Phase 3, and the operator
 * approval endpoints at Phase 6.
 *
 * Every state change writes an audit entry through `createAuditLog`, so the
 * history of an intake item is reconstructable from `auditLog` alone. Note
 * the ordering guarantee this does and does not give: the document update and
 * the audit append are two separate writes, not a transaction — see
 * `transition` below.
 */

import type { Db, Filter, ObjectId } from 'mongodb';

import type { Logger } from '../logging/logger.ts';
import type { AuditLog } from '../db/audit-log.ts';
import {
  COLLECTIONS,
  OPERATOR_PRINCIPAL_PREFIX,
  type IntakeSource,
  type IntakeStatus,
} from '../db/collections.ts';
import { contentHash } from './hash.ts';
import { INITIAL_INTAKE_STATUS, assertTransition } from './state.ts';

/**
 * The content of an issue that affects what work is appropriate.
 *
 * Every field here feeds `sourceHash`, and therefore decides when a completed
 * checkpoint stops being safe to reuse. Adding a field means a change to it
 * invalidates resumed work — so high-churn fields (status, assignee) and
 * unbounded ones (comments, attachments) belong in `IntakeSnapshotMeta`
 * instead, which is stored but not hashed.
 */
export interface IntakeSnapshot {
  readonly title: string;
  readonly description: string;
  readonly issueType: string;
  readonly priority?: string | null;
  readonly reporter?: string | null;
  readonly project?: string | null;
  /** Hashed order-independently; see hashSnapshot. */
  readonly labels?: readonly string[] | null;
  readonly parentKey?: string | null;
}

/**
 * Context worth keeping but deliberately NOT hashed.
 *
 * `status` and `assignee` change constantly; hashing them would invalidate
 * every checkpoint for an issue each time someone reassigns it.
 * `descriptionTruncated` records that Neutara capped an oversized
 * description, which explains an otherwise puzzling hash change.
 */
export interface IntakeSnapshotMeta {
  readonly createdAt?: string | null;
  readonly cfKey?: string | null;
  readonly status?: string | null;
  readonly assignee?: string | null;
  readonly spaceName?: string | null;
  readonly descriptionTruncated?: boolean;
  readonly fetchedAt?: Date;
}

export interface IntakeItemDocument {
  _id?: ObjectId;
  issueKey: string;
  source: IntakeSource;
  deliveryRef: ObjectId | null;
  snapshot: IntakeSnapshot;
  snapshotMeta: IntakeSnapshotMeta | null;
  sourceHash: string;
  status: IntakeStatus;
  statusReason: string | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  receivedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateIntakeInput {
  readonly issueKey: string;
  readonly source: IntakeSource;
  readonly snapshot: IntakeSnapshot;
  readonly snapshotMeta?: IntakeSnapshotMeta | null;
  readonly deliveryRef?: ObjectId | null;
  readonly receivedAt?: Date;
}

export interface CreateIntakeResult {
  readonly id: ObjectId;
  /** False when an item for this issueKey already existed. */
  readonly created: boolean;
  readonly item: IntakeItemDocument;
}

export interface TransitionOptions {
  readonly actor: string;
  readonly reason?: string;
}

export interface ApprovalOptions extends TransitionOptions {
  /**
   * Required, and must be a human operator (`operator:` prefix).
   *
   * There is deliberately no fallback to `actor`. An earlier version defaulted
   * `approvedBy` to the acting identity, which meant a pipeline calling
   * `transition(key, 'approved', { actor: 'svc:worker' })` recorded itself as
   * the approver. Because decision D5 has the outbound worker reject only a
   * NULL `approvedBy`, that default guaranteed the field was never null and
   * the approval gate could never fire.
   */
  readonly approvedBy: string;
}

/** Approval requires an operator; every other transition does not. */
export type TransitionArgs<T extends IntakeStatus> = T extends 'approved'
  ? ApprovalOptions
  : TransitionOptions;

export class ApprovalRequiresOperatorError extends Error {
  readonly approvedBy: string;

  constructor(approvedBy: string) {
    super(
      `approvedBy must identify a human operator (prefix '${OPERATOR_PRINCIPAL_PREFIX}'), ` +
        'so a service identity cannot approve its own work. ' +
        `Received a principal that does not carry that prefix.`,
    );
    this.name = 'ApprovalRequiresOperatorError';
    // Held for callers; not interpolated into the message, which is logged.
    this.approvedBy = approvedBy;
  }
}

export class IntakeNotFoundError extends Error {
  constructor(issueKey: string) {
    super(`no intake item for issueKey '${issueKey}'`);
    this.name = 'IntakeNotFoundError';
  }
}

export class IntakeConflictError extends Error {
  constructor(issueKey: string) {
    super(
      `intake item '${issueKey}' changed while the transition was in flight; ` +
        'read it again and retry',
    );
    this.name = 'IntakeConflictError';
  }
}

export interface IntakeRepository {
  /** Idempotent on issueKey: a redelivery returns the existing item. */
  create(input: CreateIntakeInput): Promise<CreateIntakeResult>;
  findByIssueKey(issueKey: string): Promise<IntakeItemDocument | null>;
  list(filter?: Filter<IntakeItemDocument>, limit?: number): Promise<IntakeItemDocument[]>;
  /**
   * Moves an item to `to`, refusing illegal transitions.
   *
   * Moving to `approved` requires `approvedBy` naming a human operator —
   * omitting it is a compile error, and a non-operator principal throws.
   */
  transition<T extends IntakeStatus>(
    issueKey: string,
    to: T,
    options: TransitionArgs<T>,
  ): Promise<IntakeItemDocument>;
}

/** MongoDB duplicate-key error, raised when two writers race on issueKey. */
function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;
}

/**
 * Only the fields that describe the issue feed the hash — not our bookkeeping.
 *
 * Labels are sorted before hashing. `canonicalize` preserves array order on
 * purpose, because order is content for most lists; for a label set it is
 * not, and an unsorted hash would invalidate checkpoints whenever someone
 * reordered labels without changing them.
 *
 * Fields deliberately excluded: status, assignee, comments, attachments,
 * activity, productType, customerPlan. All are either high-churn or unbounded.
 */
export function hashSnapshot(snapshot: IntakeSnapshot): string {
  return contentHash({
    title: snapshot.title,
    description: snapshot.description,
    issueType: snapshot.issueType,
    priority: snapshot.priority ?? null,
    reporter: snapshot.reporter ?? null,
    project: snapshot.project ?? null,
    labels: snapshot.labels === undefined || snapshot.labels === null ? [] : [...snapshot.labels].sort(),
    parentKey: snapshot.parentKey ?? null,
  });
}

export function createIntakeRepository(
  db: Db,
  audit: AuditLog,
  logger: Logger,
): IntakeRepository {
  const collection = db.collection<IntakeItemDocument>(COLLECTIONS.intakeItems);

  async function requireByIssueKey(issueKey: string): Promise<IntakeItemDocument> {
    const item = await collection.findOne({ issueKey });
    if (item === null) throw new IntakeNotFoundError(issueKey);
    return item;
  }

  return {
    async create(input: CreateIntakeInput): Promise<CreateIntakeResult> {
      const existing = await collection.findOne({ issueKey: input.issueKey });
      if (existing !== null) {
        // A redelivered webhook must not create a second item, and must not
        // overwrite one: the first snapshot is the one already being worked.
        logger.info('intake item already exists; ignoring duplicate', {
          issueKey: input.issueKey,
        });
        return { id: existing._id!, created: false, item: existing };
      }

      const now = new Date();
      const document: IntakeItemDocument = {
        issueKey: input.issueKey,
        source: input.source,
        deliveryRef: input.deliveryRef ?? null,
        snapshot: input.snapshot,
        snapshotMeta: input.snapshotMeta ?? null,
        sourceHash: hashSnapshot(input.snapshot),
        status: INITIAL_INTAKE_STATUS,
        statusReason: null,
        approvedBy: null,
        approvedAt: null,
        receivedAt: input.receivedAt ?? now,
        createdAt: now,
        updatedAt: now,
      };

      let insertedId: ObjectId;
      try {
        insertedId = (await collection.insertOne(document)).insertedId;
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        // Lost a race against a concurrent writer. The unique index on
        // issueKey did its job; return what the winner wrote.
        logger.info('lost insert race on issueKey; returning existing item', {
          issueKey: input.issueKey,
        });
        const winner = await requireByIssueKey(input.issueKey);
        return { id: winner._id!, created: false, item: winner };
      }

      await audit.append({
        actor: `source:${input.source}`,
        action: 'intake.received',
        subjectType: 'intakeItem',
        subjectId: insertedId,
        detail: { issueKey: input.issueKey, sourceHash: document.sourceHash },
      });

      logger.info('intake item created', {
        issueKey: input.issueKey,
        source: input.source,
        status: document.status,
      });

      return { id: insertedId, created: true, item: { ...document, _id: insertedId } };
    },

    async findByIssueKey(issueKey: string): Promise<IntakeItemDocument | null> {
      return collection.findOne({ issueKey });
    },

    async list(
      filter: Filter<IntakeItemDocument> = {},
      limit = 100,
    ): Promise<IntakeItemDocument[]> {
      return collection.find(filter).sort({ createdAt: -1 }).limit(limit).toArray();
    },

    async transition<T extends IntakeStatus>(
      issueKey: string,
      to: T,
      options: TransitionArgs<T>,
    ): Promise<IntakeItemDocument> {
      // The conditional type has done its work at the call site; widen once
      // here so the body can read the optional field.
      const opts = options as TransitionOptions & { readonly approvedBy?: string };

      const current = await requireByIssueKey(issueKey);
      // Captured before the update. Reading `current.status` afterwards would
      // make the audit entry depend on `current` not aliasing the document the
      // update returns — true for the driver, but not a thing to rely on.
      const from = current.status;
      const subjectId = current._id!;

      // Throws InvalidTransitionError before touching the database.
      assertTransition(from, to);

      const now = new Date();
      const update: Partial<IntakeItemDocument> = {
        status: to,
        statusReason: opts.reason ?? null,
        updatedAt: now,
      };
      if (to === 'approved') {
        const approvedBy = opts.approvedBy ?? '';
        // Checked before the write, so a refused approval leaves no trace.
        // The database enforces the same rule independently — see
        // APPROVAL_REQUIRES_OPERATOR_CLAUSE in src/db/collections.ts.
        if (!approvedBy.startsWith(OPERATOR_PRINCIPAL_PREFIX)) {
          throw new ApprovalRequiresOperatorError(approvedBy);
        }
        update.approvedBy = approvedBy;
        update.approvedAt = now;
      }

      // Guarding on the observed status makes this a compare-and-set: if
      // something else moved the item since the read, this matches nothing
      // rather than silently clobbering the other transition.
      const result = await collection.findOneAndUpdate(
        { issueKey, status: from },
        { $set: update },
        { returnDocument: 'after' },
      );

      if (result === null) throw new IntakeConflictError(issueKey);

      // Written after the update, deliberately. These are two writes, not a
      // transaction: a crash in between leaves the item moved with no audit
      // entry. Recorded as a known gap rather than papered over — closing it
      // needs either a transaction or an outbox, and the outbox pattern
      // already exists for Phase 8.
      await audit.append({
        actor: opts.actor,
        action: `intake.${to}`,
        subjectType: 'intakeItem',
        subjectId,
        detail: {
          issueKey,
          from,
          to,
          ...(opts.reason === undefined ? {} : { reason: opts.reason }),
          // Recorded separately from `actor`: the service that carried out the
          // transition is not necessarily the operator who authorised it.
          ...(to === 'approved' ? { approvedBy: opts.approvedBy } : {}),
        },
      });

      logger.info('intake item transitioned', { issueKey, from, to });
      return result;
    },
  };
}
