/**
 * Collection names, document shapes and index specifications.
 *
 * The specs are plain data so they can be asserted in tests with no database
 * connection, and so the one-off setup in src/scripts/init-indexes.ts has a
 * single source of truth to apply.
 *
 * Internal references are ObjectId throughout (decision D1), including
 * auditLog.subjectId. Anything arriving from outside — issueKey, deliveryId —
 * stays a string, because its format belongs to the upstream system.
 */

import type { IndexSpecification, CreateIndexesOptions, Document } from 'mongodb';

export const COLLECTIONS = {
  /** Inbound signed webhook payloads, kept for replay defence and debugging. */
  webhookDeliveries: 'webhookDeliveries',
  /** One row per ingested issue; carries the human approval state. */
  intakeItems: 'intakeItems',
  /** Pipeline executions against an approved intake item. */
  runs: 'runs',
  /** Outputs produced by a run. */
  runArtifacts: 'runArtifacts',
  /** Per-step progress, so a resumed run skips completed work. */
  checkpoints: 'checkpoints',
  /** Transactional outbox for writes back to Neutara. */
  outboundWrites: 'outboundWrites',
  /**
   * Structured requirements produced from an intake item's snapshot, for the
   * later Coding Agent. One row per intake item; the original intakeItems
   * document is never written to by this stage.
   */
  requirementsAnalyses: 'requirementsAnalyses',
  /**
   * Authorized mappings from a Neutara project (spaceKey) to a GitHub
   * repository. The sole source of truth for which repositories a run may
   * ever be pointed at — never a ticket-supplied URL. Managed by operators,
   * not written to by any pipeline code.
   */
  repositoryRegistry: 'repositoryRegistry',
  /**
   * One row per run: the outcome of matching its intake item's project
   * against `repositoryRegistry`, and the human-confirmed result once
   * chosen. Deliberately separate from `runs` and `intakeItems` — neither
   * gets a repository-selection status of its own, the same reason
   * `requirementsAnalyses` was kept separate from `intakeItems`.
   */
  repositorySelections: 'repositorySelections',
  /**
   * Append-only record of every state change. Enforced by the database:
   * aisdlcAppRole grants `find` and `insert` on this collection and nothing
   * else. See docs/atlas-roles.md, and src/db/audit-log.ts for the
   * application-level guard layered on top.
   */
  auditLog: 'auditLog',
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

export const COLLECTION_NAMES: readonly CollectionName[] = Object.values(COLLECTIONS);

/* ── Status vocabularies ──────────────────────────────────────────────────
 * Declared once and used for both the TypeScript type and the server-side
 * validator, so the two cannot drift apart.
 */

export const INTAKE_STATUSES = [
  'received',
  'pending_approval',
  'approved',
  'rejected',
  'failed',
] as const;
export type IntakeStatus = (typeof INTAKE_STATUSES)[number];

/** How an intake item entered the system. */
export const INTAKE_SOURCES = ['webhook', 'manual', 'backfill'] as const;
export type IntakeSource = (typeof INTAKE_SOURCES)[number];

/**
 * Events Neutara can send, taken from `ConnectorEvent` in its
 * connector-service. This list mirrors the sender; it is not ours to choose.
 */
export const WEBHOOK_EVENTS = [
  'issue.created',
  'issue.updated',
  'issue.deleted',
  'issue.status_changed',
  'issue.assigned',
  'issue.commented',
  'issue.department_changed',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/**
 * Events that queue for enrichment. Everything else is recorded as `ignored`.
 *
 * Recorded rather than discarded: the delivery is signed evidence of what
 * Neutara sent, and widening this list later should not leave a gap in the
 * history.
 */
export const ACCEPTED_WEBHOOK_EVENTS: readonly WebhookEvent[] = ['issue.created'];

export const WEBHOOK_DELIVERY_STATUSES = [
  /** Valid and accepted; awaiting Phase 4 enrichment. */
  'pending',
  /** Valid, but the event type is not accepted. */
  'ignored',
  /** Authenticated but failed validation. `invalidReason` says why. */
  'invalid',
  /** Phase 4: an intake item was created. */
  'enriched',
  /** Phase 4: maxAttempts exhausted; needs a human. */
  'failed',
] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

/** Retry ceiling for Phase 4 enrichment, stored on each delivery. */
export const WEBHOOK_DELIVERY_MAX_ATTEMPTS = 5;

export const RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * What caused a run to be queued. Only 'approval' exists for this phase (the
 * orchestrator queues a run the moment an intake item is approved); a future
 * manual-retry path would add its own value here rather than overload this
 * one, since the two need different duplicate-prevention rules (see
 * INDEXES[runs] below).
 */
export const RUN_TRIGGERS = ['approval'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/**
 * Scoped to `requirementsAnalyses`, not the intake item itself: the intake
 * state machine in src/intake/state.ts is unrelated and unchanged by this.
 */
export const REQUIREMENTS_ANALYSIS_STATUSES = ['pending', 'completed', 'failed'] as const;
export type RequirementsAnalysisStatus = (typeof REQUIREMENTS_ANALYSIS_STATUSES)[number];

/** A mapping is either usable for selection or not. There is no "pending" state — an entry is authored complete. */
export const REPOSITORY_REGISTRY_STATUSES = ['active', 'inactive'] as const;
export type RepositoryRegistryStatus = (typeof REPOSITORY_REGISTRY_STATUSES)[number];

/**
 * Scoped to `repositorySelections`, independent of both `runs.status` and
 * `intakeItems.status` — the same separation `requirementsAnalyses` already
 * established. `pending` covers "exactly one candidate, awaiting the human
 * confirmation decision #2 always requires" — even an unambiguous match is
 * never auto-selected.
 */
export const REPOSITORY_SELECTION_STATUSES = ['pending', 'selected', 'failed', 'ambiguous'] as const;
export type RepositorySelectionStatus = (typeof REPOSITORY_SELECTION_STATUSES)[number];

export const CHECKPOINT_STATUSES = [
  /** Executing, or the worker died mid-step. Resume re-runs it. */
  'running',
  /** Finished successfully. Resume skips it when inputHash still matches. */
  'completed',
  /** Failed with retries remaining. Resume re-runs with attempt + 1. */
  'failed',
  /** Deliberately not executed because its condition was not met. */
  'skipped',
  /** Paused at the human approval gate. */
  'awaiting_approval',
] as const;
export type CheckpointStatus = (typeof CHECKPOINT_STATUSES)[number];

export const OUTBOUND_WRITE_STATUSES = [
  'pending',
  'in_flight',
  'succeeded',
  'failed',
  /** maxAttempts exhausted. Terminal; needs a human. */
  'abandoned',
  'cancelled',
] as const;
export type OutboundWriteStatus = (typeof OUTBOUND_WRITE_STATUSES)[number];

export const OUTBOUND_WRITE_OPERATIONS = [
  'create_comment',
  'update_issue',
  'transition_issue',
  'attach_file',
  'create_issue',
] as const;
export type OutboundWriteOperation = (typeof OUTBOUND_WRITE_OPERATIONS)[number];

/** Every kind of thing an audit entry can be about. */
export const AUDIT_SUBJECT_TYPES = [
  'intakeItem',
  'run',
  'runArtifact',
  'checkpoint',
  'outboundWrite',
  'webhookDelivery',
  'repositoryRegistryEntry',
  'repositorySelection',
] as const;
export type AuditSubjectType = (typeof AUDIT_SUBJECT_TYPES)[number];

/**
 * Inline-output size limit for a checkpoint (decision D3).
 *
 * Step output at or under this goes in `checkpoints.output`; anything larger
 * is written to runArtifacts and referenced by `outputArtifactId`. Without a
 * ceiling, a verbose step eventually hits MongoDB's 16 MB document cap.
 */
export const CHECKPOINT_INLINE_OUTPUT_MAX_BYTES = 16 * 1024;

/**
 * Retention for raw inbound webhook payloads: 90 days.
 *
 * Long enough for incident investigation, short enough not to hold customer
 * ticket text indefinitely. Dedupe does not depend on it — intakeItems.issueKey
 * is uniquely indexed, so a redelivery after expiry still cannot create a
 * second intake item, and auditLog keeps the fact of receipt permanently.
 */
export const WEBHOOK_DELIVERY_RETENTION_SECONDS = 90 * 24 * 60 * 60;

export interface IndexDefinition {
  /** Explicit name so re-running setup is idempotent and drift is visible. */
  readonly name: string;
  readonly key: IndexSpecification;
  readonly options?: CreateIndexesOptions;
}

export const INDEXES: Readonly<Record<CollectionName, readonly IndexDefinition[]>> = {
  [COLLECTIONS.webhookDeliveries]: [
    // Dedupe key. A redelivered issue.created must not create a second intake item.
    { name: 'deliveryId_unique', key: { deliveryId: 1 }, options: { unique: true } },
    {
      name: 'receivedAt_ttl',
      key: { receivedAt: 1 },
      options: { expireAfterSeconds: WEBHOOK_DELIVERY_RETENTION_SECONDS },
    },
    // The Phase 4 enrichment drain: pending deliveries whose time has come.
    { name: 'status_nextAttemptAt', key: { status: 1, nextAttemptAt: 1 } },
    // "What have we heard about this issue?"
    { name: 'issueKey_receivedAt', key: { issueKey: 1, receivedAt: -1 } },
  ],
  [COLLECTIONS.intakeItems]: [
    { name: 'issueKey_unique', key: { issueKey: 1 }, options: { unique: true } },
    { name: 'status_createdAt', key: { status: 1, createdAt: -1 } },
    { name: 'createdAt_desc', key: { createdAt: -1 } },
  ],
  [COLLECTIONS.runs]: [
    // The idempotency guard for this phase: the orchestrator queues at most
    // one run per approved intake item. This makes intakeItemId_startedAt
    // below temporarily redundant (there can only ever be one row per
    // intakeItemId), kept anyway because a future retry/re-run path will
    // need to relax this to a compound key (e.g. {intakeItemId, trigger}),
    // at which point run-history-by-intake-item becomes meaningful again.
    { name: 'intakeItemId_unique', key: { intakeItemId: 1 }, options: { unique: true } },
    { name: 'intakeItemId_startedAt', key: { intakeItemId: 1, startedAt: -1 } },
    { name: 'status_startedAt', key: { status: 1, startedAt: -1 } },
  ],
  [COLLECTIONS.runArtifacts]: [
    { name: 'runId_kind', key: { runId: 1, kind: 1 } },
    { name: 'createdAt_desc', key: { createdAt: -1 } },
  ],
  [COLLECTIONS.checkpoints]: [
    // The resume lookup, and the guard against duplicate checkpoints (D2):
    // a retry updates this record in place rather than appending a new one.
    { name: 'runId_step_unique', key: { runId: 1, step: 1 }, options: { unique: true } },
    // `step` is a name, not an order; resume needs the first incomplete step.
    { name: 'runId_sequence', key: { runId: 1, sequence: 1 } },
    { name: 'status_updatedAt', key: { status: 1, updatedAt: 1 } },
  ],
  [COLLECTIONS.outboundWrites]: [
    // The double-write guard. A retry after an ambiguous failure must not
    // create a second comment or repeat a transition in Neutara.
    { name: 'idempotencyKey_unique', key: { idempotencyKey: 1 }, options: { unique: true } },
    { name: 'status_nextAttemptAt', key: { status: 1, nextAttemptAt: 1 } },
    // Reclaim rows whose worker died holding the lease.
    { name: 'status_leaseExpiresAt', key: { status: 1, leaseExpiresAt: 1 } },
    { name: 'runId_createdAt', key: { runId: 1, createdAt: -1 } },
  ],
  [COLLECTIONS.auditLog]: [
    { name: 'occurredAt_desc', key: { occurredAt: -1 } },
    { name: 'subject_occurredAt', key: { subjectType: 1, subjectId: 1, occurredAt: -1 } },
  ],
  [COLLECTIONS.requirementsAnalyses]: [
    // The retry/duplicate guard: one analysis row per intake item, updated in
    // place on retry rather than appended to.
    { name: 'intakeItemId_unique', key: { intakeItemId: 1 }, options: { unique: true } },
    { name: 'issueKey_createdAt', key: { issueKey: 1, createdAt: -1 } },
    { name: 'status_updatedAt', key: { status: 1, updatedAt: 1 } },
  ],
  [COLLECTIONS.repositoryRegistry]: [
    // "Prevent duplicate active mappings that would cause ambiguous
    // selection" (requirement 13) means the SAME repository must not be
    // registered twice as active for the SAME project — not that only one
    // repository may ever be active per project, which is exactly the
    // legitimate "multiple matches -> ambiguous" case decision #6 requires
    // supporting. A partial unique index expresses precisely that: unique
    // among active documents only, so a deactivated-then-recreated entry,
    // or two genuinely different repositories active for one project, are
    // both still allowed.
    {
      name: 'projectIdentifier_repositoryId_active_unique',
      key: { projectIdentifier: 1, repositoryId: 1 },
      options: { unique: true, partialFilterExpression: { status: 'active' } },
    },
    // The lookup this whole feature exists to serve: "active mappings for
    // this project" (Phase 3 requirement 6).
    { name: 'projectIdentifier_status', key: { projectIdentifier: 1, status: 1 } },
  ],
  [COLLECTIONS.repositorySelections]: [
    // Requirement: "each run may select only one repository" / "prevent
    // duplicate selection records" — one selection row per run, ever.
    { name: 'runId_unique', key: { runId: 1 }, options: { unique: true } },
    // The retry worker's poll query: unresolved selections due for
    // re-evaluation. Mirrors webhookDeliveries.status_nextAttemptAt exactly.
    { name: 'status_nextAttemptAt', key: { status: 1, nextAttemptAt: 1 } },
  ],
};

/* ── Validators ───────────────────────────────────────────────────────────
 * Applied by the migration user only. aisdlc_app has no collMod privilege,
 * so the service cannot weaken its own constraints at runtime.
 */

/**
 * Validator for the audit log.
 *
 * Note what this does and does not do. It constrains the SHAPE of an insert.
 * It does not make the collection append-only — a $jsonSchema validator has
 * nothing to say about updateOne or deleteMany.
 *
 * Append-only comes from role privileges instead: `aisdlcAppRole` grants
 * `find` and `insert` on this collection and nothing else, so an update or
 * delete from the service is refused by the SERVER. The guard in
 * src/db/audit-log.ts is defence in depth on top of that, catching mistakes
 * in our own code before they reach the wire.
 *
 * The service also cannot weaken this validator at runtime: `collMod` belongs
 * to `aisdlcMigratorRole`, whose credential the service never loads.
 */
export const AUDIT_LOG_VALIDATOR: Document = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['occurredAt', 'actor', 'action', 'subjectType', 'subjectId'],
    additionalProperties: true,
    properties: {
      occurredAt: { bsonType: 'date' },
      actor: { bsonType: 'string', minLength: 1 },
      action: { bsonType: 'string', minLength: 1 },
      subjectType: { enum: [...AUDIT_SUBJECT_TYPES] },
      subjectId: { bsonType: 'objectId' },
      detail: { bsonType: 'object' },
    },
  },
};

/**
 * Prefix marking a principal as a human operator rather than a service.
 *
 * Load-bearing: it is what lets the database tell an operator apart from the
 * pipeline that is asking to be approved.
 */
export const OPERATOR_PRINCIPAL_PREFIX = 'operator:';

export const INTAKE_ITEM_SCHEMA: Document = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['issueKey', 'source', 'snapshot', 'sourceHash', 'status', 'receivedAt', 'createdAt'],
    additionalProperties: true,
    properties: {
      // Format belongs to Neutara, so this stays a string rather than an id.
      issueKey: { bsonType: 'string', minLength: 1 },
      source: { enum: [...INTAKE_SOURCES] },
      deliveryRef: { bsonType: ['objectId', 'null'] },
      snapshot: {
        bsonType: 'object',
        required: ['title', 'description', 'issueType'],
        properties: {
          title: { bsonType: 'string' },
          description: { bsonType: 'string' },
          issueType: { bsonType: 'string' },
          priority: { bsonType: ['string', 'null'] },
          reporter: { bsonType: ['string', 'null'] },
          project: { bsonType: ['string', 'null'] },
          // Hashed order-independently; see hashSnapshot in the repository.
          labels: { bsonType: ['array', 'null'], items: { bsonType: 'string' } },
          parentKey: { bsonType: ['string', 'null'] },
        },
      },
      /**
       * Stored context that is deliberately NOT hashed: status and assignee
       * change constantly, and hashing them would invalidate every checkpoint
       * for an issue whenever someone reassigned it.
       */
      snapshotMeta: { bsonType: ['object', 'null'] },
      // What makes checkpoints.inputHash meaningful: resume can only reuse a
      // completed step if it can prove the intake content has not changed.
      sourceHash: { bsonType: 'string', minLength: 1 },
      status: { enum: [...INTAKE_STATUSES] },
      statusReason: { bsonType: ['string', 'null'] },
      // Populated at Phase 6. The fields exist now so the shape is stable.
      approvedBy: { bsonType: ['string', 'null'] },
      approvedAt: { bsonType: ['date', 'null'] },
      receivedAt: { bsonType: 'date' },
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' },
    },
  },
};

