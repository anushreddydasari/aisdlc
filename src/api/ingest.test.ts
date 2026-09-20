import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { ObjectId } from 'mongodb';
import type { IncomingMessage } from 'node:http';

import type { AuditEntryInput, AuditLog } from '../db/audit-log.ts';
import type {
  RecordDeliveryInput,
  RecordDeliveryResult,
  WebhookDeliveryRepository,
} from '../db/webhook-deliveries.ts';
import { createLogger } from '../logging/logger.ts';
import { buildSignatureHeader } from './signature.ts';
import { computeDeliveryId, handleIngest, type IngestDeps } from './ingest.ts';

const SECRET = 'whsec_test_value_not_real'; // pragma: fixture

function eventBody(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      event: 'issue.created',
      timestamp: '2026-09-20T12:00:00.000Z',
      issue: {
        key: 'AIS-1',
        summary: 'Login fails',
        type: 'bug',
        priority: 'high',
        spaceKey: 'AIS',
        url: 'https://neutara.example.com/browse/AIS-1',
      },
      ...overrides,
    }),
  );
}

function request(body: Buffer, headers: Record<string, string | undefined> = {}): IncomingMessage {
  const stream = Readable.from([body]) as unknown as IncomingMessage;
  stream.headers = {
    'content-type': 'application/json',
    'x-neutara-signature': buildSignatureHeader(SECRET, body),
    ...headers,
  } as IncomingMessage['headers'];
  return stream;
}

interface Harness {
  readonly deps: IngestDeps;
  readonly recorded: RecordDeliveryInput[];
  readonly audits: AuditEntryInput[];
  readonly logs: string[];
}

function harness(
  options: {
    secret?: string | undefined;
    noDatabase?: boolean;
    duplicate?: boolean;
    recordThrows?: boolean;
    auditThrows?: boolean;
  } = {},
): Harness {
  const recorded: RecordDeliveryInput[] = [];
  const audits: AuditEntryInput[] = [];
  const logs: string[] = [];

  const deliveries: WebhookDeliveryRepository = {
    async record(input): Promise<RecordDeliveryResult> {
      if (options.recordThrows) throw new Error('mongo exploded');
      recorded.push(input);
      return options.duplicate
        ? { recorded: false, id: new ObjectId(), duplicate: true }
        : { recorded: true, id: new ObjectId() };
    },
    async findByDeliveryId() {
      return null;
    },
    // Phase 4 surface; unused by the ingest handler, which only records.
    async findPending() {
      return [];
    },
    async markEnriched() {},
    async scheduleRetry() {},
    async markFailed() {},
  };

  const audit: AuditLog = {
    async append(entry) {
      if (options.auditThrows) throw new Error('audit unavailable');
      audits.push(entry);
      return new ObjectId();
    },
    async query() {
      return [];
    },
  };

  return {
    deps: {
      logger: createLogger({ level: 'debug', write: (line) => logs.push(line) }),
      webhookSecret: 'secret' in options ? options.secret : SECRET,
      deliveries: options.noDatabase ? undefined : deliveries,
      audit: options.noDatabase ? undefined : audit,
    },
    recorded,
    audits,
    logs,
  };
}

