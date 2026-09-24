# Human Review → Approved Change Execution

**IMPORTANT SAFETY RULE.** The Coding Agent must never automatically
approve its own changes. Nothing in this codebase moves a review out of
`pending` except an explicit call to `ChangeReviewRepository.approve()` by
a human operator — opening a proposal, reading it, running the Coding
Agent, or queueing a run are never interpreted as approval. If approval is
missing, rejected, expired, or the proposal has been superseded by a newer
one, execution refuses and returns a structured failure; it never applies
changes "just in case."

**Approved changes are currently applied and validated locally.**
**GitHub branch/commit/PR operations are not implemented in this phase.**
There is no `git clone` anywhere in this codebase — "local working copy"
means a disposable temp directory this module creates, writes into, and
removes; the real repository is never touched.

## Architecture

```
Coding Agent (plan + proposed changes)
    ↓  ChangeReviewRepository.createIfAbsent — one immutable row per
    ↓  distinct proposal, keyed by a deterministic proposalHash
Human Review
    ↓  ChangeReviewRepository.approve / .reject — explicit only
Approved Change Execution
    ↓  execution-service.ts — see "Two phases" below
ExecutionResult
```

Module boundaries, and why each exists:

| Module | Owns | Never does |
| --- | --- | --- |
| `types.ts` | Every result model and the failure taxonomy | Any logic |
| `proposal-hash.ts` | Deterministic hashing of (plan, proposedChanges) | Know about MongoDB or GitHub |
| `review-repository.ts` | `changeReviews` — the Human Approval API/Service: retrieve, approve, reject | Apply anything, talk to GitHub |
| `execution-repository.ts` | `changeExecutions` — the durable idempotency record | Decide *whether* to execute — only records the outcome |
| `local-apply.ts` | Path-safety + stale-hash pre-flight, writing a temp-directory working copy | Talk to GitHub, MongoDB, or decide eligibility |
| `validation.ts` | The `ChangeValidationRunner` interface + a deterministic mock | Run a real command this phase (see "Current limitations") |
| `execution-service.ts` | Orchestrates all of the above; the only public entry point | Write to GitHub, approve anything, or bypass any check |

## Two phases, and why the split matters

Execution is split into two phases, which is what makes idempotency
(Section 10) and concurrency (Section 11) both correct and cheap:

1. **Eligibility** (unpersisted, freely re-checkable): review lookup,
   approval/expiry/supersession checks, and a **live** repository/branch
   identity re-verification via `GitHubAccessService`. Nothing here has a
   side effect, so a failure here is recomputed fresh on every call — a
   transient `repository_access_failure` today may legitimately succeed on
   a later call, and there is no stale "attempt" record to clean up.
2. **Attempt** (persisted via `ChangeExecutionRepository`, idempotent on
   `reviewId`): reading live content for every `modify` target, applying
   to a local working copy, and validating. Once execution reaches this
   phase, **every** outcome — success or a failure of any kind — is
   recorded exactly once. A second call for the same review, at any later
   point, finds the recorded row and returns it without re-reading files,
   re-applying anything, or re-running validation.

## Human review model

```ts
type ChangeReviewStatus = 'pending' | 'approved' | 'rejected';

interface ChangeReviewDocument {
  runId: ObjectId;
  intakeItemId: ObjectId;
  repositoryId: string;
  owner: string;
  repo: string;
  branch: string;
  plan: ImplementationPlan;         // owned by coding-agent/types.ts
  proposedChanges: ProposedChange[]; // owned by coding-agent/types.ts
  proposalHash: string;             // see "Proposal integrity" below
  status: ChangeReviewStatus;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  reviewComment: string | null;
  createdAt: Date;
  updatedAt: Date;
}
```

**No `expired` status.** An approval's validity is time-computed at
execution time (`reviewedAt` vs. the clock), not a state anything
transitions into — the same "don't add a status the architecture doesn't
need" discipline `repositoryRegistry` already applies.

**Immutable rows.** A `changeReviews` document is never rewritten with new
plan/proposedChanges content. `createIfAbsent` is idempotent on
`proposalHash` (see "Proposal integrity"), so a regenerated proposal for
the same run is always a *new* row. This is what makes an approval
meaningful: approving row X can never later be reinterpreted as approving
different content, because X's content cannot change.

**Approval requires an operator.** `approve()` and `reject()` both refuse
any `actor` that does not carry the `operator:` prefix
(`OPERATOR_PRINCIPAL_PREFIX`), throwing `ReviewDecisionRequiresOperatorError`
— the exact rule and reasoning `intake/repository.ts`'s
`transition(..., 'approved', ...)` already established. This is what makes
the safety rule at the top of this document true by construction: there is
no code path by which `system:coding-agent` (or any other service
identity) can move a review to `approved`.

**Rejection preserves the row.** A rejected review is never deleted — it
stays queryable for audit/history, and a future workflow may generate a
new proposal for the same run if required. This phase does not
automatically retry the Coding Agent after a rejection.