/**
 * An approved item must name a human approver.
 *
 * Without this, a pipeline calling `transition(key, 'approved', { actor:
 * 'svc:worker' })` records itself as the approver — and because decision D5
 * has the outbound worker reject only a NULL `approvedBy`, a self-approved
 * item would sail straight through the gate. The application enforces this
 * too (see src/intake/repository.ts), but enforcing it here means it holds
 * for any writer holding the app credential, not only for our code.
 *
 * Expressed as a query clause rather than $jsonSchema because JSON Schema
 * draft 4, which MongoDB implements, has no conditional construct.
 */
export const APPROVAL_REQUIRES_OPERATOR_CLAUSE: Document = {
  $or: [
    { status: { $ne: 'approved' } },
    { approvedBy: { $regex: `^${OPERATOR_PRINCIPAL_PREFIX}` } },
  ],
};

/** Shape constraints and the approval rule, combined. */
export const INTAKE_ITEM_VALIDATOR: Document = {
  $and: [INTAKE_ITEM_SCHEMA, APPROVAL_REQUIRES_OPERATOR_CLAUSE],
};

/**
 * Validator for inbound webhook deliveries.
 *
 * `event`, `issueKey`, `eventTimestamp` and `payload` are nullable because an
 * authenticated but malformed delivery is still recorded: the signature
 * proves Neutara sent it, and it is the evidence that the upstream contract
 * has drifted. When JSON.parse fails there is no object to store, so only the
 * body hash in `deliveryId` identifies it.
 */
