# End-to-End Orchestration

Connects every previously-built AISDLC component into one controlled
pipeline, reusing the existing scheduler/worker/HTTP conventions rather
than introducing new ones. **Pull request merge and deployment are
intentionally outside the automated workflow.**

## The complete lifecycle

```
Ticket
  ↓  webhook -> enrichment -> intake.create()
Requirements
  ↓  requirements/queue.ts: runs the Requirements Agent for every `received`
  ↓  intake item, then advances it to `pending_approval`
Human Approval                                              ← GATE 1
  ↓  POST /intake/:issueKey/approve
Repository Selection
  ↓  orchestrator queues a run; repository-selection worker matches
  ↓  candidates against repositoryRegistry
Human Confirmation                                           ← GATE 2
  ↓  POST /repository-selections/:runId/confirm
GitHub Access
  ↓  authorizeRepositoryAccess (reused, unchanged)
Coding Agent
  ↓  POST /runs/:runId/coding-agent — operator-supplied candidateFilePaths;
  ↓  see "Why the Coding Agent is not auto-polled" below
Human Change Review                                          ← GATE 3
  ↓  POST /change-reviews/:reviewId/approve
Local Execution
  ↓  pipeline/change-execution-queue.ts: every approved review with no
  ↓  execution yet is executed
Validation
  ↓  (mock only — see docs/change-execution.md's "Current limitations")
GitHub Branch → Commit → Push
  ↓  pipeline/github-publish-queue.ts: every succeeded execution with no
  ↓  publication yet is published
Pull Request
  ↓
Human Merge                                                  ← GATE 4
  ↓  no automation reaches this point — see "Human gates" below
(future) Deployment / Post-Deployment Validation
```

Everything from "Requirements" through "Pull Request" runs automatically,
one stage at a time, always stopping cleanly at a human gate. Nothing
skips a gate; nothing guesses at a decision only a human can make.

## Where existing orchestration stopped (before this phase)

Before this phase, exactly two loops ran automatically: the orchestrator
(queues a run per approved intake item) and the repository-selection
worker (matches candidates). Everything else — the Requirements Agent,
Coding Agent, change execution, and GitHub publish — existed as
fully-built, fully-tested services with **no scheduler, no HTTP route, and
no caller at all** outside their own test suites and one manual CLI script
(`npm run requirements:run`). This phase's whole job is closing that gap
— see each new module's header comment for the specific gap it closes.

## The run state machine

`runs.status` (`queued`/`running`/`succeeded`/`failed`/`cancelled`) is
**unchanged** — five values, all of which already existed. This phase
deliberately does **not** grow it into a thirteen-value pipeline enum. The
detailed stage a run is in — `repository_selection`, `change_review`,
`executing`, `awaiting_human_merge`, and so on — is **derived**, not
stored, by `pipeline/run-status.ts`'s `computeRunStatus()`:

```ts
type RunStage =
  | 'queued' | 'repository_selection' | 'repository_selection_failed'
  | 'repository_confirmed' | 'change_review' | 'change_rejected'
  | 'executing' | 'execution_failed' | 'publishing' | 'publish_failed'
  | 'awaiting_human_merge' | 'failed' | 'cancelled';
```

**Why derived, not stored.** Every stage this function reports is already
the responsibility of an existing collection's own status field
(`repositorySelections.status`, `changeReviews.status`,
`changeExecutions.status`, `githubPublications.status`). Storing a second,
redundant "pipeline stage" on `runs` would create exactly the second,
competing source of truth this codebase has refused to introduce at every
previous phase — see `github-access/service.ts`'s and
`change-execution/execution-service.ts`'s own module comments on this
same point, now applied one more time at the whole-pipeline scale.
`computeRunStatus` is a pure, side-effect-free view over rows the pipeline
already maintains; `GET /runs/:runId` is the only thing that computes it.

Earlier stages (`received`, `pending_approval`) describe the **intake
item**, not a run — a run does not exist yet at that point — and are read
directly off `IntakeItemDocument.status`, no derivation needed.

