import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AUDIT_LOG_VALIDATOR,
  AUDIT_SUBJECT_TYPES,
  CHECKPOINT_INLINE_OUTPUT_MAX_BYTES,
  CHECKPOINT_STATUSES,
  CHECKPOINT_VALIDATOR,
  COLLECTIONS,
  COLLECTION_NAMES,
  COLLECTION_OPTIONS,
  INDEXES,
  APPROVAL_REQUIRES_OPERATOR_CLAUSE,
  INTAKE_ITEM_SCHEMA,
  INTAKE_ITEM_VALIDATOR,
  INTAKE_SOURCES,
  INTAKE_STATUSES,
  OPERATOR_PRINCIPAL_PREFIX,
  ACCEPTED_WEBHOOK_EVENTS,
  WEBHOOK_DELIVERY_STATUSES,
  WEBHOOK_DELIVERY_VALIDATOR,
  WEBHOOK_EVENTS,
  OUTBOUND_WRITE_OPERATIONS,
  OUTBOUND_WRITE_STATUSES,
  OUTBOUND_WRITE_VALIDATOR,
  REQUIREMENTS_ANALYSIS_STATUSES,
  REQUIREMENTS_ANALYSIS_VALIDATOR,
  REPOSITORY_REGISTRY_STATUSES,
  REPOSITORY_REGISTRY_VALIDATOR,
  REPOSITORY_SELECTION_STATUSES,
  REPOSITORY_SELECTION_VALIDATOR,
  RUN_STATUSES,
  RUN_TRIGGERS,
  RUN_VALIDATOR,
  WEBHOOK_DELIVERY_RETENTION_SECONDS,
  allIndexes,
} from './collections.ts';

/** The approved design. A rename or omission must fail loudly here. */
const APPROVED_COLLECTIONS = [
  'auditLog',
  'checkpoints',
  'intakeItems',
  'outboundWrites',
  'repositoryRegistry',
  'repositorySelections',
  'requirementsAnalyses',
  'runArtifacts',
  'runs',
  'webhookDeliveries',
] as const;

function schemaOf(validator: Record<string, unknown>): {
  required: string[];
  properties: Record<string, Record<string, unknown>>;
} {
  return validator['$jsonSchema'] as {
    required: string[];
    properties: Record<string, Record<string, unknown>>;
  };
}

describe('collection definitions', () => {
  it('matches the approved design exactly', () => {
    assert.deepEqual([...COLLECTION_NAMES].sort(), [...APPROVED_COLLECTIONS]);
  });

  it('has no duplicate names', () => {
    assert.equal(new Set(COLLECTION_NAMES).size, COLLECTION_NAMES.length);
  });

  it('declares indexes for every collection', () => {
    for (const name of COLLECTION_NAMES) {
      assert.ok(INDEXES[name], `${name} has no index entry`);
      assert.ok(INDEXES[name].length > 0, `${name} declares no indexes`);
    }
  });

  it('no longer exposes the pre-review names', () => {
    const names: readonly string[] = COLLECTION_NAMES;
    assert.ok(!names.includes('artifacts'), 'artifacts should be runArtifacts');
    assert.ok(!names.includes('webhookEvents'), 'webhookEvents should be webhookDeliveries');
  });
});

