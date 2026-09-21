/**
 * Sends one synthetic, correctly signed `issue.created` webhook to a LOCAL
 * AISDLC instance.
 *
 *   npm run webhook:local -- CF-33261
 *
 * This exists so the ingestion path can be exercised without involving
 * Neutara at all. The signature is produced by the same `buildSignatureHeader`
 * the service verifies with and the tests use, so a request from here is
 * byte-identical in shape to one from Neutara's connector.
 *
 * SAFETY: the target must be loopback. A signed webhook aimed at a public
 * host would be a real delivery into a real system, and this script has no
 * business being able to do that. `NEUTARA_WEBHOOK_SECRET` here should be a
 * LOCAL-ONLY value, never the secret configured on the real connector.
 */

import { buildSignatureHeader } from '../api/signature.ts';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export interface SyntheticEventOptions {
  readonly issueKey: string;
  readonly event?: string;
  readonly timestamp?: string;
}

/** A payload matching Neutara's IssueEventPayload, with obvious test values. */
export function buildSyntheticEvent(options: SyntheticEventOptions): Record<string, unknown> {
  return {
    event: options.event ?? 'issue.created',
    timestamp: options.timestamp ?? new Date().toISOString(),
    issue: {
      key: options.issueKey,
      summary: `Local test ticket ${options.issueKey}`,
      type: 'task',
      priority: 'medium',
      spaceKey: 'LOCAL',
      url: `http://127.0.0.1/browse/${options.issueKey}`,
    },
  };
}

/** Loopback only. Anything else is refused before a request is built. */
export function assertLoopbackTarget(target: string): URL {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new Error(`target is not a valid URL: ${target}`);
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      `refusing to send a signed webhook to '${url.hostname}'; ` +
        'this script targets loopback only',
    );
  }
  return url;
}

// ── CLI ──────────────────────────────────────────────────────────────────
// Guarded so the helpers above stay importable by tests without firing a
// request on import.
if (process.argv[1]?.endsWith('send-test-webhook.ts')) {
  const issueKey = process.argv[2] ?? 'CF-33261';
  const port = (process.env['AISDLC_PORT'] ?? '4600').trim();
  const target = assertLoopbackTarget(`http://127.0.0.1:${port}/ingest`);

  const secret = (process.env['NEUTARA_WEBHOOK_SECRET'] ?? '').trim();
  if (secret === '') {
    console.error('NEUTARA_WEBHOOK_SECRET is not set. Use a local-only value, for example:');
    console.error("  node -e \"console.log('whsec_local_'+require('crypto').randomBytes(24).toString('hex'))\"");
    process.exit(78); // EX_CONFIG
  }

  // Serialised once: the signature must cover the exact bytes sent.
  const body = JSON.stringify(buildSyntheticEvent({ issueKey }));
  const raw = Buffer.from(body, 'utf8');

  console.log(`POST ${target.href}`);
  console.log(`  issueKey: ${issueKey}`);

  const response = await fetch(target.href, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-neutara-signature': buildSignatureHeader(secret, raw),
    },
    body,
  });

  console.log(`  HTTP ${response.status}`);
  console.log(`  ${await response.text()}`);
  process.exit(response.ok ? 0 : 1);
}
