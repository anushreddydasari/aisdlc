# GitHub App Stage 2 — Real Authentication

Extends [`docs/github-app-integration-design.md`](github-app-integration-design.md)
(the original, higher-level design) with the concrete decisions Stage 2
actually implements: real App-level JWT signing and real installation-token
exchange. Everything else that design doc describes — `resolveInstallation`,
`getRepositoryMetadata`, `getFileContents`, and any consumer that acts on a
repository — remains mock-only, exactly as Stage 1 left it. Stage 2's scope
is authentication, not repository access.

**No real GitHub App exists.** Every example value, key, and token below is
either a placeholder variable name or a synthetic, test-only artifact
generated fresh at test time — see §15.

## 1. GitHub App ID configuration

`GITHUB_APP_ID` (env var name only — see `.env.example` if this is ever
added there). Validated by `isValidAppId()` in
[`src/github-app/config.ts`](../src/github-app/config.ts): digits only, a
positive integer, mirroring `readPort`'s exact reasoning in
`src/config/env.ts` — `Number()` would accept `1e3` or `0x10`, so a digit-only
regex is required instead of numeric coercion.

`loadGitHubAppConfig(source)` follows the `loadNeutaraConfig`/`loadOpenAiConfig`
shape exactly: **absent is a valid, non-fatal state**
(`{ configured: false, reason }`), not a startup failure — nothing in this
service depends on GitHub App access existing, the same reason the
Requirements Agent runs its deterministic stub when `OPENAI_API_KEY` is unset.

## 2. GitHub App installation ID configuration

There is no global installation-id environment variable. An installation id
is **per repository**, stored in `repositoryRegistry.accessPolicy.installationId`
(a plain field on an existing document — see Stage 1's design doc §10). It is
validated by `isValidInstallationId()`, also in `config.ts`, and reused
as-is by `access.ts`'s `authorizeRepositoryAccess` (`extractInstallationId`
now delegates to this single shared validator instead of duplicating the
check — the only change made to `access.ts` in this phase).

## 3. Private-key storage and loading

`GITHUB_APP_PRIVATE_KEY` (env var name only) — the PEM-format RSA private
key, inline. `config.ts`'s `looksLikePemPrivateKey()` validates only the
**shape** (`-----BEGIN [RSA ]PRIVATE KEY-----` … `-----END [RSA ]PRIVATE
KEY-----`), the same "shape check only, not a proof it works" contract
`isMongoUri` already documents for Mongo connection strings. The key's
actual cryptographic validity is discovered the first time `jwt.ts` signs
with it — `config.ts` never parses or loads it as a real key, and never
logs it. A file-path variant (`GITHUB_APP_PRIVATE_KEY_PATH`) was considered
and deliberately deferred: it would add disk I/O to what is otherwise a
pure, `EnvSource`-only function, breaking symmetry with every other
`loadXConfig` in this codebase, for a deployment convenience nothing here
currently needs.

## 4. JWT generation and expiration

[`src/github-app/jwt.ts`](../src/github-app/jwt.ts)'s `signAppJwt()`. Pure
local cryptography — `node:crypto`'s `createSign('RSA-SHA256')`, no network,
no dependency added.

- `alg: 'RS256'`, `typ: 'JWT'`.
- `iss`: the App id.
- `iat`: now, minus a 60-second clock-drift buffer (`APP_JWT_CLOCK_DRIFT_SECONDS`) — GitHub's own guidance, so a signing host whose clock runs slightly ahead of GitHub's is never rejected as "issued in the future."
- `exp`: `iat + 600` seconds (`APP_JWT_TTL_SECONDS`) — GitHub's maximum.
- **A fresh JWT is minted on every call, never cached.** Signing is cheap and
  network-free, so there is no benefit to tracking a JWT's remaining
  validity that would offset the complexity of doing so — unlike an
  installation token (§6), which costs a real network round trip.

## 5. Installation-token generation

[`src/github-app/token-issuer.ts`](../src/github-app/token-issuer.ts)'s
`createTokenIssuer().getInstallationToken(installationId)`.

`POST {baseUrl}/app/installations/{installationId}/access_tokens`,
authenticated with a fresh JWT from §4. **The HTTP call goes through an
injectable `fetchFn`**, defaulting to the global `fetch` — the exact
`NeutaraClientOptions.fetchFn` pattern from `src/neutara/client.ts`. Every
test in `token-issuer.test.ts` injects a fake `fetchFn` and never reaches
`api.github.com`.

