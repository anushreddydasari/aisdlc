import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import type { IncomingMessage } from 'node:http';

import { DEFAULT_MAX_BODY_BYTES, readRawBody } from './body.ts';

/**
 * A Readable standing in for IncomingMessage. `destroy()` is tracked so the
 * tests can assert that an oversized body stops being read rather than being
 * buffered and measured afterwards.
 */
function fakeRequest(
  chunks: readonly (Buffer | string)[],
  headers: Record<string, string> = {},
): IncomingMessage & { destroyed_: boolean } {
  const stream = Readable.from(
    (function* () {
      for (const chunk of chunks) yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    })(),
  ) as unknown as IncomingMessage & { destroyed_: boolean };

  stream.headers = headers as IncomingMessage['headers'];
  stream.destroyed_ = false;
  const originalDestroy = stream.destroy.bind(stream);
  stream.destroy = ((error?: Error) => {
    stream.destroyed_ = true;
    originalDestroy(error);
    return stream;
  }) as typeof stream.destroy;

  return stream;
}

describe('readRawBody', () => {
  it('returns the exact bytes received', async () => {
    const payload = JSON.stringify({ event: 'issue.created', issue: { key: 'AIS-1' } });
    const result = await readRawBody(fakeRequest([payload]));

    assert.ok(result.ok);
    assert.equal(result.body.toString('utf8'), payload);
  });

  it('reassembles a body split across chunks', async () => {
    // The MAC is over the whole body, so chunk boundaries must not matter.
    const result = await readRawBody(fakeRequest(['{"a":', '1,"b":', '2}']));
    assert.ok(result.ok);
    assert.equal(result.body.toString('utf8'), '{"a":1,"b":2}');
  });

  it('preserves bytes exactly, including multi-byte characters split mid-character', async () => {
    // A naive string concatenation would corrupt this and break the MAC.
    const text = Buffer.from('{"s":"日本語"}', 'utf8');
    const result = await readRawBody(fakeRequest([text.subarray(0, 8), text.subarray(8)]));

    assert.ok(result.ok);
    assert.deepEqual(result.body, text);
  });

  it('handles an empty body', async () => {
    const result = await readRawBody(fakeRequest([]));
    assert.ok(result.ok);
    assert.equal(result.body.length, 0);
  });

  it('defaults to a 256 KB ceiling', () => {
    assert.equal(DEFAULT_MAX_BODY_BYTES, 262_144);
  });
});

describe('the size ceiling', () => {
  it('refuses a body over the limit', async () => {
    const result = await readRawBody(fakeRequest(['x'.repeat(200)]), { maxBytes: 100 });
    assert.ok(!result.ok);
    assert.equal(result.reason, 'too_large');
  });

  it('stops reading instead of buffering and then measuring', async () => {
    const req = fakeRequest(['x'.repeat(50), 'y'.repeat(200), 'z'.repeat(1000)]);
    const result = await readRawBody(req, { maxBytes: 100 });

    assert.ok(!result.ok);
    assert.ok(req.destroyed_, 'the request was not destroyed once over the limit');
  });

  it('refuses on a declared Content-Length before reading a byte', async () => {
    // The cheapest rejection available: no data is consumed at all.
    const req = fakeRequest(['x'.repeat(10)], { 'content-length': '999999' });
    const result = await readRawBody(req, { maxBytes: 100 });

    assert.ok(!result.ok);
    assert.equal(result.reason, 'too_large');
    assert.ok(req.destroyed_);
  });

  it('ignores a Content-Length that lies about being small', async () => {
    // A header claiming 10 bytes while sending 200 must still be caught.
    const req = fakeRequest(['x'.repeat(200)], { 'content-length': '10' });
    const result = await readRawBody(req, { maxBytes: 100 });

    assert.ok(!result.ok);
    assert.equal(result.reason, 'too_large');
  });

  it('ignores a malformed Content-Length and falls back to counting', async () => {
    const req = fakeRequest(['x'.repeat(200)], { 'content-length': 'not-a-number' });
    const result = await readRawBody(req, { maxBytes: 100 });

    assert.ok(!result.ok);
    assert.equal(result.reason, 'too_large');
  });

  it('accepts a body exactly at the limit', async () => {
    const result = await readRawBody(fakeRequest(['x'.repeat(100)]), { maxBytes: 100 });
    assert.ok(result.ok);
    assert.equal(result.body.length, 100);
  });

  it('refuses a body one byte over the limit', async () => {
    const result = await readRawBody(fakeRequest(['x'.repeat(101)]), { maxBytes: 100 });
    assert.ok(!result.ok);
  });
});

describe('transport failures', () => {
  it('reports an aborted request rather than rejecting', async () => {
    const stream = new Readable({ read() {} }) as unknown as IncomingMessage;
    stream.headers = {};
    const pending = readRawBody(stream);
    stream.emit('error', new Error('socket hang up'));

    const result = await pending;
    assert.ok(!result.ok);
    assert.equal(result.reason, 'aborted');
  });

  it('settles once, even if several events fire', async () => {
    const stream = new Readable({ read() {} }) as unknown as IncomingMessage;
    stream.headers = {};
    const pending = readRawBody(stream);
    stream.emit('error', new Error('first'));
    stream.emit('aborted');
    stream.emit('end');

    const result = await pending;
    assert.ok(!result.ok);
    assert.equal(result.reason, 'aborted');
  });
});
