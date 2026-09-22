# GitHub App Integration — Design

**Status: design only. Nothing in this document is implemented.** No
`src/github-app/` module exists yet, no GitHub App has been created, and no
real GitHub credential has ever been used by this codebase. This document
describes how a future phase would build Git access on top of the
Repository Registry and Repository Selection system that already exists
(see [`docs/repository-selection.md`](repository-selection.md)), so that the
future Coding Agent can act on a confirmed repository selection without ever
touching a repository this system did not explicitly authorize.

## Why a GitHub App, not a personal token

A personal access token is one person's identity and inherits every
repository they can see. A GitHub App is installed by an org owner onto a
specific set of repositories, with a specific, minimal set of permissions,
and its tokens are scoped to exactly what the installation covers. That
scoping is what makes "the registry is the sole source of truth for which
repositories a run may touch" (decision, already enforced in
`repository-registry/repository.ts`) extend cleanly into actual Git access:
a GitHub App token literally cannot reach a repository the App was not
installed on, which is a second, independent enforcement of the same
boundary this system already has at the database layer.

## 1. GitHub App authentication

GitHub Apps authenticate in two layers, and only the second one ever touches
a specific repository:

1. **App-level JWT.** Signed with the App's private key (RS256), claims
   `iat`, `exp` (max 10 minutes out), and `iss` (the App ID). Proves "this
   caller is the App," not "this caller may act on repository X."
2. **Installation access token.** Exchanged for the JWT via
   `POST /app/installations/{installation_id}/access_tokens`. Short-lived
   (expires in 1 hour), scoped to the specific repositories and permissions
   the installation was granted. This is the token any Git operation
   actually uses.

Nothing in this system ever holds a long-lived GitHub credential beyond the
App's private key itself, which is a signing key, not a bearer credential —
possessing it lets you *mint* tokens, but every minted token is still scoped
and short-lived.

## 2. GitHub App installation and repository access

**Installing the App is an out-of-band, human action** — an org owner
installs it via the GitHub UI (or the App's public installation URL) onto
specific repositories or "all repositories" in an org. This system never
creates or installs a GitHub App itself; it only *consumes* an installation
that already exists.

Given a `repositoryUrl` (an `owner/repo` pair), resolving which installation
covers it uses `GET /repos/{owner}/{repo}/installation`, authenticated with
the App-level JWT. A 404 means the App is not installed on that repository —
see §8.

The installation ID is non-secret (it identifies a relationship, not a
credential) and is exactly the kind of value `repositoryRegistry.accessPolicy`
already exists to hold — see §10.

## 3. Secure installation-token generation

Proposed module: `src/github-app/token-issuer.ts`.

- Input: App ID, App private key (both from environment — see §9),
  installation ID (from the registry entry's `accessPolicy`, or resolved
  live via §2 if absent).
- Builds the JWT with `node:crypto`'s RS256 signing (no new dependency:
  `crypto.sign` covers this, the same way `signature.ts` already uses
  `node:crypto` for HMAC rather than pulling in a library).
- Exchanges it for an installation token, caches the token **in memory
  only**, keyed by installation ID, and proactively refreshes a few minutes
  before the 1-hour expiry (mirroring how a JWT library like `octokit/auth-app`
  does it) rather than waiting for a 401.
- **The token is never persisted.** Not to MongoDB, not to a log line, not
  to a file. It lives only in process memory for the lifetime of the Git
  operation that needed it. `src/logging/logger.ts`'s existing redaction
  convention (see `redactUri`) is extended with a matching redactor for
  anything that looks like a GitHub token shape, as defence in depth against
  an accidental `logger.info('...', { token })` mistake.
- The private key itself is loaded once at startup (same lifecycle as
  `OPENAI_API_KEY`) and never logged, never included in an audit entry
  detail, never returned from any API response.

## 4. Mapping an approved repository-registry record to a GitHub repository

This is where the two already-built systems meet. The chain, end to end:

```
Neutara ticket (spaceKey)
  → intakeItems.snapshot.project           (decision: spaceKey IS the project identifier)
  → repositorySelections.projectIdentifier  (copied at match time)
  → repositorySelections.status = 'selected' (ONLY after human confirmation — decision: always required)
  → repositorySelections.selectedRepositoryUrl / selectedDefaultBranch / selectedAllowedBranches
      (a SNAPSHOT, taken at confirmation time, per repository-selection.md)
  → github-app: owner/repo parsed from selectedRepositoryUrl
  → github-app: installation resolved (§2), token issued (§3)
```