export const WEBHOOK_DELIVERY_VALIDATOR: Document = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['deliveryId', 'status', 'attempts', 'maxAttempts', 'nextAttemptAt', 'receivedAt'],
    additionalProperties: true,
    properties: {
      // sha256 of the raw request body. Neutara sends no delivery id, so the
      // body hash is the natural key: `timestamp` is inside the signed body,
      // which makes each emission unique while a replay hashes identically.
      deliveryId: { bsonType: 'string', pattern: '^[0-9a-f]{64}$' },
      event: { enum: [...WEBHOOK_EVENTS, null] },
      issueKey: { bsonType: ['string', 'null'] },
      eventTimestamp: { bsonType: ['date', 'null'] },
      payload: { bsonType: ['object', 'null'] },
      status: { enum: [...WEBHOOK_DELIVERY_STATUSES] },
      invalidReason: { bsonType: ['string', 'null'] },
      attempts: { bsonType: 'int', minimum: 0 },
      maxAttempts: { bsonType: 'int', minimum: 1 },
      nextAttemptAt: { bsonType: 'date' },
      lastError: { bsonType: ['object', 'null'] },
      intakeItemId: { bsonType: ['objectId', 'null'] },
      receivedAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' },
    },
  },
};

export const CHECKPOINT_VALIDATOR: Document = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['runId', 'step', 'sequence', 'status', 'attempt', 'inputHash', 'startedAt'],
    additionalProperties: true,
    properties: {
      runId: { bsonType: 'objectId' },
      step: { bsonType: 'string', minLength: 1 },
      sequence: { bsonType: 'int', minimum: 0 },
      status: { enum: [...CHECKPOINT_STATUSES] },
      attempt: { bsonType: 'int', minimum: 1 },
      // Guards correctness on resume: a completed checkpoint is only safe to
      // reuse when the step's input is byte-identical to last time.
      inputHash: { bsonType: 'string', minLength: 1 },
      output: { bsonType: ['object', 'null'] },
      outputArtifactId: { bsonType: ['objectId', 'null'] },
      error: { bsonType: ['object', 'null'] },
      usage: { bsonType: ['object', 'null'] },
      startedAt: { bsonType: 'date' },
      completedAt: { bsonType: ['date', 'null'] },
      updatedAt: { bsonType: 'date' },
    },
  },
};

