import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { IntakeSnapshot } from '../intake/repository.ts';
import { validateSnapshotForRequirements } from './validation.ts';

const VALID: IntakeSnapshot = {
  title: 'Login fails for SSO users',
  description: 'Steps to reproduce...',
  issueType: 'bug',
};

describe('validateSnapshotForRequirements', () => {
  it('accepts a snapshot with title, description and issueType', () => {
    assert.deepEqual(validateSnapshotForRequirements(VALID), { ok: true });
  });

  it('rejects an empty title', () => {
    const result = validateSnapshotForRequirements({ ...VALID, title: '' });
    assert.equal(result.ok, false);
    assert.match((result as { reason: string }).reason, /title/);
  });

  it('rejects a whitespace-only description', () => {
    const result = validateSnapshotForRequirements({ ...VALID, description: '   ' });
    assert.equal(result.ok, false);
    assert.match((result as { reason: string }).reason, /description/);
  });

  it('rejects an empty issueType', () => {
    const result = validateSnapshotForRequirements({ ...VALID, issueType: '' });
    assert.equal(result.ok, false);
    assert.match((result as { reason: string }).reason, /issueType/);
  });

  it('names every missing field at once', () => {
    const result = validateSnapshotForRequirements({ title: '', description: '', issueType: '' });
    assert.equal(result.ok, false);
    const reason = (result as { reason: string }).reason;
    assert.match(reason, /title/);
    assert.match(reason, /description/);
    assert.match(reason, /issueType/);
  });
});