A future run-execution worker (part of the Coding Agent, not yet designed)
would read exactly one `repositorySelections` document per run — decision:
one ticket/run maps to one repository, already enforced by the unique index
on `runId` and by `confirm()` refusing a second confirmation
(`SelectionConflictError`). There is never an ambiguity to resolve at this
layer; by the time this code runs, a human already resolved it.

**Never re-derive the repository from the live registry at this point.**
The whole reason `repositorySelections` snapshots `selectedRepositoryUrl`
etc. at confirmation time is so a later registry edit cannot silently change
what an in-flight or already-confirmed run acts on. GitHub access reads the
snapshot, not `repositoryRegistry`, for the URL/branch values — it only
reads the live registry entry for one thing: whether it is still `active`
(§8).

## 5. Registry-controlled repository URL validation

Already implemented and unchanged by this design:
`isValidGitHubRepositoryUrl` in `repository-registry/repository.ts` accepts
only `https://github.com/<org>/<repo>[.git]`. GitHub App integration adds no
new validation surface here — it re-parses the already-validated,
already-snapshotted `selectedRepositoryUrl` to extract `owner`/`repo` for
the GitHub API calls in §2 and §7. If that parse ever fails, that is a bug
(the value came from our own validator), not a data-quality problem to
handle gracefully — it should throw loudly, not fail open.

**Authorization is still "this URL came from a document in this system,"
never "this URL looks like a valid GitHub URL."** A well-formed
`https://github.com/attacker/repo` is not authorized just because it parses;
it is authorized only because it is the exact string a `repositorySelections`
document snapshotted from a `repositoryRegistry` entry a human confirmed.
Nothing in the GitHub App layer ever accepts a repository URL from a ticket,
a webhook payload, or any other untrusted input.

## 6. Default branch and allowed branch-pattern validation

Also already implemented: `isValidBranchName`, `isValidBranchPattern`,
`matchesAllowedBranch` in `repository-registry/repository.ts`, and decision
"fixed branch names and branch patterns are supported" is exactly what that
module's narrow grammar (exact name, or a single trailing `/*` wildcard)
already encodes.

**The rule for this phase:** before any Git operation touches a branch
(reading from it, creating it, pushing to it), call
`matchesAllowedBranch(branch, selection.selectedAllowedBranches)` — the
CONFIRMED snapshot's allowed branches, not a live re-read of the registry
entry, for the same "snapshot is authoritative" reason as §4. A branch that
fails this check is refused before any GitHub API call is made for it, the
same "refuse before doing unauthorized work" discipline `operator-auth.ts`
already applies to the HTTP layer (verify before reading the body).

`selectedDefaultBranch` is used as the base for any future Coding Agent
work unless a task explicitly names a different (still-`matchesAllowedBranch`)
branch.

## 7. Secure repository-file access

Two access patterns, both authenticated with the short-lived installation
token from §3, never a long-lived credential:

- **Read-only content inspection** (e.g. the future Coding Agent reading a
  file before deciding what to change): the Contents API
  (`GET /repos/{owner}/{repo}/contents/{path}`) or the Git Data API for bulk
  reads (tree/blob endpoints) — no full clone needed for inspection-only
  work.
- **Full working copy** (needed once the Coding Agent actually edits files):
  an authenticated HTTPS clone using
  `https://x-access-token:<installation-token>@github.com/{owner}/{repo}.git`.
  The token must never be written to `.git/config` on disk in a way that
  persists past the operation — use a short-lived credential helper or an
  in-memory-only remote URL, and scrub any temporary clone directory after
  use. This system already has a "scratch working directory" discipline
  precedent worth reusing verbatim (Claude Code's own scratchpad convention
  applies equally well here): clone into a per-run temporary directory,
  never a shared one, and delete it when the run ends regardless of outcome.

**Least privilege at the App level, not per call.** GitHub App permissions
(`contents: read`, `contents: write`, `pull_requests: write`, etc.) are
configured once, on the App itself, not negotiated per API call. This phase
should request **read-only `contents` access only**. Write access
(`contents: write`, `pull_requests: write`) is a deliberate, separate
upgrade made only when the Coding Agent's actual write path is designed —
not requested speculatively now. This mirrors decision D3 from the
Repository Registry phase: "do not implement actual GitHub App operations
this phase; do not store credentials or private keys" — this design
document is the plan for lifting that restriction later, not lifting it now.