export const OUTBOUND_WRITE_VALIDATOR: Document = {
  $jsonSchema: {
    bsonType: 'object',
    required: [
      'idempotencyKey',
      'runId',
      'intakeItemId',
      'operation',
      'target',
      'payload',
      'status',
      'attempts',
      'maxAttempts',
      'nextAttemptAt',
      'createdAt',
    ],
    additionalProperties: true,
    properties: {
      idempotencyKey: { bsonType: 'string', minLength: 1 },
      runId: { bsonType: 'objectId' },
      intakeItemId: { bsonType: 'objectId' },
      operation: { enum: [...OUTBOUND_WRITE_OPERATIONS] },
      target: {
        bsonType: 'object',
        required: ['issueKey'],
        properties: {
          issueKey: { bsonType: 'string', minLength: 1 },
          resourceId: { bsonType: ['string', 'null'] },
        },
      },
      payload: { bsonType: 'object' },
      status: { enum: [...OUTBOUND_WRITE_STATUSES] },
      attempts: { bsonType: 'int', minimum: 0 },
      maxAttempts: { bsonType: 'int', minimum: 1 },
      nextAttemptAt: { bsonType: 'date' },
      leaseOwner: { bsonType: ['string', 'null'] },
      leaseExpiresAt: { bsonType: ['date', 'null'] },
      // Decision D5: the drain worker refuses any row where this is null.
      // The validator permits null so a row can be enqueued before approval;
      // the refusal is the worker's job, not the schema's.
      approvedBy: { bsonType: ['string', 'null'] },
      approvedAt: { bsonType: ['date', 'null'] },
      lastError: { bsonType: ['object', 'null'] },
      response: { bsonType: ['object', 'null'] },
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' },
      completedAt: { bsonType: ['date', 'null'] },
    },
  },
};