describe('index definitions', () => {
  it('names every index explicitly, so re-running setup is idempotent', () => {
    for (const { collection, index } of allIndexes()) {
      assert.ok(index.name.length > 0, `unnamed index on ${collection}`);
    }
  });

  it('keeps index names unique within a collection', () => {
    for (const name of COLLECTION_NAMES) {
      const names = INDEXES[name].map((index) => index.name);
      assert.equal(new Set(names).size, names.length, `duplicate index name in ${name}`);
    }
  });

  it('uses only 1 or -1 for key directions', () => {
    for (const { collection, index } of allIndexes()) {
      for (const [field, direction] of Object.entries(index.key as Record<string, unknown>)) {
        assert.ok(
          direction === 1 || direction === -1,
          `${collection}.${index.name}: ${field} has direction ${String(direction)}`,
        );
      }
    }
  });

  it('enforces every uniqueness constraint the design depends on', () => {
    const unique = allIndexes()
      .filter((entry) => entry.index.options?.unique === true)
      .map((entry) => `${entry.collection}.${entry.index.name}`)
      .sort();

    assert.deepEqual(unique, [
      // A retry must not create a second comment in Neutara.
      'outboundWrites.idempotencyKey_unique',
      // One checkpoint per step; retries update it in place (D2).
      'checkpoints.runId_step_unique',
      // A redelivered webhook must not create a second intake item.
      'intakeItems.issueKey_unique',
      // One requirements analysis per intake item; a retry updates it in place.
      'requirementsAnalyses.intakeItemId_unique',
      // The orchestrator's idempotency guard: at most one queued run per
      // approved intake item, for this phase (see the index comment).
      'runs.intakeItemId_unique',
      // A given repository must not be registered active twice for the
      // same project (partial: only among active documents).
      'repositoryRegistry.projectIdentifier_repositoryId_active_unique',
      // Each run selects at most one repository, ever.
      'repositorySelections.runId_unique',
      'webhookDeliveries.deliveryId_unique',
    ].sort());
  });

  it('expires raw webhook payloads after 90 days', () => {
    const ttl = INDEXES[COLLECTIONS.webhookDeliveries].find((i) => i.name === 'receivedAt_ttl');
    assert.ok(ttl, 'webhookDeliveries has no TTL index');
    assert.equal(ttl.options?.expireAfterSeconds, WEBHOOK_DELIVERY_RETENTION_SECONDS);
    assert.equal(WEBHOOK_DELIVERY_RETENTION_SECONDS, 7_776_000);
  });

  it('applies a TTL to webhookDeliveries and nothing else', () => {
    const ttlCollections = allIndexes()
      .filter((entry) => entry.index.options?.expireAfterSeconds !== undefined)
      .map((entry) => entry.collection);
    // outboundWrites records external side effects and must never expire.
    assert.deepEqual(ttlCollections, ['webhookDeliveries']);
  });

  it('indexes the outbound drain and lease-reclaim queries', () => {
    const names = INDEXES[COLLECTIONS.outboundWrites].map((i) => i.name);
    assert.ok(names.includes('status_nextAttemptAt'), 'drain query is unindexed');
    assert.ok(names.includes('status_leaseExpiresAt'), 'lease reclaim is unindexed');
  });

  it('indexes checkpoint resume by both step and ordinal', () => {
    const names = INDEXES[COLLECTIONS.checkpoints].map((i) => i.name);
    assert.ok(names.includes('runId_step_unique'));
    assert.ok(names.includes('runId_sequence'));
  });
});

describe('status vocabularies', () => {
  it('defines the approved checkpoint statuses', () => {
    assert.deepEqual([...CHECKPOINT_STATUSES], [
      'running',
      'completed',
      'failed',
      'skipped',
      'awaiting_approval',
    ]);
  });

  it('defines the approved outbound write statuses', () => {
    assert.deepEqual([...OUTBOUND_WRITE_STATUSES], [
      'pending',
      'in_flight',
      'succeeded',
      'failed',
      'abandoned',
      'cancelled',
    ]);
  });

  it('sets the inline checkpoint output ceiling to 16 KB', () => {
    assert.equal(CHECKPOINT_INLINE_OUTPUT_MAX_BYTES, 16_384);
  });

  it('defines the approved requirements-analysis statuses', () => {
    assert.deepEqual([...REQUIREMENTS_ANALYSIS_STATUSES], ['pending', 'completed', 'failed']);
  });
});