## Human gates

The orchestrator — and every queue worker in `pipeline/` — **never**
crosses a human gate automatically. Each gate is enforced at the point
closest to the data, not by convention:

| Gate | Enforced by | A service identity crossing it is |
| --- | --- | --- |
| 1. Requirements approval | `intake/state.ts`'s transition graph (`pending_approval → approved` requires `approvedBy` to carry the `operator:` prefix — `APPROVAL_REQUIRES_OPERATOR_CLAUSE`, enforced by the database itself) | A compile error / a thrown `ApprovalRequiresOperatorError` |
| 2. Repository confirmation | `repository-selection/repository.ts`'s `confirm()` — only reachable via `POST /repository-selections/:runId/confirm` | No queue worker ever calls `confirm()` |
| 3. Change review approval | `ChangeReviewRepository.approve()`/`reject()` refuse any actor without the `operator:` prefix (`ReviewDecisionRequiresOperatorError`) | A thrown error — see `pipeline/security.test.ts`'s "Coding Agent cannot approve its own change" |
| 4. PR merge | **Nothing in this codebase can do it.** `GitHubAppClient` has no merge method; `GithubPublishService` exposes exactly one method, and it stops the moment a PR exists | Structurally impossible, not merely refused |

The pipeline's own queue workers (`change-execution-queue.ts`,
`github-publish-queue.ts`) never call `approve`/`reject`/`confirm` at
all — their dependencies don't even need those methods to do their job
(`findApproved`/`findSucceeded` are read-only polls); this is verified
directly by `pipeline/security.test.ts`.

### Why the Coding Agent is not auto-polled

Every other stage transition in `pipeline/` is a scheduler-polled queue
worker. The Coding Agent trigger (`pipeline/coding-agent-trigger.ts`) is
deliberately **not** — `CodingAgentInput.candidateFilePaths` has no
automatic source (`coding-agent/repository-context.ts`'s own documented
limitation: "there is no repository-tree-listing capability yet... supplied
by the caller"). A poller would have nothing truthful to supply. This
function is invoked once, explicitly, via `POST /runs/:runId/coding-agent`,
by an operator who supplies the paths — a deliberate scope boundary, not
an oversight, and one a future file-discovery phase can close without
touching this function's own logic.

## Workers and schedulers

Every new loop mirrors the existing shape exactly (`setInterval` +
`inFlight` guard + `isReady` + `.unref()`) — see
`orchestrator/scheduler.ts`'s own comment for why this codebase copies
this shape per domain rather than sharing one generic utility.

| Loop | Eligibility query | Action |
| --- | --- | --- |
| `requirements/scheduler.ts` | `intakeItems.status = 'received'` | Runs the Requirements Agent, advances to `pending_approval` |
| `orchestrator/scheduler.ts` *(unchanged)* | `intakeItems.status = 'approved'` | Queues a run |
| `repository-selection/scheduler.ts` *(unchanged)* | `runs.status = 'queued'` with no selection yet, plus due retries | Matches candidates |
| `pipeline/scheduler.ts` | `changeReviews.status = 'approved'` with no execution yet, **then** `changeExecutions.status = 'succeeded'` with no publication yet | Executes, then publishes |

`pipeline/scheduler.ts` runs both of its passes in **one** loop,
sequentially, rather than two separate schedulers — the two stages are
strictly sequential in the pipeline, so a newly-succeeded execution can be
published in the same tick that produced it, instead of waiting a full
extra interval.

Every worker follows the same "list broadly, check per-item via the
idempotency lookup, one bad item never stops the pass" shape
`repository-selection/worker.ts` already established — see each queue
module's own header comment.

## Idempotency

Every stage's idempotency is a unique MongoDB index plus a
`createIfAbsent`-shaped write — nothing new was invented:

| Collection | Unique on | What a retry does |
| --- | --- | --- |
| `runs` | `intakeItemId` | Returns the existing run |
| `requirementsAnalyses` | `intakeItemId` | Skips re-analysis if the content hash is unchanged |
| `repositorySelections` | `runId` | Returns the existing selection |
| `changeReviews` | `proposalHash` | Returns the existing review (a genuinely new proposal gets a new hash, and therefore a new row) |
| `changeExecutions` | `reviewId` | Returns the recorded result, never re-applies |
| `githubPublications` | `executionId` | Returns the recorded result, never re-publishes |

`pipeline/end-to-end.test.ts`'s idempotency test exercises this directly:
re-running both queue passes after a full success reports
`alreadyExecuted`/`alreadyPublished`, and two concurrent direct calls to
`executeApprovedChanges`/`publishApprovedChanges` for the same
review/execution return byte-identical results.

## Recovery

**On restart, every worker re-derives what to do from persisted state —
nothing depends on in-memory state for correctness.** A crashed process
loses only its `inFlight` in-process de-duplication map, never a decision:
the next tick's eligibility query (`findApproved`, `findSucceeded`,
`status = 'received'`, …) re-examines exactly the rows still needing work,
because "needing work" is itself a database query, not a remembered
to-do list.

