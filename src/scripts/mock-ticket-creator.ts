/**
 * The mock Neutara's ticket creator — a browser form for making test tickets
 * without editing mock-neutara.ts's fixtures or running `webhook:local`.
 *
 *   npm run mock:neutara   →   open http://127.0.0.1:4601/
 *
 * A created ticket goes through the SAME path a real one does: it is stored
 * here, a signed `issue.created` webhook is sent to the local service's
 * /ingest, and the service's enrichment loop then fetches it back from this
 * mock's ordinary /api/issues/:id route. Nothing downstream can tell it
 * apart from a fixture ticket, which is the point.
 *
 * Lives on the mock, never on the service: the mock binds 127.0.0.1 only
 * and never runs in production, so this page cannot exist anywhere a real
 * ticket could be forged. The webhook itself reuses send-test-webhook.ts's
 * loopback-only target check and api/signature.ts's signer unchanged.
 *
 * Tickets are held in memory. Restarting the mock forgets them; an intake
 * item already enriched is unaffected, but a delivery still pending
 * enrichment will 404 until retried against a ticket the mock knows.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { buildSignatureHeader } from '../api/signature.ts';
import { assertLoopbackTarget, buildSyntheticEvent } from './send-test-webhook.ts';
import { renderMockTicketUi } from './mock-ticket-ui.ts';

export const TICKET_TYPES = ['task', 'bug', 'story', 'epic'] as const;
export const TICKET_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;

const SPACE_KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,19}$/;
const LABEL_PATTERN = /^[A-Za-z0-9_-]{1,50}$/;
const MAX_SUMMARY = 512; // ingest-payload.ts's LIMITS.summary
const MAX_DESCRIPTION = 20_000;
const MAX_LABELS = 10;
const MAX_BODY_BYTES = 64 * 1024;

export interface TicketInput {
  readonly summary: string;
  readonly description: string;
  readonly type: (typeof TICKET_TYPES)[number];
  readonly priority: (typeof TICKET_PRIORITIES)[number];
  readonly spaceKey: string;
  readonly labels: readonly string[];
}

export type TicketInputValidation = { ok: true; value: TicketInput } | { ok: false; reason: string };

/** UX-level checks only — the service still validates everything it receives. */
export function validateTicketInput(body: unknown): TicketInputValidation {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, reason: 'body must be a JSON object' };
  const b = body as Record<string, unknown>;

  const summary = typeof b['summary'] === 'string' ? b['summary'].trim() : '';
  if (summary === '') return { ok: false, reason: 'summary is required' };
  if (summary.length > MAX_SUMMARY) return { ok: false, reason: `summary must be at most ${MAX_SUMMARY} characters` };

  const description = typeof b['description'] === 'string' ? b['description'].trim() : '';
  if (description === '') return { ok: false, reason: 'description is required — it is what the Requirements Agent analyzes' };
  if (description.length > MAX_DESCRIPTION) return { ok: false, reason: `description must be at most ${MAX_DESCRIPTION} characters` };

  const type = b['type'] ?? 'task';
  if (!(TICKET_TYPES as readonly unknown[]).includes(type)) return { ok: false, reason: `type must be one of ${TICKET_TYPES.join(', ')}` };

  const priority = b['priority'] ?? 'medium';
  if (!(TICKET_PRIORITIES as readonly unknown[]).includes(priority)) {
    return { ok: false, reason: `priority must be one of ${TICKET_PRIORITIES.join(', ')}` };
  }

  const spaceKey = typeof b['spaceKey'] === 'string' ? b['spaceKey'].trim() : '';
  if (!SPACE_KEY_PATTERN.test(spaceKey)) {
    return { ok: false, reason: 'space key must be 2–20 characters: uppercase letters, digits or _, starting with a letter' };
  }

  const rawLabels = b['labels'] ?? [];
  if (!Array.isArray(rawLabels)) return { ok: false, reason: 'labels must be a list' };
  const labels = rawLabels.map((l) => (typeof l === 'string' ? l.trim() : '')).filter((l) => l !== '');
  if (labels.length > MAX_LABELS) return { ok: false, reason: `at most ${MAX_LABELS} labels` };
  const badLabel = labels.find((l) => !LABEL_PATTERN.test(l));
  if (badLabel !== undefined) return { ok: false, reason: `label '${badLabel}' may only contain letters, digits, - and _` };

  return {
    ok: true,
    value: {
      summary,
      description,
      type: type as TicketInput['type'],
      priority: priority as TicketInput['priority'],
      spaceKey,
      labels,
    },
  };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Plain text in, Neutara-shaped HTML out: one <p> per blank-line-separated paragraph. */