describe('accepted deliveries', () => {
  it('records issue.created as pending and answers 202', async () => {
    const h = harness();
    const body = eventBody();
    const result = await handleIngest(request(body), h.deps);

    assert.equal(result.statusCode, 202);
    assert.equal(result.body['status'], 'accepted');
    assert.equal(result.body['issueKey'], 'AIS-1');
    assert.equal(result.body['deliveryId'], computeDeliveryId(body));

    assert.equal(h.recorded.length, 1);
    assert.equal(h.recorded[0]!.status, 'pending');
    assert.equal(h.recorded[0]!.event, 'issue.created');
  });

  it('derives the delivery id from the raw body', async () => {
    const body = eventBody();
    const h = harness();
    await handleIngest(request(body), h.deps);
    assert.equal(h.recorded[0]!.deliveryId, computeDeliveryId(body));
    assert.match(h.recorded[0]!.deliveryId, /^[0-9a-f]{64}$/);
  });

  it('stores the whole payload, including fields we do not model', async () => {
    const h = harness();
    await handleIngest(request(eventBody({ labels: ['x'] })), h.deps);
    assert.deepEqual((h.recorded[0]!.payload as Record<string, unknown>)['labels'], ['x']);
  });

  it('audits with the webhookDelivery subject and no ticket text', async () => {
    const h = harness();
    await handleIngest(request(eventBody({ issue: { key: 'AIS-1', summary: 'SENSITIVE TEXT', type: 'bug', priority: 'p', spaceKey: 'AIS', url: 'u' } })), h.deps);

    assert.equal(h.audits.length, 1);
    const entry = h.audits[0]!;
    assert.equal(entry.action, 'webhook.received');
    assert.equal(entry.subjectType, 'webhookDelivery');
    assert.equal(entry.actor, 'source:webhook');
    assert.ok(!JSON.stringify(entry.detail).includes('SENSITIVE TEXT'));
  });

  it('never logs ticket text', async () => {
    const h = harness();
    await handleIngest(request(eventBody({ issue: { key: 'AIS-1', summary: 'SECRET SUMMARY', type: 'bug', priority: 'p', spaceKey: 'AIS', url: 'u' } })), h.deps);
    assert.ok(!h.logs.join('\n').includes('SECRET SUMMARY'));
  });

  it('does not create an intake item', async () => {
    // Phase 3 records deliveries only. The handler has no intake repository
    // at all, so this is structural — asserted to keep it that way.
    const h = harness();
    await handleIngest(request(eventBody()), h.deps);
    assert.ok(!('intakeItemId' in h.recorded[0]!));
  });
});

describe('ignored events', () => {
  for (const event of ['issue.updated', 'issue.deleted', 'issue.assigned', 'issue.commented']) {
    it(`records ${event} as ignored with 202`, async () => {
      // 202, not 4xx: Neutara drops an event permanently on a non-2xx, and
      // an event we chose not to process is not an error.
      const h = harness();
      const result = await handleIngest(request(eventBody({ event })), h.deps);

      assert.equal(result.statusCode, 202);
      assert.equal(result.body['status'], 'ignored');
      assert.equal(h.recorded[0]!.status, 'ignored');
      assert.equal(h.audits[0]!.action, 'webhook.ignored');
    });
  }

  it('records an event Neutara does not define as ignored, not invalid', async () => {
    const h = harness();
    const result = await handleIngest(request(eventBody({ event: 'issue.exploded' })), h.deps);

    assert.equal(result.statusCode, 202);
    assert.equal(h.recorded[0]!.status, 'ignored');
    assert.equal(h.recorded[0]!.issueKey, 'AIS-1');
  });
});

describe('signature failures write nothing', () => {
  const cases: [string, Record<string, string | undefined>, string | undefined][] = [
    ['missing header', { 'x-neutara-signature': undefined }, SECRET],
    ['malformed header', { 'x-neutara-signature': 'garbage' }, SECRET],
    ['wrong signature', { 'x-neutara-signature': `sha256=${'0'.repeat(64)}` }, SECRET],
    ['no secret configured', {}, undefined],
  ];

  for (const [name, headers, secret] of cases) {
    it(`answers 401 for ${name}`, async () => {
      const h = harness({ secret });
      const result = await handleIngest(request(eventBody(), headers), h.deps);

      assert.equal(result.statusCode, 401);
      assert.deepEqual(result.body, { error: 'unauthorized' });
    });

    it(`writes nothing to the database for ${name}`, async () => {
      // An unauthenticated caller must not be able to fill the database.
      const h = harness({ secret });
      await handleIngest(request(eventBody(), headers), h.deps);
      assert.equal(h.recorded.length, 0);
      assert.equal(h.audits.length, 0);
    });
  }

  it('gives an identical response whatever the reason', async () => {
    const bodies = [];
    for (const [, headers, secret] of cases) {
      const h = harness({ secret });
      bodies.push(JSON.stringify(await handleIngest(request(eventBody(), headers), h.deps)));
    }
    assert.equal(new Set(bodies).size, 1, 'responses differ and form an oracle');
  });

  it('rejects a tampered body', async () => {
    const h = harness();
    const signed = eventBody();
    const tampered = eventBody({ actor: 'attacker' });
    const req = Readable.from([tampered]) as unknown as IncomingMessage;
    req.headers = {
      'content-type': 'application/json',
      'x-neutara-signature': buildSignatureHeader(SECRET, signed),
    } as IncomingMessage['headers'];

    assert.equal((await handleIngest(req, h.deps)).statusCode, 401);
    assert.equal(h.recorded.length, 0);
  });
});