| Failure | What happens |
| --- | --- |
| Process / scheduler / worker restart | The next tick's eligibility query picks up exactly where persisted state says to — see above |
| Network timeout mid-GitHub-call | `change-execution/execution-service.ts` and `github-publish/publish-service.ts` each classify this as retryable/non-retryable per category; a genuinely ambiguous GitHub write (branch/PR creation) is reconciled via a follow-up read before being declared failed — see docs/github-publish.md's "Failure recovery" |
| MongoDB transient failure | Not swallowed — surfaces as a thrown error, caught by the scheduler's own try/catch (logged, next tick retries) |
| Duplicate queue delivery / webhook | Existing `webhookDeliveries.deliveryId_unique` (unchanged) |
| Partially completed stage | Every stage's `createIfAbsent` is atomic at the database level — a document either exists complete, or does not exist at all; there is no partially-written row for a later pass to misinterpret |

## Failure taxonomy

No new taxonomy was invented — this phase composes the categories each
underlying service already defines (`CodingAgentFailureCategory`,
`ExecutionFailureCategory`, `PublishFailureCategory`) and adds exactly one
small taxonomy of its own, for the one genuinely new composition point:

```ts
type TriggerCodingAgentFailureCategory = 'repository_access_failure' | 'coding_agent_failure';
```

Every queue worker distinguishes "nothing eligible" (0 examined, not an
error) from "an item failed" (counted, logged, pass continues) from "the
whole pass failed" (caught by the scheduler, logged, never crashes the
process) — the same three-level distinction `repository-selection/worker.ts`
already established.

## HTTP API