export function toDescriptionHtml(text: string): string {
  return text
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map((p) => `<p>${escapeHtml(p).replace(/\r?\n/g, '<br>')}</p>`)
    .join('');
}

export interface WebhookAttempt {
  readonly at: string;
  readonly httpStatus: number | null;
  readonly response: string;
}

export interface CreatedTicket {
  readonly issue: Record<string, unknown>;
  lastWebhook: WebhookAttempt | null;
}

export interface TicketStore {
  add(input: TicketInput, now: Date): CreatedTicket;
  /** By canonical key or CF key — the same two identifiers the fixtures answer to. */
  get(identifier: string): CreatedTicket | undefined;
  list(): CreatedTicket[];
}

/**
 * Numbers are derived from the clock rather than a counter starting at 1,
 * so a restarted mock does not reissue a key whose intake item already
 * exists (intakeItems.issueKey is unique). The 900000-series CF range keeps
 * them visibly apart from the fixtures' CF-33261/CF-33262.
 */
export function createTicketStore(): TicketStore {
  const byIdentifier = new Map<string, CreatedTicket>();
  const ordered: CreatedTicket[] = [];

  return {
    add(input, now) {
      let n = 900_000 + (Math.floor(now.getTime() / 1000) % 100_000);
      while (byIdentifier.has(`CF-${n}`)) n += 1;

      const issue: Record<string, unknown> = {
        key: `${input.spaceKey}-${n}`,
        cfKey: `CF-${n}`,
        summary: input.summary,
        description: toDescriptionHtml(input.description),
        type: input.type,
        priority: input.priority,
        status: { name: 'Open' },
        spaceKey: input.spaceKey,
        spaceName: `${input.spaceKey} (local test)`,
        reporter: { email: 'ticket-creator@localhost.invalid', displayName: 'Mock Ticket Creator' },
        assignee: null,
        parentKey: null,
        labels: [...input.labels],
        createdAt: now.toISOString(),
      };
      const ticket: CreatedTicket = { issue, lastWebhook: null };
      byIdentifier.set(issue['key'] as string, ticket);
      byIdentifier.set(issue['cfKey'] as string, ticket);
      ordered.unshift(ticket);
      return ticket;
    },
    get(identifier) {
      return byIdentifier.get(identifier);
    },
    list() {
      return [...ordered];
    },
  };
}

export type SendWebhook = (ticket: CreatedTicket) => Promise<WebhookAttempt>;

/**
 * Sends the ticket's `issue.created` webhook to the local service, keyed by
 * its CF identifier (as Neutara's connector does), so the service's
 * identifier normalisation runs exactly as it does for CF-33261.
 */
