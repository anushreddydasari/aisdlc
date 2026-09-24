# Neutara Integration: Mock vs Real, and How to Switch

This document is the reference for the two interchangeable modes the
Neutara enrichment integration (`enrichment/worker.ts`,
`neutara/client.ts`) can run in, and exactly what configuration each one
needs. **Switching between them changes zero application logic** —
`createNeutaraClient`, `enrichDelivery`, and everything downstream treat
both modes identically. The only thing that differs is which origin
`NEUTARA_API_BASE_URL` names, and what the service reports about itself at
startup.

This followed directly from diagnosing why ticket CF-33337 (space
`SAT_Board`) never reached AISDLC intake: the local dev environment was
(correctly, for local development) pointed at the local mock, which has no
knowledge of that ticket. This document exists so that fact is visible at
a glance the next time it comes up, rather than requiring a fresh
investigation.

## The two modes

| | A. Local mock/test mode | B. Real Neutara test-environment mode |
| --- | --- | --- |
| `NEUTARA_API_BASE_URL` | `http://127.0.0.1:4601` (or wherever `npm run mock:neutara` is bound) | The real Neutara test/staging origin, e.g. `https://neutara-test.example.com` |
| `NEUTARA_API_TOKEN` | Any non-empty string — the mock checks a `Bearer` header is *present*, never its value | A real `nta_...` token for a **dedicated test-tier** Neutara service user |
| What's reachable | Only the mock's own hard-coded fixture(s) — see `src/scripts/mock-neutara.ts`'s `mockIssues()` | Whatever tickets actually exist in that Neutara environment |
| Startup log | `neutara integration enabled in MOCK mode (...)` | `neutara integration enabled in REAL mode (...)` |
| Switched by | Whoever edits `.env` and restarts the service. **Never automatic** — see "Do not auto-switch" below. |

Classification is purely by hostname: `127.0.0.1`, `localhost`, and `::1`
are 'mock'; anything else is 'real' (`classifyNeutaraMode` in
`src/config/env.ts`). This is a **startup-visibility label only, never a
security boundary or a behavior switch** — nothing downstream branches on
it.

## How to switch

Change exactly one thing in `.env` and restart the service:

```
# Mode A — local mock
NEUTARA_API_BASE_URL=http://127.0.0.1:4601
NEUTARA_API_TOKEN=<any non-empty value>

# Mode B — real Neutara test environment
NEUTARA_API_BASE_URL=https://neutara-test.example.com
NEUTARA_API_TOKEN=<a real nta_ test-tier token>
```

No other variable changes, and no code changes — `NEUTARA_WEBHOOK_SECRET`,
`AISDLC_DATABASE_NAME`, `OPERATOR_TOKEN`, etc. are all independent of this
choice.

## What switching does NOT do

- **Does not make this service reachable by Neutara's webhook.** This
  variable governs *outbound* enrichment fetches only. A real Neutara
  instance sending a real `issue.created` webhook needs a real network
  path to this service's `/ingest` (a public URL, a tunnel, or a real
  deployment) — none of which this variable provides, and none of which is
  set up by switching to mode B. Without that path, `webhookDeliveries`
  stays empty for a real ticket even in real mode; see
  `src/scripts/send-test-webhook.ts` for the supported way to exercise
  `/ingest` locally without a live Neutara connection at all.
- **Does not change validation, retry, or intake-state-transition
  behavior.** Same `enrichDelivery` code path, same `isRetryable`
  classification, same idempotent `intake.create()`.

## What startup reports

On every start, the log carries exactly one of:

- `neutara integration enabled in MOCK mode (NEUTARA_API_BASE_URL is a
  loopback host — only a local mock/test double is reachable; real
  Neutara tickets will not be found)`, with a `mode: "mock"` field.
- `neutara integration enabled in REAL mode (NEUTARA_API_BASE_URL is a
  non-loopback host)`, with a `mode: "real"` field.
- `neutara integration disabled: NEUTARA_API_BASE_URL, NEUTARA_API_TOKEN
  not set; enrichment is disabled` (or naming whichever variable is
  missing) when neither is configured.

This is produced by `describeNeutaraStartup` (`src/config/env.ts`), a pure
function over `loadNeutaraConfig`'s result — directly unit-tested
(`src/config/env.test.ts`) to prove it never includes the token or the
base URL's value in any of the three cases, independent of the logger's
own redaction (`logging/logger.ts`'s `SECRET_KEY_PATTERN` would in fact
also catch a field literally named `baseUrl`, since it matches `url` —
but this function does not rely on that as its safety net; it simply never
puts the value in the report).

## Never logged, in either mode

- `NEUTARA_API_TOKEN`
- `NEUTARA_WEBHOOK_SECRET`
- Any `Authorization` header value
- Any MongoDB connection string's credential portion
- Any GitHub App private key

Enforced today by: `logging/logger.ts`'s redactor (field-name pattern +
value-shape pattern, including an `nta_...` token shape specifically),
`neutara/client.ts`'s own comment and tests (the token appears in exactly
one place — the outbound `Authorization` header — and never in a returned
error message), and the new `describeNeutaraStartup` tests above.

## Current limitations

- **No automatic mode switching.** Explicitly out of scope for this
  change — an operator edits `.env` and restarts. There is no runtime
  toggle, no auto-detection beyond the informational startup log.
- **No poller.** Neither mode changes the fact that intake is entirely
  webhook-driven (see `docs/repository-selection.md` and the CF-33337
  diagnosis) — switching to real mode alone does not make real Neutara
  tickets appear without a working webhook delivery path.
- **No tunnel or public exposure provided.** Making a local instance
  reachable by a real Neutara webhook is a separate, out-of-scope
  infrastructure decision (see ".env.example"'s note on
  `NEUTARA_API_BASE_URL`).