## Proposal integrity

`proposal-hash.ts`'s `computeProposalHash(plan, proposedChanges)` uses
`intake/hash.ts`'s `contentHash` — canonicalized, order-independent object
hashing — the same tool `intake/repository.ts`'s `hashSnapshot` uses, and
a deliberately different one than `coding-agent/changes.ts`'s
`hashFileContent` (plain sha256, built for a single file's raw text, not a
structured plan/changes pair).

`changeReviews.proposalHash` is uniquely indexed
(`proposalHash_unique`), which is the whole mechanism: identical proposal
content always maps to the same row (idempotent creation); different
content always creates a new row. **"The approval applies to exactly the
proposal that will be executed" holds structurally** — execution always
reads `review.proposedChanges` directly from the approved row; there is no
separate "proposal" input at execution time to compare against or drift
from.

**A superseded approval never authorizes execution.** If the Coding Agent
re-runs and produces a new proposal for the same run, that is a new
`changeReviews` row with a later `createdAt`. Execution checks
`ChangeReviewRepository.findLatestByRunId` and refuses
(`review_superseded`) if the review being executed is not that latest row
— even if it is validly `approved`. This is the concrete mechanism behind
"if the proposal changes after approval, invalidate the approval, do not
execute" — there is no separate invalidation step because the check is
always live, not a flag set at proposal-creation time.

## Stale-file detection (the concurrency scenario)

The scenario this phase is built to catch: *Coding Agent reads file A →
human approves → someone changes file A → AISDLC attempts execution.*

Immediately before applying, `execution-service.ts` re-reads every
`modify` target's **live** content via `GitHubAccessService` — never
trusting whatever content the Coding Agent originally saw. `local-apply.ts`
then compares `hashFileContent(liveContent)` against the approved
`ProposedChange.originalContentHash`. A mismatch — or the file being
unreadable at all (`file_not_found`) — refuses the entire execution
(`stale_file`) rather than silently overwriting a newer change.

**Known limitation:** this re-verification only covers `modify` targets.
A `create` target that has since come to exist at the same path (a
different kind of concurrent collision) is not detected in this phase —
see "Current limitations".

## Applying locally

`local-apply.ts` writes into a fresh `mkdtemp` temp directory, never the
real repository. **Atomicity:** every proposed change is validated (path
safety, then stale-hash check for `modify`) *before any file is written*,
so a rejected proposal never leaves a partially-written working copy. If a
write itself fails partway through, the entire temp directory is removed
before returning failure.

**Path safety is re-checked here**, not merely trusted from when the
Coding Agent originally validated it — `coding-agent/path-safety.ts` is
reused directly (not reimplemented), the same rejects-absolute-paths,
`../`-traversal, credential/secret files, and CI/CD configuration that
`docs/coding-agent.md` documents.

The working directory is always removed once validation has run —
success or failure, it is disposable staging, never a persistent artifact.

## Validation — mock only, this phase

`ChangeValidationRunner` is a pluggable interface;
`createMockChangeValidationRunner` is its only implementation right now,
deterministic and offline. This mirrors the pattern this codebase has
already used repeatedly (`GitHubAppClient`'s mock-then-real staging across
its three phases; `CodingAgentProvider`'s mock alongside its real
OpenAI-backed implementation). A real implementation would mean shelling
out to run arbitrary `npm test` / `tsc` / `npm run build` commands against
LLM-modified, externally-sourced code — a materially different,
security-critical capability (arbitrary command execution) that deserves
its own careful phase, the same way GitHub write operations are explicitly
deferred rather than bolted onto this one.

"Do not automatically declare success if any required validation fails":
`isValidationSuccessful` requires **all three** of tests, typecheck, and
build to pass. A validation failure is recorded as a **failed** execution
even though every file was successfully applied to the working copy — the
applied-file list is still reported, for visibility into what would have
shipped.

## Idempotency (Section 10)

`ChangeExecutionRepository.createIfAbsent` is idempotent on `reviewId`: an
approved review may be executed at most once, ever. A second attempt —
retry, duplicate request, or a race lost against a concurrent caller —
finds the existing row via the unique index (`reviewId_unique`) and
returns it rather than re-applying anything. `execution-service.ts` also
checks `findByReviewId` as a fast path before doing any of the eligibility
work, so a duplicate call for an already-executed review makes zero
`GitHubAccessService` calls and never re-runs validation.

No second, competing run-identity system was introduced — this is the
same `createIfAbsent`-on-a-unique-index shape `runs.intakeItemId_unique`
and `requirementsAnalyses.intakeItemId_unique` already use.

## Concurrency (Section 11)

Concurrent calls to `executeApprovedChanges` for the **same** `(runId,
reviewId)` pair are de-duplicated in-process — the same `inFlight: Map`
shape `token-issuer.ts`, `github-access/service.ts`, and
`coding-agent/service.ts` all already use. Two overlapping calls share one
execution and resolve to the identical result.

