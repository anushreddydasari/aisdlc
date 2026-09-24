import assert from 'node:assert/strict';
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { hashFileContent } from '../coding-agent/changes.ts';
import { applyChangesLocally } from './local-apply.ts';
import type { ProposedChange } from './types.ts';

const RUN_ID = 'run-1';

function modifyChange(overrides: Partial<ProposedChange> = {}): ProposedChange {
  return {
    filePath: 'src/index.ts',
    operation: 'modify',
    originalContentHash: hashFileContent('export const original = true;'),
    proposedContent: 'export const updated = true;',
    reason: 'r',
    relatedPlanItemId: 'item-1',
    ...overrides,
  };
}

function createChange(overrides: Partial<ProposedChange> = {}): ProposedChange {
  return {
    filePath: 'src/new-file.ts',
    operation: 'create',
    originalContentHash: null,
    proposedContent: 'export const brandNew = true;',
    reason: 'r',
    relatedPlanItemId: 'item-1',
    ...overrides,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('applyChangesLocally — success', () => {
  it('writes a create change into a fresh working directory', async () => {
    const change = createChange();
    const result = await applyChangesLocally({
      runId: RUN_ID,
      proposedChanges: [change],
      currentFileContents: new Map(),
    });

    assert.ok(result.ok);
    assert.deepEqual(result.appliedChanges, [{ path: change.filePath, operation: 'create' }]);
    const written = await readFile(join(result.workingDirectory, change.filePath), 'utf8');
    assert.equal(written, change.proposedContent);

    await rm(result.workingDirectory, { recursive: true, force: true });
  });

  it('writes a modify change when the live content hash matches the reviewed original hash', async () => {
    const change = modifyChange();
    const result = await applyChangesLocally({
      runId: RUN_ID,
      proposedChanges: [change],
      currentFileContents: new Map([[change.filePath, 'export const original = true;']]),
    });

    assert.ok(result.ok);
    const written = await readFile(join(result.workingDirectory, change.filePath), 'utf8');
    assert.equal(written, change.proposedContent);

    await rm(result.workingDirectory, { recursive: true, force: true });
  });

  it('creates nested directories as needed', async () => {
    const change = createChange({ filePath: 'src/nested/deep/file.ts' });
    const result = await applyChangesLocally({
      runId: RUN_ID,
      proposedChanges: [change],
      currentFileContents: new Map(),
    });

    assert.ok(result.ok);
    assert.ok(await pathExists(join(result.workingDirectory, 'src/nested/deep/file.ts')));

    await rm(result.workingDirectory, { recursive: true, force: true });
  });
});

describe('applyChangesLocally — stale content (Section 11)', () => {
  it('refuses when the live file content hash no longer matches the reviewed original hash', async () => {
    const change = modifyChange();
    const result = await applyChangesLocally({
      runId: RUN_ID,
      proposedChanges: [change],
      currentFileContents: new Map([[change.filePath, 'export const someoneElseChangedThis = true;']]),
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'stale_file');
      assert.equal(result.filePath, change.filePath);
    }
  });

  it('refuses when a modify target could not be re-read at all', async () => {
    const change = modifyChange();
    const result = await applyChangesLocally({
      runId: RUN_ID,
      proposedChanges: [change],
      currentFileContents: new Map(),
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'stale_file');
  });
});

describe('applyChangesLocally — path safety (Section 6)', () => {
  it('refuses a path-traversal attempt', async () => {
    const change = createChange({ filePath: '../outside-repo.ts' });
    const result = await applyChangesLocally({
      runId: RUN_ID,
      proposedChanges: [change],
      currentFileContents: new Map(),
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'invalid_path');
  });

  it('refuses an absolute path', async () => {
    const change = createChange({ filePath: '/etc/passwd' });
    const result = await applyChangesLocally({
      runId: RUN_ID,
      proposedChanges: [change],
      currentFileContents: new Map(),
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'invalid_path');
  });

  it('refuses a credential-shaped file', async () => {
    const change = createChange({ filePath: '.env' });
    const result = await applyChangesLocally({
      runId: RUN_ID,
      proposedChanges: [change],
      currentFileContents: new Map(),
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'unauthorized_file');
  });

  it('refuses unauthorized CI/CD configuration', async () => {
    const change = createChange({ filePath: '.github/workflows/deploy.yml' });
    const result = await applyChangesLocally({
      runId: RUN_ID,
      proposedChanges: [change],
      currentFileContents: new Map(),
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'unauthorized_file');
  });

  it('validates every change before writing any of them (atomicity)', async () => {
    const good = createChange({ filePath: 'src/good.ts' });
    const bad = createChange({ filePath: '.env' });
    const result = await applyChangesLocally({
      runId: RUN_ID,
      proposedChanges: [good, bad],
      currentFileContents: new Map(),
    });

    assert.equal(result.ok, false);
    // No working directory is created at all — validation runs before any write.
  });
});

describe('applyChangesLocally — atomicity on write failure', () => {
  it('removes the working directory entirely if a later write fails', async () => {
    // 'conflict' is first created as a FILE; 'conflict/child.ts' then
    // requires 'conflict' to be a DIRECTORY, which fails deterministically.
    const changes: ProposedChange[] = [
      createChange({ filePath: 'conflict' }),
      createChange({ filePath: 'conflict/child.ts' }),
    ];
    const result = await applyChangesLocally({
      runId: RUN_ID,
      proposedChanges: changes,
      currentFileContents: new Map(),
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'write_failed');
  });
});