This module does **not** implement the full `GitHubAppClient` interface
from `client.ts` — no real `resolveInstallation`, `getRepositoryMetadata`,
or `getFileContents`. Those stay mock-only until a later stage composes
this authentication primitive with real implementations of them.

## 6. Token caching and expiration handling

An in-memory `Map<installationId, { token, expiresAt }>`, scoped to one
`TokenIssuer` instance (no cross-process or persisted cache — a restart
simply re-issues). A cached token is reused until it is within
`DEFAULT_REFRESH_MARGIN_MS` (5 minutes) of its (typically 1-hour) expiry,
then a fresh one is requested.

**Concurrent calls for the same installation id share one in-flight
request** (an `inFlight: Map<installationId, Promise<...>>`), rather than
each firing its own — otherwise a burst of calls for one installation would
spend GitHub's rate limit needlessly. Two different installation ids are
never blocked on each other.

## 7. Secure secret handling and redacted logging

Three layers, all now covering GitHub secrets specifically:

1. **Never pass a secret to the logger.** Every log call in `token-issuer.ts`
   passes only `{ installationId, timedOut, error }` — never the JWT
   (present only in the `Authorization` header, never logged) and never the
   issued token.
2. **`logging/logger.ts`'s existing key-name redaction** already blanks any
   field literally named like a secret (`token`, `apiKey`, `authorization`,
   etc.) — unchanged, and it already covers a stray
   `logger.info('...', { installationToken })`-shaped mistake.
3. **Extended value-shape redaction, added in this phase.** `SECRET_VALUE_PATTERNS`
   in `logger.ts` now also catches, anywhere inside a log message or field
   value: a GitHub token (`ghs_…`, `ghp_…`, `gho_…`, `github_pat_…`), a PEM
   private-key block, and a JWT (`eyJ....eyJ....signature` shape). This is
   defence in depth on top of (1) and (2), covering the case where a secret
   ends up embedded in free text (e.g. inside an error message) rather than
   its own field.

Tested directly: `token-issuer.test.ts`'s "secret-safe logging" suite
captures real log output across a full issuance-and-failure cycle and
asserts the JWT and the issued token never appear in it; `config.test.ts`
asserts a `loadGitHubAppConfig` failure reason never quotes the key or app
id value; `logger.test.ts` asserts the new patterns individually.

## 8. GitHub API version and request headers

Every request sends:

```
Authorization: Bearer <JWT>
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2022-11-28
User-Agent: aisdlc-service
```

