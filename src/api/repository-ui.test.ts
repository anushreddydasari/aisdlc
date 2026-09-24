/**
 * Structural/content tests for the static admin page. This codebase has no
 * browser-testing dependency (no jsdom, no bundler — see package.json), so
 * these tests assert on the served HTML/JS text directly: the same level
 * every other zero-dependency piece of this codebase is tested at.
 * Interaction against the REAL API is covered by server.test.ts (routing)
 * and repository-registry.test.ts (the handlers this page calls).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { REPOSITORY_UI_HTML } from './repository-ui.ts';

describe('REPOSITORY_UI_HTML', () => {
  it('is a well-formed HTML document titled "Repository Management"', () => {
    assert.ok(REPOSITORY_UI_HTML.startsWith('<!doctype html>'));
    assert.ok(REPOSITORY_UI_HTML.includes('<title>Repository Management</title>'));
    assert.ok(REPOSITORY_UI_HTML.includes('<h1>Repository Management</h1>'));
  });

  it('shows every required table column', () => {
    for (const column of ['Space / Project', 'Repository', 'Branch', 'Installation', 'Status', 'Actions']) {
      assert.ok(REPOSITORY_UI_HTML.includes(column), `missing column header: ${column}`);
    }
  });

  it('provides an "+ Add Repository" action', () => {
    assert.ok(REPOSITORY_UI_HTML.includes('+ Add Repository'));
  });

  it('the add/edit form has every required field', () => {
    for (const fieldId of ['field-project', 'field-url', 'field-repoid', 'field-branch', 'field-allowed', 'field-installation', 'field-active']) {
      assert.ok(REPOSITORY_UI_HTML.includes(`id="${fieldId}"`), `missing form field: ${fieldId}`);
    }
    assert.ok(REPOSITORY_UI_HTML.includes('Cancel'));
    assert.ok(REPOSITORY_UI_HTML.includes('Save Repository'));
  });

  it('the Active checkbox is disabled on the client — the backend, not this page, decides initial status', () => {
    // create() hard-codes status: 'active' server-side (repository-registry/repository.ts);
    // this page must not pretend the checkbox controls anything it doesn't.
    const activeFieldMatch = /<input id="field-active"[^>]*>/.exec(REPOSITORY_UI_HTML);
    assert.ok(activeFieldMatch, 'field-active input not found');
    assert.ok(activeFieldMatch![0].includes('disabled'));
  });

  it('has an explicit confirmation dialog for activate/deactivate, separate from the edit form', () => {
    assert.ok(REPOSITORY_UI_HTML.includes('id="confirm-overlay"'));
    assert.ok(REPOSITORY_UI_HTML.includes('id="confirm-message"'));
    assert.ok(REPOSITORY_UI_HTML.includes('id="confirm-ok"'));
    assert.ok(REPOSITORY_UI_HTML.includes('id="confirm-cancel"'));
  });

  it('only ever calls the existing /repository-registry API — no second registry, no invented endpoint', () => {
    const scriptStart = REPOSITORY_UI_HTML.indexOf('<script>');
    const scriptEnd = REPOSITORY_UI_HTML.indexOf('</script>');
    const script = REPOSITORY_UI_HTML.slice(scriptStart, scriptEnd);

    assert.ok(script.includes("var API_BASE = '/repository-registry';"));
    // No other absolute API path is ever fetched from this page.
    const fetchPaths = [...script.matchAll(/fetch\(([^,)]+)/g)].map((m) => m[1] ?? '');
    assert.ok(fetchPaths.length > 0, 'expected at least one fetch() call in the script');
    for (const expr of fetchPaths) {
      assert.ok(expr.includes('path'), `unexpected direct fetch target: ${expr}`);
    }
  });

  it('never mentions deployment, merge, or GitHub-write endpoints — this page manages the registry only', () => {
    const scriptStart = REPOSITORY_UI_HTML.indexOf('<script>');
    const scriptEnd = REPOSITORY_UI_HTML.indexOf('</script>');
    const script = REPOSITORY_UI_HTML.slice(scriptStart, scriptEnd);
    assert.ok(!script.includes('/runs/'));
    assert.ok(!script.includes('/deployment'));
    assert.ok(!script.includes('/coding-agent'));
    assert.ok(!script.includes('mergePullRequest'));
  });

  it('never embeds a credential-shaped literal value', () => {
    for (const forbidden of ['BEGIN PRIVATE KEY', 'ghp_', 'ghs_', 'sk-']) {
      assert.ok(!REPOSITORY_UI_HTML.includes(forbidden), `unexpectedly contains '${forbidden}'`);
    }
  });

  it('stores the operator token only in sessionStorage, under a page-scoped key, never in a cookie or localStorage', () => {
    assert.ok(REPOSITORY_UI_HTML.includes('sessionStorage'));
    assert.ok(!REPOSITORY_UI_HTML.includes('localStorage'));
    assert.ok(!REPOSITORY_UI_HTML.includes('document.cookie'));
  });

  it('loads no external script or stylesheet — fully self-contained, no new dependency introduced', () => {
    assert.ok(!/<script[^>]+src=/.test(REPOSITORY_UI_HTML));
    assert.ok(!/<link[^>]+stylesheet/.test(REPOSITORY_UI_HTML));
  });

  it('the client-side repository URL check mirrors the backend\'s own https://github.com/<org>/<repo> shape', () => {
    // Not the security boundary (the backend re-validates unconditionally —
    // see repository-registry/repository.ts's isValidGitHubRepositoryUrl),
    // but should fail fast on the same shape for a good user experience.
    assert.ok(REPOSITORY_UI_HTML.includes('github\\.com'));
  });

  it('explains the authorization model without inventing a new one', () => {
    assert.ok(REPOSITORY_UI_HTML.includes('operator token'));
    assert.ok(REPOSITORY_UI_HTML.toLowerCase().includes('authorization: bearer') || REPOSITORY_UI_HTML.includes('Authorization: Bearer'));
  });
});