describe('auditLog validator', () => {
  it('is attached with strict enforcement', () => {
    const options = COLLECTION_OPTIONS[COLLECTIONS.auditLog];
    assert.ok(options);
    assert.equal(options['validationLevel'], 'strict');
    assert.equal(options['validationAction'], 'error');
  });

  it('requires the fields that make an entry accountable', () => {
    assert.deepEqual([...schemaOf(AUDIT_LOG_VALIDATOR).required].sort(), [
      'action',
      'actor',
      'occurredAt',
      'subjectId',
      'subjectType',
    ]);
  });

  it('accepts every subject type, including the collections added post-review', () => {
    // A missing entry here means strict validation rejects legitimate audit
    // writes at runtime, which is how this was caught in review.
    const allowed = schemaOf(AUDIT_LOG_VALIDATOR).properties['subjectType']!['enum'];
    assert.deepEqual(allowed, [...AUDIT_SUBJECT_TYPES]);
    for (const subject of ['checkpoint', 'outboundWrite', 'runArtifact', 'webhookDelivery']) {
      assert.ok((allowed as string[]).includes(subject), `${subject} missing from subjectType`);
    }
  });

  it('types subjectId as ObjectId (decision D1)', () => {
    assert.equal(schemaOf(AUDIT_LOG_VALIDATOR).properties['subjectId']!['bsonType'], 'objectId');
  });
});

describe('checkpoints validator', () => {
  it('is attached with strict enforcement', () => {
    const options = COLLECTION_OPTIONS[COLLECTIONS.checkpoints];
    assert.ok(options);
    assert.equal(options['validationAction'], 'error');
  });

  it('requires the fields resume depends on', () => {
    const { required } = schemaOf(CHECKPOINT_VALIDATOR);
    for (const field of ['runId', 'step', 'sequence', 'status', 'attempt', 'inputHash']) {
      assert.ok(required.includes(field), `${field} is not required`);
    }
  });

  it('constrains status to the approved vocabulary', () => {
    assert.deepEqual(schemaOf(CHECKPOINT_VALIDATOR).properties['status']!['enum'], [
      ...CHECKPOINT_STATUSES,
    ]);
  });

  it('uses ObjectId for run and artifact references', () => {
    const props = schemaOf(CHECKPOINT_VALIDATOR).properties;
    assert.equal(props['runId']!['bsonType'], 'objectId');
    assert.deepEqual(props['outputArtifactId']!['bsonType'], ['objectId', 'null']);
  });
});

describe('outboundWrites validator', () => {
  it('is attached with strict enforcement', () => {
    const options = COLLECTION_OPTIONS[COLLECTIONS.outboundWrites];
    assert.ok(options);
    assert.equal(options['validationAction'], 'error');
  });

  it('constrains status and operation to the approved vocabularies', () => {
    const props = schemaOf(OUTBOUND_WRITE_VALIDATOR).properties;
    assert.deepEqual(props['status']!['enum'], [...OUTBOUND_WRITE_STATUSES]);
    assert.deepEqual(props['operation']!['enum'], [...OUTBOUND_WRITE_OPERATIONS]);
  });

  it('requires the retry bookkeeping the drain worker relies on', () => {
    const { required } = schemaOf(OUTBOUND_WRITE_VALIDATOR);
    for (const field of ['idempotencyKey', 'attempts', 'maxAttempts', 'nextAttemptAt', 'status']) {
      assert.ok(required.includes(field), `${field} is not required`);
    }
  });

  it('permits a null approvedBy so a row can be enqueued before approval', () => {
    // Decision D5 is enforced by the drain worker, not the schema: the row
    // must be storable unapproved, and unsendable until approved.
    const props = schemaOf(OUTBOUND_WRITE_VALIDATOR).properties;
    assert.deepEqual(props['approvedBy']!['bsonType'], ['string', 'null']);
    assert.ok(!schemaOf(OUTBOUND_WRITE_VALIDATOR).required.includes('approvedBy'));
  });
});

