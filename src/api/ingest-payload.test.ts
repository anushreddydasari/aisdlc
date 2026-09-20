import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { WEBHOOK_EVENTS } from '../db/collections.ts';
import { validateIssueEvent } from './ingest-payload.ts';

/** A minimal payload matching Neutara's IssueEventPayload. */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: 'issue.created',
    timestamp: '2026-09-20T12:00:00.000Z',
    issue: {
      key: 'AIS-1',
      summary: 'Login fails for SSO users',
      type: 'bug',
      priority: 'high',
      spaceKey: 'AIS',
      url: 'https://neutara.example.com/browse/AIS-1',
    },
    ...overrides,
  };
}

function issue(overrides: Record<string, unknown>): Record<string, unknown> {
  return payload({ issue: { ...(payload()['issue'] as object), ...overrides } });
}

describe('accepting a well-formed payload', () => {
  it('accepts the minimal required shape', () => {
    const result = validateIssueEvent(payload());
    assert.ok(result.ok);
    assert.equal(result.event.event, 'issue.created');
    assert.equal(result.event.issue.key, 'AIS-1');
    assert.deepEqual(result.unknownFields, []);
  });

  it('parses the timestamp from the body', () => {
    const result = validateIssueEvent(payload());
    assert.ok(result.ok);
    assert.equal(result.eventTimestamp.toISOString(), '2026-09-20T12:00:00.000Z');
  });

  it('accepts every event Neutara can send', () => {
    for (const event of WEBHOOK_EVENTS) {
      const result = validateIssueEvent(payload({ event }));
      assert.ok(result.ok, `rejected ${event}`);
    }
  });

  it('accepts the optional issue fields', () => {
    const result = validateIssueEvent(
      issue({
        cf_key: 'CF-9',
        status: 'open',
        assignee: 'someone',
        reporter: 'reporter',
        department: 'support',
        spaceName: 'AISDLC',
      }),
    );
    assert.ok(result.ok);
    assert.equal(result.event.issue.cf_key, 'CF-9');
    assert.equal(result.event.issue.department, 'support');
  });

  it('accepts a change block and an actor', () => {
    const result = validateIssueEvent(
      payload({ change: { field: 'status', from: 'open', to: 'closed' }, actor: 'someone' }),
    );
    assert.ok(result.ok);
    assert.equal(result.event.change?.field, 'status');
    assert.equal(result.event.actor, 'someone');
  });

  it('accepts a change block with only a field', () => {
    const result = validateIssueEvent(payload({ change: { field: 'priority' } }));
    assert.ok(result.ok);
    assert.equal(result.event.change?.from, undefined);
  });

  it('accepts a blank summary, priority and url', () => {
    // A sparse ticket is not a malformed one; the length cap still applies.
    const result = validateIssueEvent(issue({ summary: '', priority: '', url: '' }));
    assert.ok(result.ok);
  });
});

describe('unknown fields are tolerated, not fatal', () => {
  it('accepts a payload carrying an unrecognised top-level field', () => {
    // Neutara does not retry. Rejecting an added field would silently
    // destroy events the moment upstream ships one.
    const result = validateIssueEvent(payload({ labels: ['a', 'b'], severity: 3 }));
    assert.ok(result.ok);
  });

  it('reports unknown fields so drift is visible', () => {
    const result = validateIssueEvent(payload({ labels: [], severity: 3 }));
    assert.ok(result.ok);
    assert.deepEqual([...result.unknownFields].sort(), ['labels', 'severity']);
  });
});