describe('invalid payloads', () => {
  it('records malformed JSON and answers 400', async () => {
    const body = Buffer.from('{not json');
    const h = harness();
    const result = await handleIngest(request(body), h.deps);

    assert.equal(result.statusCode, 400);
    assert.deepEqual(result.body, { error: 'invalid_request' });
    assert.equal(h.recorded[0]!.status, 'invalid');
    assert.equal(h.recorded[0]!.invalidReason, 'malformed_json');
    assert.equal(h.recorded[0]!.payload, undefined);
  });

  it('records a schema violation with its reason', async () => {
    const h = harness();
    const result = await handleIngest(request(eventBody({ issue: { summary: 'x' } })), h.deps);

    assert.equal(result.statusCode, 400);
    assert.equal(h.recorded[0]!.status, 'invalid');
    assert.match(String(h.recorded[0]!.invalidReason), /missing_field/);
    assert.equal(h.audits[0]!.action, 'webhook.invalid');
  });

  it('keeps the payload of a parseable but invalid delivery as evidence', async () => {
    const h = harness();
    await handleIngest(request(eventBody({ timestamp: 'nope' })), h.deps);
    assert.ok(h.recorded[0]!.payload);
  });

  it('never returns the reason to the caller', async () => {
    const h = harness();
    const result = await handleIngest(request(eventBody({ timestamp: 'nope' })), h.deps);
    assert.deepEqual(result.body, { error: 'invalid_request' });
  });
});

describe('duplicates', () => {
  it('answers 200 and writes no audit entry', async () => {
    const h = harness({ duplicate: true });
    const result = await handleIngest(request(eventBody()), h.deps);

    assert.equal(result.statusCode, 200);
    assert.equal(result.body['status'], 'duplicate');
    assert.equal(h.audits.length, 0, 'a replay is not a new event');
  });
});

describe('transport and infrastructure failures', () => {
  it('answers 415 for a non-JSON content type', async () => {
    const h = harness();
    const result = await handleIngest(
      request(eventBody(), { 'content-type': 'text/plain' }),
      h.deps,
    );
    assert.equal(result.statusCode, 415);
    assert.equal(h.recorded.length, 0);
  });

  it('accepts a content type carrying a charset', async () => {
    const h = harness();
    const result = await handleIngest(
      request(eventBody(), { 'content-type': 'application/json; charset=utf-8' }),
      h.deps,
    );
    assert.equal(result.statusCode, 202);
  });

  it('answers 413 for an oversized body, before verifying anything', async () => {
    const h = harness();
    const big = Buffer.from(JSON.stringify({ pad: 'x'.repeat(2000) }));
    const result = await handleIngest(request(big), { ...h.deps, maxBodyBytes: 100 });

    assert.equal(result.statusCode, 413);
    assert.equal(h.recorded.length, 0);
  });

  it('answers 503 when the database is unavailable', async () => {
    const h = harness({ noDatabase: true });
    const result = await handleIngest(request(eventBody()), h.deps);
    assert.equal(result.statusCode, 503);
    assert.deepEqual(result.body, { error: 'unavailable' });
  });

  it('checks the signature before the database, so 401 beats 503', async () => {
    const h = harness({ noDatabase: true });
    const result = await handleIngest(
      request(eventBody(), { 'x-neutara-signature': undefined }),
      h.deps,
    );
    assert.equal(result.statusCode, 401);
  });

  it('answers 503 when recording throws', async () => {
    const h = harness({ recordThrows: true });
    const result = await handleIngest(request(eventBody()), h.deps);
    assert.equal(result.statusCode, 503);
  });

  it('still answers 202 when the audit append fails', async () => {
    // The delivery is stored. A 5xx here would make Neutara drop an event we
    // have safely kept, which is worse than a missing audit row.
    const h = harness({ auditThrows: true });
    const result = await handleIngest(request(eventBody()), h.deps);

    assert.equal(result.statusCode, 202);
    assert.ok(h.logs.join('\n').includes('failed to audit'));
  });

  it('never exposes a database detail in a response', async () => {
    const h = harness({ recordThrows: true });
    const result = await handleIngest(request(eventBody()), h.deps);
    assert.ok(!JSON.stringify(result.body).includes('mongo'));
  });
});