describe('intakeItems validator', () => {
  it('is attached with strict enforcement', () => {
    const options = COLLECTION_OPTIONS[COLLECTIONS.intakeItems];
    assert.ok(options);
    assert.equal(options['validationAction'], 'error');
  });

  it('constrains status and source to the approved vocabularies', () => {
    const props = schemaOf(INTAKE_ITEM_SCHEMA).properties;
    assert.deepEqual(props['status']!['enum'], [...INTAKE_STATUSES]);
    assert.deepEqual(props['source']!['enum'], [...INTAKE_SOURCES]);
  });

  it('requires sourceHash, which checkpoint resume depends on', () => {
    // Without it, checkpoints.inputHash cannot detect that the intake
    // content changed, and resume would reuse work derived from stale input.
    assert.ok(schemaOf(INTAKE_ITEM_SCHEMA).required.includes('sourceHash'));
  });

  it('requires the fields an intake item cannot exist without', () => {
    const { required } = schemaOf(INTAKE_ITEM_SCHEMA);
    for (const field of ['issueKey', 'source', 'snapshot', 'status', 'receivedAt']) {
      assert.ok(required.includes(field), `${field} is not required`);
    }
  });

  it('keeps issueKey a string, since its format belongs to Neutara', () => {
    assert.equal(schemaOf(INTAKE_ITEM_SCHEMA).properties['issueKey']!['bsonType'], 'string');
  });

  it('accepts the Phase 4 hashed fields', () => {
    const snapshot = schemaOf(INTAKE_ITEM_SCHEMA).properties['snapshot'] as {
      properties: Record<string, Record<string, unknown>>;
    };
    assert.deepEqual(snapshot.properties['labels']!['bsonType'], ['array', 'null']);
    assert.deepEqual(snapshot.properties['parentKey']!['bsonType'], ['string', 'null']);
  });

  it('keeps unhashed context out of the snapshot, in snapshotMeta', () => {
    // status and assignee change constantly; hashing them would invalidate
    // every checkpoint for an issue on each reassignment.
    const props = schemaOf(INTAKE_ITEM_SCHEMA).properties;
    const snapshot = props['snapshot'] as { properties: Record<string, unknown> };
    for (const field of ['status', 'assignee', 'cfKey', 'createdAt']) {
      assert.ok(!(field in snapshot.properties), `${field} is inside the hashed snapshot`);
    }
    assert.deepEqual(props['snapshotMeta']!['bsonType'], ['object', 'null']);
  });

  it('allows approval fields to be absent until an item is approved', () => {
    const { required, properties } = schemaOf(INTAKE_ITEM_SCHEMA);
    assert.ok(!required.includes('approvedBy'));
    assert.deepEqual(properties['approvedBy']!['bsonType'], ['string', 'null']);
  });
});

describe('approval requires an operator, enforced by the database', () => {
  it('combines the shape schema with the approval rule', () => {
    assert.deepEqual(INTAKE_ITEM_VALIDATOR, {
      $and: [INTAKE_ITEM_SCHEMA, APPROVAL_REQUIRES_OPERATOR_CLAUSE],
    });
  });

  it('permits any approvedBy while the item is not approved', () => {
    // An item can sit in pending_approval with no approver, which is the
    // normal state between intake and the human gate.
    const [notApproved] = APPROVAL_REQUIRES_OPERATOR_CLAUSE['$or'] as Record<string, unknown>[];
    assert.deepEqual(notApproved, { status: { $ne: 'approved' } });
  });

  it('requires the operator prefix once approved', () => {
    const [, operator] = APPROVAL_REQUIRES_OPERATOR_CLAUSE['$or'] as Record<string, unknown>[];
    assert.deepEqual(operator, { approvedBy: { $regex: `^${OPERATOR_PRINCIPAL_PREFIX}` } });
  });

  it('anchors the prefix so a service name cannot embed it', () => {
    // Unanchored, 'svc:worker-operator:x' would match.
    const clauses = APPROVAL_REQUIRES_OPERATOR_CLAUSE['$or'] as Record<
      string,
      { $regex: string }
    >[];
    const pattern = clauses[1]!['approvedBy']!.$regex;
    assert.ok(pattern.startsWith('^'), 'the operator prefix regex is not anchored');
    assert.ok(new RegExp(pattern).test('operator:anush'));
    assert.ok(!new RegExp(pattern).test('svc:worker'));
    assert.ok(!new RegExp(pattern).test('svc:worker-operator:x'));
  });

  it('uses the same prefix constant the repository enforces', () => {
    // Two enforcement points, one definition: they cannot drift.
    assert.equal(OPERATOR_PRINCIPAL_PREFIX, 'operator:');
  });
});