/** Default retry ceiling for an outbound write before it is abandoned. */
export const OUTBOUND_WRITE_MAX_ATTEMPTS = 5;

/**
 * Validator for requirements analyses.
 *
 * `inputHash` is what makes a `completed` row safe to reuse: it is only
 * skipped on a retry when the intake snapshot's hash still matches, the same
 * parity `checkpoints.inputHash` gives run resume. `result` and `error` are
 * freeform objects rather than fully specified here, matching how `detail` is
 * handled on `auditLog` — the shape is owned by src/requirements/analyzer.ts.
 */
export const REQUIREMENTS_ANALYSIS_VALIDATOR: Document = {
  $jsonSchema: {
    bsonType: 'object',
    required: [
      'intakeItemId',
      'issueKey',
      'status',
      'inputHash',
      'attempts',
      'agentVersion',
      'createdAt',
      'updatedAt',
    ],
    additionalProperties: true,
    properties: {
      intakeItemId: { bsonType: 'objectId' },
      // Format belongs to Neutara, so this stays a string rather than an id;
      // denormalized from intakeItems for convenient lookup and logging.
      issueKey: { bsonType: 'string', minLength: 1 },
      status: { enum: [...REQUIREMENTS_ANALYSIS_STATUSES] },
      inputHash: { bsonType: 'string', minLength: 1 },
      result: { bsonType: ['object', 'null'] },
      error: { bsonType: ['object', 'null'] },
      attempts: { bsonType: 'int', minimum: 0 },
      // Which analyzer produced (or attempted) the result. 'stub-v1' for now;
      // a real LLM-backed agent is a version bump, not a schema change.
      agentVersion: { bsonType: 'string', minLength: 1 },
      // Set only for an LLM-backed run, via recordUsage() — independent of
      // `result`, which stays exactly the RequirementsResult shape.
      usage: { bsonType: ['object', 'null'] },
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' },
      completedAt: { bsonType: ['date', 'null'] },
    },
  },
};

