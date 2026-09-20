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
  OUTBOUND_WRITE_OPERATIONS,
  OUTBOUND_WRITE_STATUSES,
  OUTBOUND_WRITE_VALIDATOR,
  WEBHOOK_DELIVERY_RETENTION_SECONDS,
  allIndexes,
} from './collections.ts';

/** The approved design. A rename or omission must fail loudly here. */
const APPROVED_COLLECTIONS = [
  'auditLog',
  'checkpoints',
  'intakeItems',
  'outboundWrites',
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

describe('collection options coverage', () => {
  it('validates exactly the four collections with enforced vocabularies', () => {
    assert.deepEqual(Object.keys(COLLECTION_OPTIONS).sort(), [
      'auditLog',
      'checkpoints',
      'intakeItems',
      'outboundWrites',
    ]);
  });
});