describe('webhookDeliveries validator', () => {
  it('is attached with strict enforcement', () => {
    const options = COLLECTION_OPTIONS[COLLECTIONS.webhookDeliveries];
    assert.ok(options);
    assert.equal(options['validationAction'], 'error');
  });

  it('constrains status and event to the approved vocabularies', () => {
    const props = schemaOf(WEBHOOK_DELIVERY_VALIDATOR).properties;
    assert.deepEqual(props['status']!['enum'], [...WEBHOOK_DELIVERY_STATUSES]);
    // null is permitted because an unparseable delivery is still recorded.
    assert.deepEqual(props['event']!['enum'], [...WEBHOOK_EVENTS, null]);
  });

  it('requires only what every delivery has, however malformed', () => {
    // An authenticated but unparseable body has no event, issueKey or
    // payload; it still has a body hash, a status and a timestamp.
    assert.deepEqual([...schemaOf(WEBHOOK_DELIVERY_VALIDATOR).required].sort(), [
      'attempts',
      'deliveryId',
      'maxAttempts',
      'nextAttemptAt',
      'receivedAt',
      'status',
    ]);
  });

  it('pins deliveryId to a sha256 hex digest', () => {
    const pattern = schemaOf(WEBHOOK_DELIVERY_VALIDATOR).properties['deliveryId']!['pattern'];
    assert.equal(pattern, '^[0-9a-f]{64}$');
    assert.ok(new RegExp(String(pattern)).test('a'.repeat(64)));
    assert.ok(!new RegExp(String(pattern)).test('A'.repeat(64)));
    assert.ok(!new RegExp(String(pattern)).test('a'.repeat(63)));
  });

  it('allows the fields an unparseable delivery cannot supply to be null', () => {
    const props = schemaOf(WEBHOOK_DELIVERY_VALIDATOR).properties;
    for (const field of ['issueKey', 'eventTimestamp', 'payload', 'invalidReason', 'intakeItemId']) {
      assert.ok(
        (props[field]!['bsonType'] as string[]).includes('null'),
        `${field} is not nullable`,
      );
    }
  });
});

describe('webhook vocabularies', () => {
  it('mirrors every event Neutara can send', () => {
    // Taken from ConnectorEvent in Neutara's connector-service; this list is
    // not ours to choose.
    assert.deepEqual([...WEBHOOK_EVENTS], [
      'issue.created',
      'issue.updated',
      'issue.deleted',
      'issue.status_changed',
      'issue.assigned',
      'issue.commented',
      'issue.department_changed',
    ]);
  });

  it('accepts only issue.created for now', () => {
    assert.deepEqual([...ACCEPTED_WEBHOOK_EVENTS], ['issue.created']);
  });

  it('only accepts events Neutara actually sends', () => {
    for (const event of ACCEPTED_WEBHOOK_EVENTS) {
      assert.ok((WEBHOOK_EVENTS as readonly string[]).includes(event));
    }
  });

  it('defines the delivery lifecycle, including the Phase 4 states', () => {
    assert.deepEqual([...WEBHOOK_DELIVERY_STATUSES], [
      'pending',
      'ignored',
      'invalid',
      'enriched',
      'failed',
    ]);
  });

  it('indexes the enrichment drain and the per-issue lookup', () => {
    const names = INDEXES[COLLECTIONS.webhookDeliveries].map((i) => i.name);
    assert.ok(names.includes('status_nextAttemptAt'), 'the Phase 4 drain is unindexed');
    assert.ok(names.includes('issueKey_receivedAt'));
    assert.ok(names.includes('deliveryId_unique'));
  });
});

