import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { REDACTED, createLogger, redact, redactUri } from './logger.ts';

const FAKE_PASSWORD = 'p4ssw0rd-should-never-be-logged';
const FAKE_URI = `mongodb+srv://aisdlc_app:${FAKE_PASSWORD}@cluster0.example.mongodb.net/aisdlc`;

function capture(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

function records(lines: readonly string[]): Record<string, unknown>[] {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('createLogger', () => {
  it('writes one JSON object per line', () => {
    const { lines, write } = capture();
    createLogger({ write, now: () => new Date('2026-09-20T00:00:00.000Z') }).info('hello', { a: 1 });

    assert.equal(lines.length, 1);
    assert.deepEqual(records(lines)[0], {
      ts: '2026-09-20T00:00:00.000Z',
      level: 'info',
      msg: 'hello',
      a: 1,
    });
  });

  it('filters below the configured level', () => {
    const { lines, write } = capture();
    const logger = createLogger({ write, level: 'warn' });
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    assert.deepEqual(records(lines).map((r) => r['level']), ['warn', 'error']);
  });

  it('stamps child fields onto every record', () => {
    const { lines, write } = capture();
    createLogger({ write, base: { service: 'aisdlc' } }).child({ runId: 'r1' }).info('x');

    const record = records(lines)[0]!;
    assert.equal(record['service'], 'aisdlc');
    assert.equal(record['runId'], 'r1');
  });

  it('serializes an Error without losing its message', () => {
    const { lines, write } = capture();
    createLogger({ write }).error('failed', { error: new TypeError('bad input') });

    const error = records(lines)[0]!['error'] as Record<string, unknown>;
    assert.equal(error['name'], 'TypeError');
    assert.equal(error['message'], 'bad input');
  });
});

describe('redaction', () => {
  it('blanks a field whose name suggests a secret', () => {
    for (const key of ['password', 'API_KEY', 'authToken', 'mongodbUri', 'Authorization']) {
      assert.equal((redact({ [key]: 'sensitive' }) as Record<string, unknown>)[key], REDACTED);
    }
  });

  it('blanks a connection string appearing anywhere in a value', () => {
    const out = redact({ note: `connect via ${FAKE_URI} then retry` }) as Record<string, string>;
    assert.ok(!out['note']!.includes(FAKE_PASSWORD));
    assert.ok(out['note']!.includes(REDACTED));
  });

  it('blanks known token shapes in free text', () => {
    const cases = [
      'sk-ant-api03-AAAAAAAABBBBBBBBCCCCCCCC',
      'nta_AAAAAAAABBBBBBBBCCCCCCCC',
      'AKIAIOSFODNN7EXAMPLE',
    ];
    for (const token of cases) {
      const out = redact({ note: `token is ${token}` }) as Record<string, string>;
      assert.ok(!out['note']!.includes(token), `leaked ${token}`);
    }
  });

  it('redacts a secret in the log message itself, not just in fields', () => {
    const { lines, write } = capture();
    createLogger({ write }).info(`connecting to ${FAKE_URI}`);
    assert.ok(!lines[0]!.includes(FAKE_PASSWORD));
  });

  it('reaches into nested objects and arrays', () => {
    const out = redact({ outer: { inner: [{ token: 'abc' }] } }) as {
      outer: { inner: { token: string }[] };
    };
    assert.equal(out.outer.inner[0]!.token, REDACTED);
  });

  it('stops at a depth limit instead of recursing forever', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    // The assertion is that this returns at all.
    assert.ok(JSON.stringify(redact(cyclic)).includes('[truncated]'));
  });

  it('leaves ordinary values alone', () => {
    const out = redact({ port: 8090, ready: true, name: 'aisdlc' }) as Record<string, unknown>;
    assert.deepEqual(out, { port: 8090, ready: true, name: 'aisdlc' });
  });
});

describe('redactUri', () => {
  it('keeps the host and database but drops the credentials', () => {
    const out = redactUri(FAKE_URI);
    assert.ok(!out.includes(FAKE_PASSWORD));
    assert.ok(!out.includes('aisdlc_app'));
    assert.ok(out.includes('cluster0.example.mongodb.net'));
    assert.equal(out, `mongodb+srv://${REDACTED}@cluster0.example.mongodb.net/aisdlc`);
  });

  it('passes through a URI with no credentials', () => {
    assert.equal(redactUri('mongodb://localhost:27017/aisdlc'), 'mongodb://localhost:27017/aisdlc');
  });
});