export function createWebhookSender(env: NodeJS.ProcessEnv, now: () => Date = () => new Date()): SendWebhook {
  return async (ticket) => {
    const at = now().toISOString();
    const secret = (env['NEUTARA_WEBHOOK_SECRET'] ?? '').trim();
    if (secret === '') {
      return { at, httpStatus: null, response: 'NEUTARA_WEBHOOK_SECRET is not set in .env; cannot sign the webhook' };
    }
    const port = (env['AISDLC_PORT'] ?? '4600').trim();
    const target = assertLoopbackTarget(`http://127.0.0.1:${port}/ingest`);

    const issue = ticket.issue;
    const body = JSON.stringify(
      buildSyntheticEvent({
        issueKey: issue['cfKey'] as string,
        timestamp: at,
        summary: issue['summary'] as string,
        type: issue['type'] as string,
        priority: issue['priority'] as string,
        spaceKey: issue['spaceKey'] as string,
      }),
    );
    try {
      const response = await fetch(target.href, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-neutara-signature': buildSignatureHeader(secret, Buffer.from(body, 'utf8')),
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      return { at, httpStatus: response.status, response: (await response.text()).slice(0, 2000) };
    } catch (error) {
      const cause = (error as { cause?: { code?: string } }).cause?.code;
      return {
        at,
        httpStatus: null,
        response:
          cause === 'ECONNREFUSED'
            ? `the service is not running on 127.0.0.1:${port} — start it with \`npm run dev\`, then click Resend`
            : `webhook failed: ${(error as Error).message}`,
      };
    }
  };
}

export interface TicketAdminDeps {
  readonly store: TicketStore;
  readonly sendWebhook: SendWebhook;
  readonly port: number;
  /** The local service's port: the page's registry link, and the console origin allowed to call /__mock/tickets. */
  readonly servicePort: number;
  readonly now?: () => Date;
}

/** Paths this module owns. Everything else stays with mock-neutara.ts's Neutara imitation. */
export function isTicketAdminPath(pathname: string): boolean {
  return pathname === '/' || pathname === '/__mock/tickets' || /^\/__mock\/tickets\/[^/]+\/webhook$/.test(pathname);
}

/**
 * Host must be this mock's own loopback address (defeats DNS rebinding), and
 * a browser-supplied Origin must be this mock itself or one of
 * `consoleOrigins` — the local service's AISDLC Console — which defeats any
 * other website POSTing here from the same browser. Writes additionally
 * require a JSON content type, so a cross-origin page needs a CORS preflight,
 * which this mock only answers for `consoleOrigins`.
 */
export function isSameOriginLocal(req: IncomingMessage, port: number, consoleOrigins: readonly string[] = []): boolean {
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const host = req.headers['host'];
  if (typeof host !== 'string' || !allowed.has(host)) return false;
  const origin = req.headers['origin'];
  if (origin === undefined) return true;
  if (typeof origin !== 'string') return false;
  return [...allowed].some((h) => origin === `http://${h}`) || consoleOrigins.includes(origin);
}

/** The local service's own origins — the only cross-origin caller this mock accepts. */
export function consoleOriginsFor(servicePort: number): string[] {
  return [`http://127.0.0.1:${servicePort}`, `http://localhost:${servicePort}`];
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return { ok: false, reason: 'request body too large' };
    chunks.push(chunk as Buffer);
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch {
    return { ok: false, reason: 'request body is not valid JSON' };
  }
}

function summarize(ticket: CreatedTicket): Record<string, unknown> {
  const i = ticket.issue;
  return {
    key: i['key'],
    cfKey: i['cfKey'],
    summary: i['summary'],
    type: i['type'],
    priority: i['priority'],
    spaceKey: i['spaceKey'],
    labels: i['labels'],
    createdAt: i['createdAt'],
    lastWebhook: ticket.lastWebhook,
  };
}

export async function handleTicketAdminRequest(req: IncomingMessage, res: ServerResponse, deps: TicketAdminDeps): Promise<void> {
  const { store, sendWebhook, port } = deps;
  const now = deps.now ?? (() => new Date());
  const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  const method = req.method ?? 'GET';

  const consoleOrigins = consoleOriginsFor(deps.servicePort);
  if (!isSameOriginLocal(req, port, consoleOrigins)) {
    sendJson(res, 403, { error: 'forbidden', detail: `open this page at http://127.0.0.1:${port}/` });
    return;
  }

  // The AISDLC Console (service origin) calls the JSON routes cross-origin.
  // Set once here so every response below carries it; never for the page.
  const origin = req.headers['origin'];
  const fromConsole = typeof origin === 'string' && consoleOrigins.includes(origin);
  if (fromConsole && pathname !== '/') {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
  }
  if (method === 'OPTIONS') {
    if (!fromConsole || pathname === '/') {
      sendJson(res, 403, { error: 'forbidden' });
      return;
    }
    res.writeHead(204, {
      'access-control-allow-methods': 'GET, POST',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600',
    });
    res.end();
    return;
  }

  if (pathname === '/') {
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    const html = renderMockTicketUi(deps.servicePort);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(html),
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
    });
    res.end(method === 'HEAD' ? undefined : html);
    return;
  }

  if (method !== 'GET' && !String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    sendJson(res, 415, { error: 'unsupported_media_type', detail: 'send application/json' });
    return;
  }

  if (pathname === '/__mock/tickets') {
    if (method === 'GET') {
      sendJson(res, 200, { tickets: store.list().map(summarize) });
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    const body = await readJsonBody(req);
    if (!body.ok) {
      sendJson(res, 400, { error: 'bad_request', detail: body.reason });
      return;
    }
    const input = validateTicketInput(body.value);
    if (!input.ok) {
      sendJson(res, 400, { error: 'bad_request', detail: input.reason });
      return;
    }
    const ticket = store.add(input.value, now());
    ticket.lastWebhook = await sendWebhook(ticket);
    sendJson(res, 201, { ticket: summarize(ticket) });
    return;
  }

  const resend = /^\/__mock\/tickets\/([^/]+)\/webhook$/.exec(pathname);
  if (resend !== null) {
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    const ticket = store.get(decodeURIComponent(resend[1]!));
    if (ticket === undefined) {
      sendJson(res, 404, { error: 'not_found', detail: 'unknown ticket (the mock forgets tickets when restarted)' });
      return;
    }
    ticket.lastWebhook = await sendWebhook(ticket);
    sendJson(res, 200, { ticket: summarize(ticket) });
    return;
  }

  sendJson(res, 404, { error: 'not_found' });
}