## 8. Handling inactive, inaccessible, or unauthorized repositories

Three distinct failure shapes, each needing a different response:

| Condition | Detection | Response |
| --- | --- | --- |
| **Inactive** — the registry entry backing this selection was deactivated after confirmation | Re-check `repositoryRegistry.findById(...).status === 'active'` immediately before issuing a token — defense in depth on top of the snapshot, since a snapshot can otherwise go stale relative to a later admin action | Refuse the operation; do not issue a token. Audit + notify (reuses the `repository-selection.notification` pattern) |
| **Inaccessible** — the GitHub App is not installed on this repository | `GET /repos/{owner}/{repo}/installation` returns 404 | Not retryable by itself (an App installation does not appear on its own) — audit + notify an authorized person that the App needs installing, same "never guess, refuse safely" posture as decision D6 |
| **Unauthorized** — the App is installed but lacks a needed permission (e.g. only `contents: read` when a write was attempted) | GitHub returns 403 with a permission-specific message | Not retryable — this is a configuration problem, not a transient one. Audit + notify, distinct message from the 404 case so the fix (install vs. re-permission) is obvious from the audit entry alone |

None of these three should ever silently retry forever the way a *transient*
failure does (§12) — retrying a permission problem wastes GitHub API rate
limit and delays the human action that actually fixes it.

## 9. Environment variables and secret management

Following the exact `.env.example` conventions already established
(`OPENAI_API_KEY`'s "optional, absent is a valid state" pattern is the
closest precedent):

```
# ── GitHub App integration (future phase) ────────────────────────────────
# The GitHub App's numeric App ID, from the App's settings page.
GITHUB_APP_ID=

# The App's PEM-format private key. Optional path form is also acceptable
# (GITHUB_APP_PRIVATE_KEY_PATH) for deployments that prefer a mounted file
# over an inline env var — never both, and never checked into source control
# either way. Absent means the GitHub App integration is disabled: nothing
# in the pipeline blocks on it, the same way an absent OPENAI_API_KEY falls
# back to the deterministic stub rather than refusing to start.
GITHUB_APP_PRIVATE_KEY=
GITHUB_APP_PRIVATE_KEY_PATH=

# Optional. Only needed if the App also receives GitHub webhooks (e.g.
# installation/uninstallation events) — out of scope for the read-only
# Contents-API-only shape this design proposes first.
GITHUB_APP_WEBHOOK_SECRET=
```

Secrets never appear in: `repositoryRegistry.accessPolicy` (schema-enforced
by convention today, worth eventually enforcing with a stricter validator
once the concrete shape is known — see §10), audit log `detail` objects, or
any log line (extend `redactUri`-style redaction to cover a private-key or
token shape, and add an offline test asserting it, mirroring the existing
`redactUri` tests).

## 10. Required MongoDB changes, if any

**Minimal — mostly none.** `repositoryRegistry.accessPolicy` already exists
in the schema (`{ bsonType: ['object', 'null'] }`) specifically as a
placeholder for "non-secret GitHub App metadata (e.g. an installation id)" —
see the validator's own comment in `src/db/collections.ts`. The concrete
shape this phase would give it:

```ts
interface GitHubAppAccessPolicy {
  readonly installationId: number;
  /** Denormalized for convenience/debugging; re-derivable via §2 if absent or stale. */
  readonly owner?: string;
  readonly repo?: string;
}
```

No new required field on `repositorySelections` — `selectedAccessPolicy`
already exists (added in this phase, currently always `null` in practice)
and would simply start being populated with the same shape at confirmation
time, as the snapshot pattern already requires.

**Optional future addition, not required for correctness:** a small
`githubAppInstallations` cache collection (`{ owner, repo, installationId,
resolvedAt }`) if the live `GET /repos/{owner}/{repo}/installation` lookup
turns out to be a meaningful latency or rate-limit cost once this runs at
volume. Deferred deliberately — "smallest compatible design" argues against
adding a cache before there's evidence it's needed, and `accessPolicy`
already avoids the lookup entirely once an admin fills in `installationId`
by hand at registry-creation time.

**No change to `AUDIT_SUBJECT_TYPES` is strictly required** — audit entries
for GitHub access events can use `subjectType: 'repositorySelection'` with
`subjectId` set to the selection's `_id`, consistent with how
`repository-selection.confirmed` already works. A dedicated `'githubAccess'`
subject type is a reasonable alternative if these events end up wanting
their own query surface; either is compatible with this design.