describe('rejecting a malformed payload', () => {
  for (const body of [null, undefined, 'string', 42, true, [], [payload()]]) {
    it(`rejects a non-object body: ${JSON.stringify(body) ?? 'undefined'}`, () => {
      const result = validateIssueEvent(body);
      assert.ok(!result.ok);
      assert.equal(result.reason, 'not_an_object');
    });
  }

  it('distinguishes an unknown event from a malformed one', () => {
    // 'unknown_event' becomes `ignored`, not `invalid`.
    const result = validateIssueEvent(payload({ event: 'issue.exploded' }));
    assert.ok(!result.ok);
    assert.equal(result.reason, 'unknown_event');
  });

  it('rejects a missing or non-string event', () => {
    for (const event of [undefined, null, 42, {}]) {
      const result = validateIssueEvent(payload({ event }));
      assert.ok(!result.ok);
      assert.equal(result.reason, 'missing_field:event');
    }
  });

  it('rejects a missing timestamp', () => {
    const result = validateIssueEvent(payload({ timestamp: undefined }));
    assert.ok(!result.ok);
    assert.equal(result.reason, 'missing_field:timestamp');
  });

  it('rejects an unparseable timestamp', () => {
    const result = validateIssueEvent(payload({ timestamp: 'not-a-date' }));
    assert.ok(!result.ok);
    assert.equal(result.reason, 'invalid_timestamp');
  });

  it('rejects a missing issue object', () => {
    for (const value of [undefined, null, 'x', []]) {
      const result = validateIssueEvent(payload({ issue: value }));
      assert.ok(!result.ok);
      assert.equal(result.reason, 'missing_field:issue');
    }
  });

  for (const field of ['key', 'type', 'spaceKey']) {
    it(`rejects a missing issue.${field}`, () => {
      const result = validateIssueEvent(issue({ [field]: undefined }));
      assert.ok(!result.ok);
      assert.equal(result.reason, `missing_field:issue.${field}`);
    });

    it(`rejects a blank issue.${field}`, () => {
      const result = validateIssueEvent(issue({ [field]: '   ' }));
      assert.ok(!result.ok);
      assert.equal(result.reason, `missing_field:issue.${field}`);
    });
  }

  for (const field of ['key', 'summary', 'type', 'priority', 'spaceKey', 'url']) {
    it(`rejects a non-string issue.${field}`, () => {
      const result = validateIssueEvent(issue({ [field]: 42 }));
      assert.ok(!result.ok);
      assert.equal(result.reason, `invalid_type:issue.${field}`);
    });
  }

  it('rejects an over-long summary', () => {
    const result = validateIssueEvent(issue({ summary: 'x'.repeat(513) }));
    assert.ok(!result.ok);
    assert.equal(result.reason, 'too_long:issue.summary');
  });

  it('rejects an over-long url', () => {
    const result = validateIssueEvent(issue({ url: `https://x/${'y'.repeat(2048)}` }));
    assert.ok(!result.ok);
    assert.equal(result.reason, 'too_long:issue.url');
  });

  it('rejects an over-long optional field', () => {
    const result = validateIssueEvent(issue({ assignee: 'x'.repeat(257) }));
    assert.ok(!result.ok);
    assert.equal(result.reason, 'too_long:issue.assignee');
  });

  it('rejects a non-string optional field', () => {
    const result = validateIssueEvent(issue({ reporter: { name: 'x' } }));
    assert.ok(!result.ok);
    assert.equal(result.reason, 'invalid_type:issue.reporter');
  });

  it('rejects a change block without a field', () => {
    const result = validateIssueEvent(payload({ change: { from: 'a', to: 'b' } }));
    assert.ok(!result.ok);
    assert.equal(result.reason, 'missing_field:change.field');
  });

  it('rejects a non-object change block', () => {
    const result = validateIssueEvent(payload({ change: 'status' }));
    assert.ok(!result.ok);
    assert.equal(result.reason, 'invalid_type:change');
  });

  it('rejects a non-string actor', () => {
    const result = validateIssueEvent(payload({ actor: 7 }));
    assert.ok(!result.ok);
    assert.equal(result.reason, 'invalid_type:actor');
  });

  it('never includes payload content in the reason', () => {
    // Reasons are stored and logged; they must carry no ticket text.
    const secret = 'CONFIDENTIAL-CUSTOMER-DETAIL';
    const result = validateIssueEvent(issue({ summary: secret, key: undefined }));
    assert.ok(!result.ok);
    assert.ok(!result.reason.includes(secret));
  });
});
