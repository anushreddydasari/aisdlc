import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import type { IncomingMessage } from 'node:http';

import {
  ApprovalRequiresOperatorError,
  IntakeConflictError,
  IntakeNotFoundError,
  type ApprovalOptions,
  type IntakeItemDocument,
  type IntakeRepository,
  type TransitionArgs,
  type TransitionOptions,
} from '../intake/repository.ts';
import type { IntakeStatus } from '../db/collections.ts';
import { InvalidTransitionError, assertTransition } from '../intake/state.ts';
import { createLogger } from '../logging/logger.ts';
import { BEARER_PREFIX } from './operator-auth.ts';
import { handleApproval, type ApprovalDeps } from './approval.ts';

const TOKEN = 'op_test_token_value_not_real'; // pragma: fixture

function request(
  body: Record<string, unknown> | Buffer | null,
  headers: Record<string, string | undefined> = {},
): IncomingMessage {
  const buf = body === null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const stream = Readable.from([buf]) as unknown as IncomingMessage;
  stream.headers = {
    authorization: `${BEARER_PREFIX}${TOKEN}`,
    ...headers,
  } as IncomingMessage['headers'];
  return stream;
}

function item(overrides: Partial<IntakeItemDocument> = {}): IntakeItemDocument {
  const now = new Date('2026-09-22T00:00:00.000Z');
  return {
    issueKey: 'CF-1',
    source: 'webhook',
    deliveryRef: null,
    snapshot: { title: 't', description: 'd', issueType: 'bug' },
    snapshotMeta: null,
    sourceHash: 'hash',
    status: 'pending_approval',
    statusReason: null,
    approvedBy: null,
    approvedAt: null,
    receivedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

interface Harness {
  readonly deps: ApprovalDeps;
  readonly transitions: { issueKey: string; to: IntakeStatus; options: TransitionOptions | ApprovalOptions }[];
  readonly logs: string[];
}

function harness(
  options: {
    token?: string | undefined;
    noDatabase?: boolean;
    item?: IntakeItemDocument;
    throwOn?: 'not_found' | 'invalid_transition' | 'conflict' | 'operator_missing' | 'unexpected';
  } = {},
): Harness {
  const transitions: Harness['transitions'] = [];
  const logs: string[] = [];
  const stored = options.item ?? item();

  const intake: IntakeRepository = {
    async create() {
      throw new Error('not used by the approval handler');
    },
    async findByIssueKey() {
      return stored;
    },
    async list() {
      return [stored];
    },
    async transition<T extends IntakeStatus>(issueKey: string, to: T, opts: TransitionArgs<T>) {
      transitions.push({ issueKey, to, options: opts });
      if (options.throwOn === 'not_found') throw new IntakeNotFoundError(issueKey);
      if (options.throwOn === 'conflict') throw new IntakeConflictError(issueKey);
      if (options.throwOn === 'operator_missing') {
        throw new ApprovalRequiresOperatorError((opts as ApprovalOptions).approvedBy ?? '');
      }
      if (options.throwOn === 'unexpected') throw new Error('mongo exploded');
      if (options.throwOn === 'invalid_transition') {
        // Exercise the real assertion so the error shape matches production.
        assertTransition(stored.status, to);
      }
      return {
        ...stored,
        status: to,
        approvedBy: 'approvedBy' in opts ? (opts as ApprovalOptions).approvedBy : stored.approvedBy,
        approvedAt: 'approvedBy' in opts ? new Date('2026-09-22T01:00:00.000Z') : stored.approvedAt,
        statusReason: opts.reason ?? null,
      };
    },
  };

  return {
    deps: {
      logger: createLogger({ level: 'debug', write: (line) => logs.push(line) }),
      operatorToken: 'token' in options ? options.token : TOKEN,
      intake: options.noDatabase ? undefined : intake,
    },
    transitions,
    logs,
  };
}

describe('authentication', () => {
  it('refuses a request with no operator token configured', async () => {
    const h = harness({ token: undefined });
    const result = await handleApproval(request({ operator: 'jane' }), h.deps, 'CF-1', 'approve');
    assert.equal(result.statusCode, 401);
    assert.deepEqual(result.body, { error: 'unauthorized' });
    assert.equal(h.transitions.length, 0, 'must not touch the repository before authenticating');
  });

  it('refuses a missing or wrong bearer token', async () => {
    const h = harness();
    for (const headers of [{ authorization: undefined }, { authorization: 'Bearer wrong' }]) {
      const result = await handleApproval(
        request({ operator: 'jane' }, headers),
        h.deps,
        'CF-1',
        'approve',
      );
      assert.equal(result.statusCode, 401);
    }
    assert.equal(h.transitions.length, 0);
  });

  it('never leaks the token in the response', async () => {
    const h = harness({ token: undefined });
    const result = await handleApproval(request({ operator: 'jane' }), h.deps, 'CF-1', 'approve');
    assert.ok(!JSON.stringify(result.body).includes(TOKEN));
  });
});

describe('database availability', () => {
  it('answers 503 when the database is unreachable', async () => {
    const h = harness({ noDatabase: true });
    const result = await handleApproval(request({ operator: 'jane' }), h.deps, 'CF-1', 'approve');
    assert.equal(result.statusCode, 503);
    assert.deepEqual(result.body, { error: 'unavailable' });
  });

  it('checks the database only after authentication succeeds', async () => {
    // Same DB-down harness, but an invalid token must still win with 401.
    const h = harness({ noDatabase: true, token: 'configured-token' });
    const result = await handleApproval(
      request({ operator: 'jane' }, { authorization: 'Bearer wrong' }),
      h.deps,
      'CF-1',
      'approve',
    );
    assert.equal(result.statusCode, 401);
  });
});

describe('request body validation', () => {
  it('rejects a missing operator field', async () => {
    const h = harness();
    const result = await handleApproval(request({}), h.deps, 'CF-1', 'approve');
    assert.equal(result.statusCode, 400);
    assert.equal(h.transitions.length, 0);
  });

  it('rejects an empty operator field', async () => {
    const h = harness();
    const result = await handleApproval(request({ operator: '   ' }), h.deps, 'CF-1', 'approve');
    assert.equal(result.statusCode, 400);
  });

  it('rejects malformed JSON', async () => {
    const h = harness();
    const result = await handleApproval(request(Buffer.from('not json')), h.deps, 'CF-1', 'approve');
    assert.equal(result.statusCode, 400);
  });

  it('rejects a non-string reason', async () => {
    const h = harness();
    const result = await handleApproval(
      request({ operator: 'jane', reason: 42 }),
      h.deps,
      'CF-1',
      'approve',
    );
    assert.equal(result.statusCode, 400);
  });

  it('rejects an empty issueKey', async () => {
    const h = harness();
    const result = await handleApproval(request({ operator: 'jane' }), h.deps, '', 'approve');
    assert.equal(result.statusCode, 400);
  });
});

describe('approval', () => {
  it('names the operator with the required prefix', async () => {
    const h = harness();
    await handleApproval(request({ operator: 'jane' }), h.deps, 'CF-1', 'approve');

    assert.equal(h.transitions.length, 1);
    assert.equal(h.transitions[0]!.to, 'approved');
    const opts = h.transitions[0]!.options as ApprovalOptions;
    assert.equal(opts.actor, 'operator:jane');
    assert.equal(opts.approvedBy, 'operator:jane');
  });

  it('passes the optional reason through', async () => {
    const h = harness();
    await handleApproval(request({ operator: 'jane', reason: 'looks good' }), h.deps, 'CF-1', 'approve');
    assert.equal(h.transitions[0]!.options.reason, 'looks good');
  });

  it('omits reason entirely when not supplied, rather than sending undefined', async () => {
    const h = harness();
    await handleApproval(request({ operator: 'jane' }), h.deps, 'CF-1', 'approve');
    assert.ok(!('reason' in h.transitions[0]!.options));
  });

  it('returns 200 with the updated item on success', async () => {
    const h = harness();
    const result = await handleApproval(request({ operator: 'jane' }), h.deps, 'CF-1', 'approve');
    assert.equal(result.statusCode, 200);
    assert.equal(result.body['status'], 'approved');
    assert.equal(result.body['approvedBy'], 'operator:jane');
    assert.equal(result.body['issueKey'], 'CF-1');
  });

  it('trims whitespace around the operator name', async () => {
    const h = harness();
    await handleApproval(request({ operator: '  jane  ' }), h.deps, 'CF-1', 'approve');
    assert.equal((h.transitions[0]!.options as ApprovalOptions).approvedBy, 'operator:jane');
  });
});

describe('rejection', () => {
  it('does not require approvedBy for a rejection, but still names the operator as actor', async () => {
    const h = harness();
    const result = await handleApproval(
      request({ operator: 'jane', reason: 'not needed' }),
      h.deps,
      'CF-1',
      'reject',
    );
    assert.equal(result.statusCode, 200);
    assert.equal(h.transitions[0]!.to, 'rejected');
    assert.equal(h.transitions[0]!.options.actor, 'operator:jane');
    assert.ok(!('approvedBy' in h.transitions[0]!.options));
  });
});

describe('repository error mapping', () => {
  it('maps IntakeNotFoundError to 404', async () => {
    const h = harness({ throwOn: 'not_found' });
    const result = await handleApproval(request({ operator: 'jane' }), h.deps, 'CF-404', 'approve');
    assert.equal(result.statusCode, 404);
  });

  it('maps InvalidTransitionError to 409, with detail', async () => {
    const h = harness({ throwOn: 'invalid_transition', item: item({ status: 'approved' }) });
    const result = await handleApproval(request({ operator: 'jane' }), h.deps, 'CF-1', 'approve');
    assert.equal(result.statusCode, 409);
    assert.equal(result.body['error'], 'invalid_transition');
    assert.ok(typeof result.body['detail'] === 'string' && result.body['detail']!.length > 0);
  });

  it('maps IntakeConflictError to 409', async () => {
    const h = harness({ throwOn: 'conflict' });
    const result = await handleApproval(request({ operator: 'jane' }), h.deps, 'CF-1', 'approve');
    assert.equal(result.statusCode, 409);
    assert.equal(result.body['error'], 'conflict');
  });

  it('maps an unexpected repository throw to 500, not a crash', async () => {
    const h = harness({ throwOn: 'unexpected' });
    const result = await handleApproval(request({ operator: 'jane' }), h.deps, 'CF-1', 'approve');
    assert.equal(result.statusCode, 500);
    assert.deepEqual(result.body, { error: 'internal_error' });
  });
});