## 11. Proposed service modules and APIs

```
src/github-app/
  client.ts          — GitHubAppClient interface + real (Octokit-free, fetch-based) implementation
  mock-client.ts      — in-memory MockGitHubAppClient for unit tests (see §14–15)
  token-issuer.ts     — JWT construction + installation-token exchange + in-memory cache
  errors.ts           — error classes: InstallationNotFoundError, InsufficientPermissionError,
                         GitHubRateLimitedError, GitHubTransientError
```

`GitHubAppClient` interface (illustrative, not final):

```ts
interface GitHubAppClient {
  resolveInstallation(owner: string, repo: string): Promise<{ installationId: number } | null>;
  getInstallationToken(installationId: number): Promise<{ token: string; expiresAt: Date }>;
  getFileContents(installationId: number, owner: string, repo: string, path: string, ref: string): Promise<string>;
}
```

This mirrors the existing pattern throughout the codebase: an interface
(`RepositoryRegistryRepository`, `RunsRepository`, `AuditLog`) with one real
implementation and one test/mock implementation, never a concrete class
imported directly by callers.

**No new inbound HTTP endpoints are required for this phase.** GitHub App
access is an outbound integration consumed by a future run-execution worker,
not something an operator calls directly. If an admin-facing "verify this
mapping is reachable" convenience is wanted later, it would be
`POST /repository-registry/:id/verify-access` (operator-token-gated, same as
every other registry endpoint), but that is a nice-to-have, not a
requirement of this design.

**Boundary discipline, matching the rest of the codebase:** `repository-registry/`
and `repository-selection/` never import `github-app/`. The dependency runs
one direction only — a future run-execution worker depends on both
`repository-selection/` (to read a confirmed selection) and `github-app/`
(to act on it) — the same "read-only boundary" `orchestrator/worker.ts`
already keeps against `IntakeRepository`.

## 12. Error handling and retry behavior

| Failure | Retryable? | Behavior |
| --- | --- | --- |
| Network error / 5xx from GitHub | Yes | Exponential backoff, same `backoffMs` shape already used in `enrichment/worker.ts` and `repository-selection/worker.ts` (1 min base, doubling, capped at 1 hour) |
| Rate limited (403 with `X-RateLimit-Remaining: 0`, or secondary rate limit 429) | Yes, but respect `Retry-After` / `X-RateLimit-Reset` exactly rather than the generic backoff — retrying before the window resets just spends another call finding that out | |
| Installation not found (404) | No | Terminal for this attempt; audit + notify (§8) |
| Insufficient permission (403, not rate-limit) | No | Terminal for this attempt; audit + notify (§8), distinct message from 404 |
| Token expired mid-operation (401) | Once, reactively | Refresh the token a single time and retry the one call; if it still 401s, treat as insufficient permission, not as a transient error — repeated 401s after a fresh token means something is actually wrong |
| Registry entry deactivated since confirmation (§8) | No | Terminal; audit + notify. This is a correctness check, not a GitHub API error at all |

This table is a direct extension of decision D6's "never guess, retry
automatically only for genuinely transient conditions, notify a human for
everything else" — already the exact posture `repository-selection/worker.ts`
takes toward `failed`/`ambiguous` selections.

## 13. Audit events

New actions, using the existing `AuditLog.append()` mechanism — no new
infrastructure, consistent with how `repository-registry.*` and
`repository-selection.*` events already work:

- `github-app.token-issued` — detail: `{ installationId, repositoryId, expiresAt }`. **Never** the token value itself.
- `github-app.access-denied` — detail: `{ repositoryId, reason: 'installation_not_found' | 'insufficient_permission' }`.
- `github-app.repository-inactive` — detail: `{ repositoryId }` — the §8 "deactivated since confirmation" case.
- `github-app.file-read` — optional, only if per-file audit granularity is wanted; likely too fine-grained for this phase and better left as ordinary application logging (`logger.info`) rather than an audit entry, since audit entries are for state changes and authorization decisions, not routine reads.

## 14. Unit, integration, and security tests