describe('requirementsAnalyses validator', () => {
  it('is attached with strict enforcement', () => {
    const options = COLLECTION_OPTIONS[COLLECTIONS.requirementsAnalyses];
    assert.ok(options);
    assert.equal(options['validationLevel'], 'strict');
    assert.equal(options['validationAction'], 'error');
  });

  it('constrains status to the approved vocabulary', () => {
    assert.deepEqual(schemaOf(REQUIREMENTS_ANALYSIS_VALIDATOR).properties['status']!['enum'], [
      ...REQUIREMENTS_ANALYSIS_STATUSES,
    ]);
  });

  it('requires the fields the retry/duplicate guard depends on', () => {
    const { required } = schemaOf(REQUIREMENTS_ANALYSIS_VALIDATOR);
    for (const field of ['intakeItemId', 'issueKey', 'status', 'inputHash', 'attempts', 'agentVersion']) {
      assert.ok(required.includes(field), `${field} is not required`);
    }
  });

  it('uses ObjectId for the intake item reference', () => {
    assert.equal(
      schemaOf(REQUIREMENTS_ANALYSIS_VALIDATOR).properties['intakeItemId']!['bsonType'],
      'objectId',
    );
  });

  it('allows result and error to be null, and neither is required', () => {
    const { required, properties } = schemaOf(REQUIREMENTS_ANALYSIS_VALIDATOR);
    assert.deepEqual(properties['result']!['bsonType'], ['object', 'null']);
    assert.deepEqual(properties['error']!['bsonType'], ['object', 'null']);
    assert.ok(!required.includes('result'));
    assert.ok(!required.includes('error'));
  });

  it('allows usage to be null and does not require it, set only for an LLM-backed run', () => {
    const { required, properties } = schemaOf(REQUIREMENTS_ANALYSIS_VALIDATOR);
    assert.deepEqual(properties['usage']!['bsonType'], ['object', 'null']);
    assert.ok(!required.includes('usage'));
  });
});

describe('runs vocabularies', () => {
  it('defines the approved run statuses', () => {
    assert.deepEqual([...RUN_STATUSES], ['queued', 'running', 'succeeded', 'failed', 'cancelled']);
  });

  it('defines only approval as a trigger for this phase', () => {
    assert.deepEqual([...RUN_TRIGGERS], ['approval']);
  });
});

describe('runs validator', () => {
  it('is attached with strict enforcement', () => {
    const options = COLLECTION_OPTIONS[COLLECTIONS.runs];
    assert.ok(options);
    assert.equal(options['validationLevel'], 'strict');
    assert.equal(options['validationAction'], 'error');
  });

  it('constrains status and trigger to the approved vocabularies', () => {
    const props = schemaOf(RUN_VALIDATOR).properties;
    assert.deepEqual(props['status']!['enum'], [...RUN_STATUSES]);
    assert.deepEqual(props['trigger']!['enum'], [...RUN_TRIGGERS]);
  });

  it('requires the fields a run cannot exist without', () => {
    const { required } = schemaOf(RUN_VALIDATOR);
    for (const field of ['intakeItemId', 'issueKey', 'status', 'trigger', 'createdAt']) {
      assert.ok(required.includes(field), `${field} is not required`);
    }
  });

  it('uses ObjectId for the intake item reference', () => {
    assert.equal(schemaOf(RUN_VALIDATOR).properties['intakeItemId']!['bsonType'], 'objectId');
  });

  it('allows startedAt and completedAt to be absent until a future Coding Agent fills them in', () => {
    const { required, properties } = schemaOf(RUN_VALIDATOR);
    assert.deepEqual(properties['startedAt']!['bsonType'], ['date', 'null']);
    assert.deepEqual(properties['completedAt']!['bsonType'], ['date', 'null']);
    assert.ok(!required.includes('startedAt'));
    assert.ok(!required.includes('completedAt'));
  });
});

describe('repositoryRegistry vocabularies', () => {
  it('defines active/inactive and nothing else', () => {
    assert.deepEqual([...REPOSITORY_REGISTRY_STATUSES], ['active', 'inactive']);
  });
});

