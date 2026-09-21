import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildSignatureHeader, verifySignature } from '../api/signature.ts';
import { validateIssueEvent } from '../api/ingest-payload.ts';
import { toSnapshot } from '../enrichment/worker.ts';
import { matchesRequestedIdentifier, type NeutaraIssue } from '../neutara/client.ts';
import { assertLoopbackTarget, buildSyntheticEvent } from './send-test-webhook.ts';
import { mockIssues } from './mock-neutara.ts';

const LOCAL_SECRET = 'whsec_local_testing_only_value'; // pragma: fixture

describe('the synthetic webhook payload', () => {
  it('passes the service\'s own validation', () => {
    // If this ever drifts from Neutara's contract the local test would pass
    // while the real thing failed, which is worse than no local test.
    const result = validateIssueEvent(buildSyntheticEvent({ issueKey: 'CF-33261' }));
    assert.ok(result.ok, 'the synthetic payload is not a valid issue event');
    assert.equal(result.event.issue.key, 'CF-33261');
    assert.equal(result.event.event, 'issue.created');
  });

  it('defaults to issue.created, the only accepted event', () => {
    assert.equal(buildSyntheticEvent({ issueKey: 'X-1' })['event'], 'issue.created');
  });

  it('carries an obviously synthetic summary and a loopback url', () => {
    const issue = buildSyntheticEvent({ issueKey: 'CF-33261' })['issue'] as Record<string, string>;
    assert.match(issue['summary']!, /Local test ticket/);
    assert.match(issue['url']!, /^http:\/\/127\.0\.0\.1\//);
  });

  it('produces a signature the service accepts', () => {
    // Signed and verified with the same pair the service uses, so a local
    // request is byte-identical in shape to one from Neutara's connector.
    const body = Buffer.from(JSON.stringify(buildSyntheticEvent({ issueKey: 'CF-33261' })));
    const header = buildSignatureHeader(LOCAL_SECRET, body);
    assert.ok(verifySignature({ secret: LOCAL_SECRET, body, header }).valid);
  });

  it('a signature made with a different secret is rejected', () => {
    const body = Buffer.from(JSON.stringify(buildSyntheticEvent({ issueKey: 'CF-33261' })));
    const header = buildSignatureHeader('whsec_a_different_local_value', body); // pragma: fixture
    assert.ok(!verifySignature({ secret: LOCAL_SECRET, body, header }).valid);
  });
});

describe('the loopback guard', () => {
  it('accepts loopback targets', () => {
    for (const target of [
      'http://127.0.0.1:4600/ingest',
      'http://localhost:4600/ingest',
      'http://[::1]:4600/ingest',
    ]) {
      assert.doesNotThrow(() => assertLoopbackTarget(target), `rejected ${target}`);
    }
  });

  it('refuses any non-loopback host', () => {
    // A signed webhook aimed at a public host is a real delivery into a real
    // system. This script has no business being able to do that.
    // A public host stands in for the real Neutara instance deliberately:
    // this repository is public, and naming the production ticketing host in
    // it tells a reader exactly where to point a stolen credential. The test
    // proves the same thing with an RFC 2606 reserved domain.
    for (const target of [
      'https://neutara.example.com/ingest',
      'http://10.0.0.5:4600/ingest',
      'http://example.com/ingest',
    ]) {
      assert.throws(() => assertLoopbackTarget(target), /loopback only/, `accepted ${target}`);
    }
  });

  it('refuses a malformed target', () => {
    assert.throws(() => assertLoopbackTarget('not a url'), /not a valid URL/);
  });
});

describe('the mock Neutara fixture', () => {
  it('is addressable by both identifiers', () => {
    const issues = mockIssues();
    assert.ok(issues.has('CF-33261'));
    assert.ok(issues.has('LOCAL-1001'));
    assert.equal(issues.get('CF-33261'), issues.get('LOCAL-1001'));
  });

  it('gives the canonical key a different value from the cfKey', () => {
    // This is what makes the local run exercise identifier normalisation
    // rather than the trivial case where both are the same.
    const issue = mockIssues().get('CF-33261')!;
    assert.notEqual(issue['key'], issue['cfKey']);
  });

  it('satisfies the client\'s identifier check for both', () => {
    const issue = mockIssues().get('CF-33261') as unknown as NeutaraIssue;
    assert.ok(matchesRequestedIdentifier(issue, 'CF-33261'));
    assert.ok(matchesRequestedIdentifier(issue, 'LOCAL-1001'));
    assert.ok(!matchesRequestedIdentifier(issue, 'CF-999'));
  });

  it('supplies the description the webhook payload lacks', () => {
    // The entire reason enrichment exists.
    const issue = mockIssues().get('CF-33261')!;
    assert.equal(typeof issue['description'], 'string');
    assert.ok((issue['description'] as string).length > 0);
  });

  it('maps onto a complete intake snapshot', () => {
    const snapshot = toSnapshot(mockIssues().get('CF-33261') as unknown as NeutaraIssue);
    assert.equal(snapshot.title, 'Local mock ticket for enrichment testing');
    assert.ok(snapshot.description.length > 0);
    assert.equal(snapshot.issueType, 'task');
    assert.equal(snapshot.project, 'LOCAL');
    assert.deepEqual(snapshot.labels, ['local', 'enrichment-test']);
  });

  it('uses only invalid or loopback hostnames', () => {
    // .invalid is reserved by RFC 2606; nothing here can resolve to a real
    // host if a value escapes into a request. The regex is the general form
    // of "no real host", which also keeps the production hostname out of
    // this file rather than naming it to assert its absence.
    const serialised = JSON.stringify([...mockIssues().values()]);
    assert.ok(!/https?:\/\/(?!127\.0\.0\.1)/.test(serialised), 'a non-loopback URL is in the mock');
    assert.ok(!/\.(com|net|org|live|io)\b/.test(serialised), 'a real-looking TLD is in the mock');
  });
});