## Rejection flow (Section 12)

A rejected review never reaches execution — `execute()` returns
`review_not_approved` immediately, before any `GitHubAccessService` call
and before any `changeExecutions` row is written. The row itself is
preserved (not deleted), so its audit history remains queryable, and a
future workflow may generate a new Coding Agent proposal for the same run
if required. This phase does not automatically retry the Coding Agent
after a rejection.

## Audit events

All under the existing `AuditLog` (`db/audit-log.ts`).

| Action | Actor | Subject | When |
| --- | --- | --- | --- |
| `change-review.created` | `system:change-review` | `changeReview` | A new, distinct proposal is submitted for review |
| `change-review.approved` | the operator | `changeReview` | An operator explicitly approves |
| `change-review.rejected` | the operator | `changeReview` | An operator explicitly rejects |
| `change-execution.started` | `system:change-execution` | `changeReview` | Eligibility passed; the attempt phase begins |
| `change-validation.started` | `system:change-execution` | `changeReview` | The local working copy was applied; validation begins |
| `change-validation.completed` | `system:change-execution` | `changeReview` | Every validation step passed |
| `change-validation.failed` | `system:change-execution` | `changeReview` | At least one validation step failed |
| `change-execution.completed` | `system:change-execution` | `changeExecution` | The attempt succeeded — recorded by `execution-repository.ts` |
| `change-execution.failed` | `system:change-execution` | `run` or `changeExecution` | Any failure — an *eligibility* refusal is recorded against `run` (nothing was attempted, nothing persisted); an *attempt* failure is recorded against `changeExecution` by `execution-repository.ts` |

**Never logged or audited:** GitHub tokens, JWTs, private keys, API keys,
`Authorization` headers, or file contents — proposed or original. Safe
file *paths* and *hashes* may be recorded; a dedicated test asserts no
audit `detail` ever contains proposed or live file content.

## Error handling and retry behavior

`ExecutionFailureCategory` (`types.ts`):

| Category | Phase | Retryable |
| --- | --- | --- |
| `review_not_found` | Eligibility | No |
| `review_not_approved` | Eligibility (pending or rejected) | No |
| `approval_expired` | Eligibility (time-computed) | No |
| `review_superseded` | Eligibility (a newer proposal exists) | No |
| `repository_access_failure` | Eligibility or attempt | Passed through from the underlying `GitHubAccessFailure.retryable` |
| `repository_mismatch` | Eligibility | No |
| `branch_mismatch` | Eligibility | No |
| `stale_file` | Attempt | No — a new review/proposal is required, not a bare retry |
| `invalid_path` | Attempt | No |
| `unauthorized_file` | Attempt | No |
| `apply_failed` | Attempt | No |
| `validation_failed` | Attempt | No |
| `unexpected_error` | Either | No |

**Never thrown out of `execution-service.ts`.**
`ChangeExecutionService.executeApprovedChanges()` wraps its own execution
in a `try/catch`; any unexpected exception maps to `unexpected_error`.

## Security model (unchanged, reused)

Every existing control from `github-access/`, `github-app/`, and
`coding-agent/` still applies, untouched:

- **Read-only toward GitHub.** `GitHubAccessService`'s interface has
  exactly one method, `accessRepositoryForRun`, which is read-only — a
  write cannot happen because there is nothing to call.
- Repository/branch identity is re-verified **live** immediately before
  every execution attempt, never trusted from the review's
  confirmation-time snapshot.
- Path/file safety (`coding-agent/path-safety.ts`, reused not
  reimplemented) rejects traversal, absolute paths, credential/secret
  files, and CI/CD configuration before a byte is written.
- Only the changes present in the approved review are ever applied — there
  is no code path by which an externally-supplied file list reaches
  `local-apply.ts`.
- No secrets in logs or audit details — enforced by a dedicated test.

## Current limitations

- **No GitHub write operations anywhere in this codebase.** No branch
  creation, commit, push, or pull request — that is explicitly the
  **next** phase:
  ```
  Approved Local Changes
      ↓
  Create GitHub Branch
      ↓
  Apply Changes to Git Repository
      ↓
  Commit → Push → Create Pull Request
      ↓
  Human PR Review → Merge
  ```
- **Validation is mock-only.** No real `npm test` / `tsc` / `npm run
  build` execution against applied changes exists yet — see "Validation"
  above.
- **Stale-file detection covers `modify` targets only.** A `create`
  target that has since come to exist at the same live path is not
  detected as a conflict in this phase.
- **No HTTP API layer.** `ChangeReviewRepository` and
  `ChangeExecutionService` are callable entry points, the same shape
  `coding-agent/service.ts` and `github-access/service.ts` already are —
  no HTTP handlers wire them up yet, consistent with those two phases also
  shipping service-layer only.
- **Not wired to a scheduler.** `executeApprovedChanges` is invoked
  explicitly by a caller that already has a `reviewId` in hand; no
  background loop calls it automatically.