describe('repositoryRegistry validator', () => {
  it('is attached with strict enforcement', () => {
    const options = COLLECTION_OPTIONS[COLLECTIONS.repositoryRegistry];
    assert.ok(options);
    assert.equal(options['validationLevel'], 'strict');
    assert.equal(options['validationAction'], 'error');
  });

  it('constrains status to the approved vocabulary', () => {
    assert.deepEqual(schemaOf(REPOSITORY_REGISTRY_VALIDATOR).properties['status']!['enum'], [
      ...REPOSITORY_REGISTRY_STATUSES,
    ]);
  });

  it('requires the fields an entry cannot exist without, including actor and timestamp fields', () => {
    const { required } = schemaOf(REPOSITORY_REGISTRY_VALIDATOR);
    for (const field of [
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
    ]) {
      assert.ok(required.includes(field), `${field} is not required`);
    }
  });

  it('requires allowedBranches to be a non-empty array of strings', () => {
    const allowedBranches = schemaOf(REPOSITORY_REGISTRY_VALIDATOR).properties['allowedBranches']!;
    assert.equal(allowedBranches['bsonType'], 'array');
    assert.equal(allowedBranches['minItems'], 1);
  });

  it('allows accessPolicy to be null and does not require it, pending GitHub App design', () => {
    const { required, properties } = schemaOf(REPOSITORY_REGISTRY_VALIDATOR);
    assert.deepEqual(properties['accessPolicy']!['bsonType'], ['object', 'null']);
    assert.ok(!required.includes('accessPolicy'));
  });
});

describe('repositorySelections vocabularies', () => {
  it('defines pending/selected/failed/ambiguous and nothing else', () => {
    assert.deepEqual([...REPOSITORY_SELECTION_STATUSES], ['pending', 'selected', 'failed', 'ambiguous']);
  });
});

describe('repositorySelections validator', () => {
  it('is attached with strict enforcement', () => {
    const options = COLLECTION_OPTIONS[COLLECTIONS.repositorySelections];
    assert.ok(options);
    assert.equal(options['validationLevel'], 'strict');
    assert.equal(options['validationAction'], 'error');
  });

  it('constrains status to the approved vocabulary', () => {
    assert.deepEqual(schemaOf(REPOSITORY_SELECTION_VALIDATOR).properties['status']!['enum'], [
      ...REPOSITORY_SELECTION_STATUSES,
    ]);
  });

  it('requires the retry bookkeeping fields', () => {
    const { required } = schemaOf(REPOSITORY_SELECTION_VALIDATOR);
    for (const field of ['runId', 'intakeItemId', 'issueKey', 'projectIdentifier', 'attempts', 'nextAttemptAt']) {
      assert.ok(required.includes(field), `${field} is not required`);
    }
  });

  it('uses ObjectId for run and intake item references', () => {
    const props = schemaOf(REPOSITORY_SELECTION_VALIDATOR).properties;
    assert.equal(props['runId']!['bsonType'], 'objectId');
    assert.equal(props['intakeItemId']!['bsonType'], 'objectId');
  });

  it('allows every selected* snapshot field and confirmation field to be null and unrequired before confirmation', () => {
    const { required, properties } = schemaOf(REPOSITORY_SELECTION_VALIDATOR);
    for (const field of [
      'selectedRepositoryId',
      'selectedRepositoryUrl',
      'selectedDefaultBranch',
      'confirmedBy',
      'confirmedAt',
    ]) {
      assert.ok(!required.includes(field), `${field} should not be required`);
      assert.ok(
        (properties[field]!['bsonType'] as string[]).includes('null'),
        `${field} is not nullable`,
      );
    }
  });
});

describe('collection options coverage', () => {
  it('validates exactly the nine collections with enforced vocabularies', () => {
    assert.deepEqual(Object.keys(COLLECTION_OPTIONS).sort(), [
      'auditLog',
      'checkpoints',
      'intakeItems',
      'outboundWrites',
      'repositoryRegistry',
      'repositorySelections',
      'requirementsAnalyses',
      'runs',
      'webhookDeliveries',
    ]);
  });
});

describe('Phase 1 invariants are untouched by Phase 3', () => {
  it('leaves the intake status vocabulary unchanged', () => {
    assert.deepEqual([...INTAKE_STATUSES], [
      'received',
      'pending_approval',
      'approved',
      'rejected',
      'failed',
    ]);
  });

  it('leaves the intake sources unchanged', () => {
    assert.deepEqual([...INTAKE_SOURCES], ['webhook', 'manual', 'backfill']);
  });
});