/**
 * Validator for pipeline runs.
 *
 * This phase only ever creates a run in `queued` status, via the
 * orchestrator — see src/orchestrator/repository.ts. `startedAt` and
 * `completedAt` exist now so the shape is stable for a future Coding Agent
 * to fill in, the same way intakeItems.approvedBy existed before Phase 6
 * populated it.
 */
export const RUN_VALIDATOR: Document = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['intakeItemId', 'issueKey', 'status', 'trigger', 'createdAt', 'updatedAt'],
    additionalProperties: true,
    properties: {
      intakeItemId: { bsonType: 'objectId' },
      // Format belongs to Neutara, so this stays a string; denormalized from
      // intakeItems for convenient lookup and logging, same as elsewhere.
      issueKey: { bsonType: 'string', minLength: 1 },
      status: { enum: [...RUN_STATUSES] },
      trigger: { enum: [...RUN_TRIGGERS] },
      createdAt: { bsonType: 'date' },
      startedAt: { bsonType: ['date', 'null'] },
      completedAt: { bsonType: ['date', 'null'] },
      updatedAt: { bsonType: 'date' },
    },
  },
};

/**
 * Validator for the repository registry.
 *
 * `repositoryUrl` here is validated for SHAPE only (a well-formed GitHub
 * URL) — that is not authorization. Authorization is "this URL came from a
 * document in this collection at all"; nothing in the rest of the system
 * ever accepts a repository URL from anywhere else. `accessPolicy` is
 * deliberately untyped beyond object/null: it may only ever hold non-secret
 * GitHub App metadata (e.g. an installation id), never a credential or
 * private key — enforced by convention and code review, not by this
 * validator, since the concrete shape isn't decided yet (GitHub App
 * integration is future work).
 */