`X-GitHub-Api-Version` is pinned to a specific, known-good REST API version
(GitHub's versioning scheme) rather than left to drift with GitHub's
default — the same reasoning as pinning any external API contract.
`User-Agent` is required by GitHub's API; a missing one is itself a request
GitHub can reject.

## 9. Rate-limit handling

`classifyRateLimit(status, headers, now)` in `token-issuer.ts`:

- **`429` is always a rate limit** — GitHub only ever sends 429 for rate
  limiting, so this is unconditional even when no `Retry-After` header is
  present to compute a delay from.
- **`403` is ambiguous** — GitHub also returns 403 for plain permission
  failures — so a 403 counts as a rate limit **only** when a rate-limit
  header actually says so (`Retry-After`, or `X-RateLimit-Remaining: 0`
  together with `X-RateLimit-Reset`). A 403 with neither falls through to
  `insufficient_permission` instead. (An earlier draft of this logic
  treated every 403 as a possible rate limit regardless of evidence;
  `token-issuer.test.ts`'s "maps 403 with no rate-limit headers to
  insufficient_permission" test caught the bug before this document was
  finalized — recorded here because it is exactly the kind of mistake this
  design section exists to prevent silently recurring.)
- `retryAfterMs` is computed from `Retry-After` (seconds) when present,
  else from `X-RateLimit-Reset` (epoch seconds) minus the current time, and
  is surfaced on the `GitHubAccessFailure` result for a caller's own
  backoff scheduling — this module does not retry on its own behalf.

## 10. Retryable and non-retryable errors

`GitHubAccessFailureKind` (in `client.ts`) gained one member this phase:
**`'malformed'`** — a response that is not the shape a caller requires
(non-JSON body, missing `token`/`expires_at`, an unexpected 2xx/3xx status).
Not retryable, mirroring `neutara/client.ts`'s own `'malformed'` reasoning
verbatim: retrying will not fix a response shape mismatch. `isRetryable()`'s
truth table is otherwise unchanged — only `rate_limited` and `transient`
are retryable — and `client.test.ts` asserts every kind is classified
exactly once.

| Condition | Kind | Retryable |
| --- | --- | --- |
| 404 | `installation_not_found` | no |
| 401 | `insufficient_permission` | no |
| 403, no rate-limit evidence | `insufficient_permission` | no |
| 403, rate-limit evidence present | `rate_limited` | yes |
| 429 | `rate_limited` | yes |
| 5xx | `transient` | yes |
| network error / timeout | `transient` | yes |
| non-JSON or malformed 201 body | `malformed` | no |
| unexpected 2xx/3xx status | `malformed` | no |

## 11. Repository and branch validation

**Unchanged by this phase.** Stage 1's `access.ts` already validates the
repository URL shape, branch allow-list, and live registry activeness
before any client call — see Stage 1's own design doc §5/§6. Stage 2 adds
no new repository- or branch-facing behavior, because it implements
authentication only; there is no real `getFileContents`/`getRepositoryMetadata`
call yet for a branch check to apply to.

## 12. Network timeout handling

`DEFAULT_REQUEST_TIMEOUT_MS = 10_000` (10 seconds), enforced with an
`AbortController` — the identical mechanism `neutara/client.ts` already
uses for its own HTTP call, down to the exact "distinguish an aborted
timeout from any other thrown error" `catch` block shape. An abort is
reported as `{ kind: 'transient', message: 'request timed out after
{timeoutMs}ms' }`, never silently swallowed and never conflated with a
permanent failure.

## 13. Audit events

**Not implemented in Stage 2.** Nothing in `token-issuer.ts` or `jwt.ts`
writes to `auditLog`. There is still no consumer (no run-execution worker)
that would give a `github-app.token-issued` audit entry a meaningful
`subjectId` to attach to — the original design doc's §13 proposal stands as
future work, unchanged, to be wired in once that consumer exists.

## 14. Credential rotation

**Not implemented; documented as a known limitation.** A GitHub App can
have multiple active private keys simultaneously (for rotation without
downtime), but this codebase currently loads exactly one key at process
start (`loadGitHubAppConfig`, read once) and has no mechanism to accept a
second key or to hot-reload a replaced one. Rotating the key today means
restarting the process with a new `GITHUB_APP_PRIVATE_KEY`. This is an
acceptable gap for Stage 2 (there is no running consumer to disrupt yet)
but should be revisited before this integration is depended on in
production: a future version of `loadGitHubAppConfig` could accept a list
of keys and try each until one signs successfully, without any change to
`jwt.ts`'s signing logic itself.

## 15. Local development and test strategy

**Two different kinds of "not real" are used deliberately, for different
reasons:**

- **Real cryptography, synthetic keys.** `jwt.test.ts` and
  `token-issuer.test.ts` generate a fresh RSA keypair with
  `crypto.generateKeyPairSync` at test-run time — never written to disk,
  never reused between runs, never associated with any real GitHub App.
  JWT *signing* is exercised for real (including a real signature
  *verification* against the matching public key in `jwt.test.ts`), because
  it is pure local logic worth actually proving correct — mocking it would
  test nothing.
- **Mocked network, real request-building logic.** `token-issuer.test.ts`
  injects a fake `fetchFn` that returns canned `Response` objects (using
  the real `Response`/`Headers` globals, so status/header parsing is
  exercised faithfully) and asserts on the URL and headers the real code
  actually sent. No test in this codebase, and no `npm test` run, ever
  reaches `api.github.com`.

**Real usage is opt-in and currently impossible to trigger by accident:**
`loadGitHubAppConfig` returns `configured: false` unless both
`GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` are set, and this repository's
`.env`/`.env.example` set neither. Nothing in `src/index.ts` constructs a
`TokenIssuer` yet — there is no wiring for a real key to accidentally flow
into, mirroring exactly how `OPENAI_API_KEY`'s absence keeps every existing
test and every default local run free of real LLM calls.

**Follow-up, not part of this stage:** a local mock GitHub HTTP server
(`src/scripts/mock-github.ts`, mirroring the existing `mock-neutara.ts`)
for manual end-to-end exercises, and the real `resolveInstallation`/
`getRepositoryMetadata`/`getFileContents` implementations — both already
scoped in the original design doc's staged plan (§15) and unaffected by
anything built in this stage.
