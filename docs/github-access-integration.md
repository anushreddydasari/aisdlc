# GitHub Access Integration

Connects an approved, confirmed AISDLC run to real repository content. This
is the service layer that sits between [`repository-selection`](repository-selection.md)
(which produces a human-confirmed repository mapping for a run) and
[`github-app`](github-app-integration-design.md) (which can authenticate to
GitHub and read a file, given an authorization decision) — `src/github-access/service.ts`
validates the run/intake/selection chain and orchestrates the two,
duplicating neither.

**Read-only.** Nothing in this phase writes to GitHub, creates a branch,
commits, or opens a pull request. That is the Coding Agent's job, and the
Coding Agent does not exist yet — see "Current limitations" below.

## The workflow

```
Approved Run
    ↓  runs.findById(runId) — must exist, status must be 'queued' or 'running'
Intake Item
    ↓  intake.findByIssueKey(run.issueKey), cross-checked against run.intakeItemId
    ↓  must be status: 'approved'
Repository Selection
    ↓  selections.findByRunId(runId) — must exist
    ↓  must be status: 'selected' with a non-null confirmedBy (decision D2: always human-confirmed)
Repository Registry (live re-check)
    ↓  authorizeRepositoryAccess() — registry entry must still be active,
    ↓  its accessPolicy.installationId must be valid, the confirmed branch
    ↓  must still be covered by the confirmed allowed branches
GitHub Access
    ↓  a short-lived installation token is issued
Repository Read
    ↓  getRepositoryMetadata() — confirms owner/repo identity, returns defaultBranch/visibility
    ↓  getFileContents() — once per requested path, at the confirmed branch
Access Result
    ↓  GitHubAccessResult — success with metadata + file contents, or a
    ↓  categorized, retry-annotated failure
NEXT PHASE: Coding Agent (not implemented)
```

Every step before "GitHub Access" is this service's own responsibility —
nothing this specific existed before this phase. Everything from "GitHub
Access" onward is a direct call into the already-built, already-tested
`github-app/access.ts` and `GitHubAppClient` — this service adds no new
GitHub-facing logic, only the validation that must happen before those are
trusted to run.

## Validation rules

| Check | Failure category | Reaches GitHub? |
| --- | --- | --- |
| Run exists | `run_not_found` | No |
| Run status is `queued` or `running` (not `cancelled`/`failed`/`succeeded`) | `run_not_ready` | No |
| A matching, consistent intake item exists (looked up by `issueKey`, cross-checked against `run.intakeItemId`) | `intake_item_not_found` | No |
| Intake item status is `approved` | `intake_not_approved` | No |
| A repository selection exists for this run | `selection_missing` | No |
| Selection status is `selected` with a non-null `confirmedBy` | `selection_not_confirmed` | No |
| The registry entry is currently `active` (re-checked live, not from the confirmation-time snapshot) | `repository_inactive` | No |
| The registry entry's `accessPolicy.installationId` is a valid installation id | `invalid_configuration` | No |
| The confirmed branch is still covered by the confirmed allowed branches | `branch_not_allowed` | No |
| The GitHub response actually describes the requested owner/repo (not a rename or a different repository) | `invalid_response` | Yes — the request was made; the response was rejected |

The first nine rows are enforced by `src/github-access/service.ts` and
`src/github-app/access.ts` (reused, not reimplemented) **before any network
call is made** — every one of them is covered by a test that also asserts
zero client calls occurred.

**The repository URL and branch are never taken from a ticket, a webhook
payload, or any other untrusted input.** They come exclusively from the
confirmed `repositorySelections` snapshot (`selectedRepositoryUrl`,
`selectedDefaultBranch`, `selectedAllowedBranches`) — see
`docs/repository-selection.md`'s "Registry management" for why that
snapshot exists at all (a later registry edit must not retroactively change
what an already-confirmed run acts on).

### Branch selection

This phase does not accept an explicit branch parameter — it uses the
confirmed selection's own `selectedDefaultBranch`. This is **not** a silent
invented fallback: `selectedDefaultBranch` is itself part of what a human
explicitly confirmed (the registry admin chose it, the confirmation locked
it in), and `authorizeRepositoryAccess` already refuses a null or
disallowed value outright (`branch_not_allowed`). A future caller that
needs to target a different, still-authorized branch (e.g. a `feature/*`
pattern match) can be added as an explicit parameter once the Coding Agent
defines that need — not guessed at now.

## Files read

`filePaths` is a plain parameter to `accessRepositoryForRun(runId,
filePaths)`, not a list this service invents. There is no Coding Agent yet
to define "the files an AISDLC run needs," so that decision belongs to
whatever future caller knows the answer.

## Error handling and retry behavior

`GitHubAccessFailureCategory` (in `service.ts`) is a superset of
`github-app/client.ts`'s `GitHubAccessFailureKind`, mapped 1:1 by
`mapGitHubFailureKind()` (an exhaustive `switch`, so TypeScript refuses to
compile if a new underlying kind is ever added without updating this
mapping) plus this service's own eight run/intake/selection validation
categories, which never originate from GitHub at all.

| Category | Retryable | Source |
| --- | --- | --- |
| `run_not_found`, `run_not_ready`, `intake_item_not_found`, `intake_not_approved`, `selection_missing`, `selection_not_confirmed`, `repository_inactive`, `invalid_configuration`, `branch_not_allowed` | No | This service's own validation |
| `authentication_failure` (401 — the credential itself was rejected) | No | GitHub |
| `authorization_failure` (403, no rate-limit evidence — valid credential, insufficient permission) | No | GitHub |
| `repository_not_found`, `branch_not_found`, `file_not_found` | No | GitHub |
| `invalid_response`, `unexpected_redirect` | No | GitHub |
| `rate_limited` | **Yes** (respect `retryAfterMs` when present) | GitHub |
| `timeout` | **Yes** | Request exceeded its timeout |
| `transient_github_error` | **Yes** | Network failure or 5xx |
| `unexpected_error` | No | A bug, not an expected outcome — see below |