export const REPOSITORY_REGISTRY_VALIDATOR: Document = {
  $jsonSchema: {
    bsonType: 'object',
    required: [
      'projectIdentifier',
      'repositoryId',
      'repositoryUrl',
      'defaultBranch',
      'allowedBranches',
      'status',
      'createdAt',
      'updatedAt',
      'createdBy',
      'updatedBy',
    ],
    additionalProperties: true,
    properties: {
      // Neutara's spaceKey. A lookup key only, never itself a source of
      // authorization.
      projectIdentifier: { bsonType: 'string', minLength: 1 },
      repositoryId: { bsonType: 'string', minLength: 1 },
      repositoryUrl: { bsonType: 'string', minLength: 1 },
      defaultBranch: { bsonType: 'string', minLength: 1 },
      allowedBranches: {
        bsonType: 'array',
        minItems: 1,
        items: { bsonType: 'string', minLength: 1 },
      },
      status: { enum: [...REPOSITORY_REGISTRY_STATUSES] },
      // Non-secret GitHub App metadata only — see the module comment above.
      accessPolicy: { bsonType: ['object', 'null'] },
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' },
      createdBy: { bsonType: 'string', minLength: 1 },
      updatedBy: { bsonType: 'string', minLength: 1 },
    },
  },
};

/**
 * Validator for repository selections.
 *
 * `selected*` fields are a SNAPSHOT taken at confirmation time (requirement:
 * "future registry changes do not alter the stored selection snapshot") —
 * they are never re-read from `repositoryRegistry` after that point, so
 * they are typed independently of it here rather than by reference.
 */