**Unit (offline, `MockGitHubAppClient`, no network):**
- JWT claim construction (`iss`, `iat`, `exp` within the 10-minute ceiling).
- Token cache: reuses a cached token until near expiry, refreshes exactly once when stale, never issues two concurrent refreshes for the same installation (a lock/in-flight-promise guard, the same shape `requirements/repository.ts` already uses for its own single-writer guarantees).
- `matchesAllowedBranch` re-validation at token-issuance time (already unit-tested at the registry layer; this phase adds a test proving the GitHub-access path calls it again against the *snapshot*, not the live registry).
- Error classification: each GitHub error shape (404, 403 rate-limited, 403 permission, 401, 5xx) maps to exactly one of the categories in §12's table.
- Inactive-registry-entry-since-confirmation is detected and blocks token issuance.

**Integration (against a local mock GitHub server, still no real network):**
Following the exact precedent already established by
`src/scripts/mock-neutara.ts` (built for the Requirements Agent phase's
"safe local testing tools"), propose `src/scripts/mock-github.ts`: a local
HTTP server implementing just the endpoints this design needs
(`POST /app/installations/{id}/access_tokens`, `GET /repos/{owner}/{repo}/installation`,
`GET /repos/{owner}/{repo}/contents/{path}`), with deterministic, configurable
responses (including deliberately returning 404/403/429 to exercise §12's
table). The real `GitHubAppClient` implementation is pointed at this mock
via its base-URL configuration, so the SAME code path used against real
GitHub in production is what integration tests exercise — nothing GitHub-App-specific
is mocked at the `github-app/` module boundary itself, only at the HTTP
transport underneath it. This is a stronger guarantee than only testing
`MockGitHubAppClient`, the same reason `intake/repository.integration.test.ts`
exists in addition to `intake/repository.test.ts`.

**Security tests:**
- The private key never appears in any log line produced during a full
  token-issuance-and-use cycle (grep the captured log output, the same
  technique `server.test.ts`'s "does not leak the error message to the
  client" test already uses).
- An installation token never appears in an audit log `detail` object.
- A URL or branch that fails §5/§6 validation never reaches a GitHub API
  call at all (assert the mock server receives zero requests for a rejected
  input).
- An attempt to access a `repositoryRegistry` entry with `status: 'inactive'`
  is refused even when a stale, still-valid-looking `repositorySelections`
  snapshot exists for it.

## 15. Staged implementation plan, mocked first

1. **Interfaces and business logic only.** Write `GitHubAppClient`, the
   error classes, the retry/classification table from §12, and
   `matchesAllowedBranch`-at-token-time re-validation, all tested against
   `MockGitHubAppClient` — zero network code yet. This stage delivers
   everything that is pure logic and needs no real GitHub App to validate.
2. **Local mock GitHub server.** Build `src/scripts/mock-github.ts`
   (mirrors `mock-neutara.ts`) and point a real HTTP-based
   `GitHubAppClient` implementation at it via configuration. This proves the
   actual request/response shapes (JWT header, token exchange body, Contents
   API response parsing) without any real GitHub App existing.
3. **Real implementation, gated behind explicit configuration.** The real
   `GitHubAppClient` is wired into `src/index.ts` exactly like `neutara`/`openai`
   are today: absent `GITHUB_APP_ID`/`GITHUB_APP_PRIVATE_KEY` means the
   integration is not started, not that the service refuses to boot. A real
   GitHub App is created and installed on a **throwaway test repository**
   (never a real product repository) only when a human deliberately does so
   outside of any automated test, and only after stages 1–2 are fully green.
4. **Wire into the future run-execution worker.** Out of scope for this
   document — that worker does not exist yet, and its design (how it claims
   a `queued` run, how it reports progress, how it writes results back) is
   its own future design task. This stage only needs `github-app/` to
   already expose the interface from §11 for that worker to depend on.

At every stage prior to a human deliberately configuring real credentials,
this system makes zero real network calls to `api.github.com` — the same
"safe by default, real access is an explicit opt-in" posture the Neutara and
OpenAI integrations already established.

## Summary of what this design deliberately does not do yet

- Does not create or install a GitHub App.
- Does not add `src/github-app/` code — this is a design document only.
- Does not request write permissions (`contents: write`, `pull_requests: write`)
  — read-only `contents: read` is the entire scope of what this phase's App
  configuration would request.
- Does not change how `repositoryRegistry`/`repositorySelections` matching
  or confirmation work — it only consumes their already-confirmed output.
- Does not widen the operator-token authorization model — "registry
  administrators and authorized team members manage mappings" remains the
  same known limitation already documented in `docs/repository-selection.md`
  (a single shared bearer token, no per-person roles) until that is
  separately revisited.