`isRetryableCategory()` is the single source of truth for this table; a
test (`mapGitHubFailureKind / isRetryableCategory consistency`) asserts it
never disagrees with `github-app/client.ts`'s own `isRetryable()` for the
kinds they share.

**`authentication_failure` vs `authorization_failure` is a new distinction
added in this phase.** Previously, `github-app`'s real client mapped both
401 (bad credential) and non-rate-limited 403 (valid credential, missing
permission) to the same `insufficient_permission` kind. This phase splits
them — a 401 now produces `authentication_failed`, kept separate from 403's
`insufficient_permission` — because the two failures have completely
different operator fixes (rotate the App's key vs. grant it a permission),
and collapsing them made that indistinguishable from a `GitHubAccessResult`
alone. Likewise, `timeout` is now its own kind, separate from generic
`transient` (a network failure or 5xx), so "GitHub was slow" is
distinguishable from "GitHub was unreachable or errored" — both remain
retryable, but the distinction is useful for diagnosis and for a future
backoff strategy that might treat them differently.

**Never thrown.** Every failure — including a bug inside this service's own
code — is returned as a `GitHubAccessFailure`, never a thrown exception.
`accessRepositoryForRun` wraps its own execution in a `try/catch` and maps
any unexpected exception to `unexpected_error` (non-retryable, since a bug
retrying itself is not a safe default).

## Idempotency and "duplicate access"

No new persisted "access status" collection was added. `repositorySelections`
already has a unique index on `runId`, so a run can only ever have ONE
confirmed repository — which is what makes "the same run cannot create
multiple conflicting repository-access operations" true almost by
construction: two calls for the same run necessarily target the same
repository and branch, so they cannot conflict, only duplicate *work*.

Duplicate concurrent work is de-duplicated in-process: `createGitHubAccessService`
keeps an `inFlight: Map<runId, Promise<GitHubAccessResult>>`, the same
shape `token-issuer.ts` already uses for concurrent token requests. Two
overlapping calls for the same `runId` share one execution and resolve to
the identical result. A later, non-overlapping call runs fresh (this is a
read-only re-fetch, not a duplicate in any harmful sense).

A persisted "access already ran" collection was deliberately not added — it
would be a second, competing source of truth for run progress (explicitly
out of scope for this phase), and there is still no consumer (no Coding
Agent) whose actual needs would tell us what that state should even look
like.

## Audit events

All under the existing `AuditLog` mechanism (`db/audit-log.ts`), actor
`system:github-access`, `subjectType: 'run'`, `subjectId: runId` — so
`audit.query({ subjectId: runId })` returns a run's entire GitHub-access
history in one place.

| Action | When | Detail |
| --- | --- | --- |
| `github.access.started` | Always, first | `filePaths` |
| `github.repository.accessed` | After `authorizeRepositoryAccess` succeeds | `repositoryId`, `owner`, `repo`, `branch` |
| `github.files.accessed` | After every requested file is read successfully | `repositoryId`, `fileCount`, `paths` |
| `github.access.succeeded` | On overall success | `repositoryId`, `owner`, `repo`, `branch` |
| `github.access.failed` | On any failure, at the point it occurred | `category`, `retryable`, `intakeItemId` (when known), `repositoryId` (when known), `failedPath` (when a specific file failed) |

**Never logged or audited:** GitHub installation tokens, JWTs, private
keys, API secrets, `Authorization` header values, or file contents. File
*paths* are audited (they are already-authorized source locations, not
secret) — file *content* never appears in an audit `detail` object or a log
line, verified directly by tests.

## Security model (unchanged, reused)

Every existing control from `github-app/` and `repository-registry/` still
applies, untouched:

- GitHub App authentication (JWT + short-lived installation tokens, never a personal access token).
- HTTPS-only, registry-controlled repository URLs — never a ticket-supplied URL.
- Owner/repository identity verified against the GitHub response itself.
- 10-second request timeouts, enforced with `AbortController`.
- Redirects rejected (`redirect: 'error'`), never followed.
- Secret redaction in logs (tokens, JWTs, PEM keys — see `logging/logger.ts`).
- Human confirmation is mandatory and is never bypassed (`selection_not_confirmed` blocks access outright).
- One run maps to exactly one repository (`repositorySelections.runId` is unique; this service reads that single row, never chooses among candidates).

Nothing in this phase weakens any of the above. `src/github-access/service.ts`
adds validation on top of them; it does not relax anything `github-app/access.ts`
already enforces.

## Current limitations

- **Read-only.** No write, branch, commit, or pull-request capability exists anywhere in this codebase yet.
- **No orchestrator scheduler wired up yet.** `accessRepositoryForRun` is a callable entry point, the same shape `authorizeRepositoryAccess` already was. A background loop that calls it automatically (mirroring `orchestrator/scheduler.ts`) is reasonable future work, deliberately not built now: there is no Coding Agent yet to consume a `GitHubAccessResult`, so a scheduler built today would be scaffolding around a consumer that cannot yet specify what it needs (retry cadence, failure handling, result lifetime).
- **No `filePaths` policy.** This service does not decide which files matter for a given run — that is Coding Agent business logic that does not exist yet. Today, `filePaths` is supplied by the caller.
- **`authentication_failure`/`authorization_failure`/`timeout` classification is best-effort**, inheriting the same caveats already documented for `github-app`'s HTTP-status mapping (e.g. GitHub's 404-for-both-missing-path-and-missing-ref message-sniffing) — see `docs/github-app-stage2-authentication-design.md`.