export const REPOSITORY_SELECTION_VALIDATOR: Document = {
  $jsonSchema: {
    bsonType: 'object',
    required: [
      'runId',
      'intakeItemId',
      'issueKey',
      'projectIdentifier',
      'candidateRepositoryIds',
      'status',
      'attempts',
      'nextAttemptAt',
      'createdAt',
      'updatedAt',
    ],
    additionalProperties: true,
    properties: {
      runId: { bsonType: 'objectId' },
      intakeItemId: { bsonType: 'objectId' },
      issueKey: { bsonType: 'string', minLength: 1 },
      projectIdentifier: { bsonType: 'string', minLength: 1 },
      candidateRepositoryIds: { bsonType: 'array', items: { bsonType: 'string', minLength: 1 } },
      selectedRepositoryId: { bsonType: ['string', 'null'] },
      selectedRepositoryUrl: { bsonType: ['string', 'null'] },
      selectedDefaultBranch: { bsonType: ['string', 'null'] },
      selectedAllowedBranches: { bsonType: ['array', 'null'], items: { bsonType: 'string' } },
      selectedAccessPolicy: { bsonType: ['object', 'null'] },
      status: { enum: [...REPOSITORY_SELECTION_STATUSES] },
      failureReason: { bsonType: ['string', 'null'] },
      attempts: { bsonType: 'int', minimum: 0 },
      nextAttemptAt: { bsonType: 'date' },
      confirmedBy: { bsonType: ['string', 'null'] },
      confirmedAt: { bsonType: ['date', 'null'] },
      // Set once, alongside a transition INTO failed/ambiguous, so a
      // repeated retry that lands on the same outcome does not re-notify.
      lastNotifiedStatus: { bsonType: ['string', 'null'] },
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' },
    },
  },
};

/** Collections created with options, rather than implicitly on first write. */
export const COLLECTION_OPTIONS: Partial<Record<CollectionName, Document>> = {
  [COLLECTIONS.webhookDeliveries]: {
    validator: WEBHOOK_DELIVERY_VALIDATOR,
    validationLevel: 'strict',
    validationAction: 'error',
  },
  [COLLECTIONS.intakeItems]: {
    validator: INTAKE_ITEM_VALIDATOR,
    validationLevel: 'strict',
    validationAction: 'error',
  },
  [COLLECTIONS.checkpoints]: {
    validator: CHECKPOINT_VALIDATOR,
    validationLevel: 'strict',
    validationAction: 'error',
  },
  [COLLECTIONS.outboundWrites]: {
    validator: OUTBOUND_WRITE_VALIDATOR,
    validationLevel: 'strict',
    validationAction: 'error',
  },
  [COLLECTIONS.requirementsAnalyses]: {
    validator: REQUIREMENTS_ANALYSIS_VALIDATOR,
    validationLevel: 'strict',
    validationAction: 'error',
  },
  [COLLECTIONS.runs]: {
    validator: RUN_VALIDATOR,
    validationLevel: 'strict',
    validationAction: 'error',
  },
  [COLLECTIONS.repositoryRegistry]: {
    validator: REPOSITORY_REGISTRY_VALIDATOR,
    validationLevel: 'strict',
    validationAction: 'error',
  },
  [COLLECTIONS.repositorySelections]: {
    validator: REPOSITORY_SELECTION_VALIDATOR,
    validationLevel: 'strict',
    validationAction: 'error',
  },
  [COLLECTIONS.auditLog]: {
    validator: AUDIT_LOG_VALIDATOR,
    validationLevel: 'strict',
    validationAction: 'error',
  },
};

/** Flattened view of every index, for setup and for tests. */
export function allIndexes(): readonly { collection: CollectionName; index: IndexDefinition }[] {
  return COLLECTION_NAMES.flatMap((collection) =>
    (INDEXES[collection] ?? []).map((index) => ({ collection, index })),
  );
}