Three new operator-gated routes, following `api/approval.ts`'s exact
shape (verify the bearer token before reading the body; delegate all
state-machine and audit work to the repository; translate the outcome to
HTTP):

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/runs/:runId` | The composed end-to-end status view — `pipeline/run-status.ts` |
| `POST` | `/runs/:runId/coding-agent` | Triggers the Coding Agent (GATE-adjacent — see above) |
| `POST` | `/change-reviews/:reviewId/approve` \| `/reject` | GATE 3 |

`GET /runs/:runId` is gated behind the operator token too, even though it
only reads — for consistency with `GET /repository-registry`'s existing
convention, not because the data itself is secret.

**Never exposed, by construction:** `RunStatusView` and every API
response body here are built from documents that never carry a GitHub
token, JWT, private key, or `Authorization` header — the same "there is
nothing to accidentally forward" guarantee `RepositoryContext` and
`AuthorizedRepositoryAccess` already established, now extended to the
run-status view. Verified directly by tests in `run-status.test.ts` and
`pipeline/run-status.test.ts`.

## Configuration

No new environment variables were added — every new piece of
configuration this phase needs already existed for an earlier, unwired
phase:

| Variable | Consumed by (new in this phase) |
| --- | --- |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | The real `GitHubAppClient` — now actually constructed and wired to Coding Agent / change execution / GitHub publish, gating all three on being configured |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Shared between the Requirements Agent (unchanged) and, newly, the Coding Agent's real provider |
| `OPERATOR_TOKEN` | Gates the three new routes, same as every existing mutation route |

Absent GitHub App configuration is a valid, non-fatal state — the
`pipeline/scheduler.ts` loop and the `/runs/:runId/coding-agent` route are
simply not started/mounted, the same "disabled, not fatal" choice
enrichment already makes for a missing Neutara configuration. Verified by
the boot smoke test: with no GitHub App credentials set, the service
starts, every other loop starts, and `POST /runs/:runId/coding-agent`
answers 404 (not mounted) rather than crashing.

## Audit

No new audit **actions** were added for the queue workers themselves —
every stage they drive was already fully audited by its own service
(`requirements.*`, `coding-agent.*`, `change-review.*`,
`change-execution.*`, `change-validation.*`, `github.write.*`,
`github.branch.created`, `github.pr.created`). A queue worker's only job
is deciding WHEN to call an already-audited service; adding a second,
redundant "the queue decided to call it" event would duplicate
information a reader can already reconstruct from the existing trail —
the exact "do not duplicate events unnecessarily" instruction this phase
was given. `audit.query({ subjectId: runId })` (unchanged) already
reconstructs a run's complete history end to end.

## Observability

`RunStatusView` (`GET /runs/:runId`) gives an operator, in one call: run
id, stage, whether human action is required (and what action),
repository/branch, review/execution status, a pass/fail validation
summary, and PR number/url — everything section 15 asks for, built
entirely from already-non-secret fields.

## Security review

See `pipeline/security.test.ts` for the executable checklist. Summary:

- **No service can approve its own change / no Coding Agent can approve
  its own proposal** — `ReviewDecisionRequiresOperatorError`, enforced at
  the repository boundary every caller (HTTP handler, and structurally,
  the pipeline queue which never calls `approve`/`reject` at all) goes
  through.
- **No unconfirmed repository can be accessed** — `authorizeRepositoryAccess`
  (unchanged) refuses before any GitHub call.
- **No unapproved change can be published** — `executeApprovedReviews`
  only ever examines `approved` reviews; `publishSucceededExecutions` only
  ever examines `succeeded` executions; both verified with fakes that
  throw if a broader eligibility is ever assumed.
- **No write targets the base branch** — `validateBranchName` refuses it
  structurally (github-publish/branch-name.ts), unchanged this phase.
- **No arbitrary repository is ticket-supplied** — `repositoryRegistry`
  remains the sole source, unchanged.
- **No secrets logged, no credentials reach the LLM, no GitHub tokens in
  audit** — unchanged guarantees from every earlier phase, re-verified by
  this phase's own new tests (`run-status.test.ts`'s "never returns a
  token" test, `security.test.ts`).
- **No path traversal** — `coding-agent/path-safety.ts`, reused unchanged
  throughout `change-execution/` and `github-publish/`.
- **No duplicate execution bypasses approval** — idempotency is keyed on
  the approved review's own id; a duplicate call finds the recorded
  outcome, never re-derives eligibility from scratch.

## Current limitations

- **No automatic merge, no deployment, no automatic human decision-making
  anywhere in this codebase.** The workflow stops at Pull Request Created;
  a human reviews and decides whether to merge.
- **The Coding Agent trigger is operator-invoked, not auto-polled** — see
  "Why the Coding Agent is not auto-polled" above.
- **Validation remains mock-only** — inherited from `change-execution/`,
  unchanged this phase.
- **Stale-base-branch protection is scoped to one publish attempt** —
  inherited from `github-publish/`, unchanged this phase.
- **No configurable poll interval via environment variable** — every
  scheduler's interval is a module constant, matching the existing
  convention; overridable only via the `options` parameter, programmatically.
