# GitHub Write + Pull Request Workflow

**GitHub branch, commit, push, and Pull Request creation are implemented in
this phase. Pull Request merge remains human-controlled.** Nothing in this
codebase — this module, `github-app/client.ts`, or either of its
implementations — has a merge method. The workflow stops the moment a pull
request exists:

```
Validated Local Changes
    ↓  a `succeeded` ChangeExecutionDocument for an `approved` ChangeReviewDocument
Create Dedicated Branch
    ↓  aisdlc/<runId>/<executionId>, off the confirmed base branch's current sha
Apply Approved Changes
    ↓  one Git Data API tree + commit, built off that base — never a per-file PUT
Verify Changes
    ↓  every modify-target's live content re-hashed immediately before publishing
Commit → Push
    ↓  createCommit, then createBranch (the one call with a visible side effect)
Verify Remote State
    ↓  re-read the branch, confirm it points at the commit just built
Create Pull Request
    ↓
Human PR Review   ← this phase's boundary
    ↓
(future) Human Approval → Merge → Deployment / Post-Deployment Validation
```

## Architecture

| Module | Owns | Never does |
| --- | --- | --- |
| `types.ts` | `PublishResult` and the failure taxonomy | Any logic |
| `branch-name.ts` | Deterministic branch naming + a git ref-name validator | Talk to GitHub |
| `pr-content.ts` | Commit message and PR title/body — pure, from `ChangeReviewDocument` + `ChangeExecutionDocument` only | Read `ProposedChange.proposedContent` or any audit `detail` |
| `publish-repository.ts` | `githubPublications` — the durable idempotency record | Decide whether to publish — only records the outcome |
| `publish-service.ts` | Orchestrates all of the above; the only public entry point | Merge a pull request, or bypass any check |

`github-app/client.ts` gained six write-capable methods for this phase
(`getRef`, `getCommit`, `createTree`, `createCommit`, `createBranch`,
`createPullRequest`, plus the read-only reconciliation lookup
`findPullRequestForBranch`) — extending the existing client interface
rather than building a second GitHub implementation. Both `mock-client.ts`
(now realistically stateful: branches, commits, and trees behave like real
git objects) and `real-client.ts` (the Git Data API over `fetch`, reusing
`token-issuer.ts` for every installation token) implement all of them.

## Why a single commit, not per-file PUTs

Building one commit via the Git Data API (`getCommit` → `createTree` →
`createCommit` → `createBranch`) rather than one Contents-API `PUT` per
file keeps publishing atomic in the same sense
`change-execution/local-apply.ts` is atomic: **nothing is externally
visible — no branch, no commit anyone else can see — until the single
`createBranch` call succeeds.** A tree or commit object with no ref
pointing at it is simply unreachable garbage if an attempt is abandoned
partway through. This is also why only `createBranch` (the push) and
`createPullRequest` get reconciliation-before-retry treatment below,
never `createTree`/`createCommit`: those two are the only calls in this
interface with an externally visible, non-idempotent side effect.

## The security boundary (Section 2)

Only an explicitly approved, successfully executed, and successfully
validated change may enter this workflow. `execute()` runs in two phases —
the same split `change-execution/execution-service.ts` already
established:

1. **Eligibility** (unpersisted, freely re-checkable — nothing here has a
   side effect):

   | Check | Failure category |
   | --- | --- |
   | Execution exists, belongs to this run | `execution_not_found` |
   | Execution status is `succeeded` (covers "did not succeed" and "validation did not succeed" — `ChangeExecutionDocument.status` already collapses both) | `execution_not_succeeded` |
   | Review exists | `review_not_found` |
   | Review status is `approved` | `review_not_approved` |
   | Executed proposal hash matches the approved review's | `proposal_hash_mismatch` |
   | Review is still the latest for this run | `review_superseded` |
   | Repository selection exists, is confirmed, registry entry is active, installation id is valid — all via `authorizeRepositoryAccess` (`github-app/access.ts`), reused unchanged | `repository_access_failure` |
   | The run's confirmed repository still matches what was reviewed | `repository_mismatch` |
   | The run's confirmed **default** branch still matches what was reviewed | `branch_mismatch` |

   **Why `authorizeRepositoryAccess` is called WITHOUT an explicit
   `branch` option.** Passing `{ branch: review.branch }` would force
   authorization of the reviewed branch regardless of what the confirmed
   selection currently names — making `branch_mismatch` unreachable dead
   code. Omitting it authorizes the selection's own current default
   branch, so a selection re-confirmed with a different branch since the
   review was created is exactly what this check catches.

2. **Attempt** (persisted via `GithubPublicationRepository`, idempotent on
   `executionId` — every outcome from here is recorded exactly once):

   | Check | Failure category |
   | --- | --- |
   | Every proposed path is still safe (`coding-agent/path-safety.ts`, reused) | `invalid_path` / `unauthorized_file` |
   | Every `modify` target's LIVE content still matches the approved `originalContentHash`, re-read immediately before publishing (**"local execution result is stale"**) | `stale_file` |
   | The base branch still exists | `base_branch_missing` |
   | The base branch has not moved since the sha was read to build the commit (Section 5) | `base_branch_changed` |
   | The generated branch name passes `validateBranchName` | `invalid_branch_name` |
   | No branch already exists at the deterministic name that this attempt didn't itself create | `branch_conflict` |
   | Tree, commit, branch, and PR creation each have their own category | `tree_creation_failed`, `commit_creation_failed`, `branch_creation_failed`, `pull_request_creation_failed` |
   | The published branch was re-read and confirmed to point at the built commit | `push_verification_failed` |

The Coding Agent never triggers any of this directly — `publishApprovedChanges`
requires a `runId` and an already-recorded `executionId`; there is no code
path from `coding-agent/service.ts` to this module at all.

## Branch naming (Section 4)

`aisdlc/<runId hex>/<executionId hex>` — deterministic and unique BY
CONSTRUCTION from two already-unique MongoDB ObjectIds, never from
anything an LLM or a human supplies. Two calls for the SAME execution
always produce the SAME name, which is what makes "does this branch
already exist" idempotency check meaningful (see "Idempotency" below).

`validateBranchName` is defence in depth on top of that guarantee — a
conservative, hand-written git ref-name validator (this project has no git
binary to ask) that also refuses a branch name equal to the base branch,
and refuses `main`/`master` outright regardless of what the base branch is
named. **The base branch is never a valid publish target for this
workflow, under any circumstance.**

Before creating the branch: the confirmed base branch is re-read live
(`getRef`), its current commit sha becomes the parent of the new commit —
never a stale or assumed value.

## Stale base branch protection (Section 5)

**Known, documented limitation of this mechanism:** the earlier
Local Change Execution phase (`change-execution/`) does not persist a base
branch sha anywhere — there is nothing from an earlier phase to compare
against. What this phase protects against instead is a race **during this
same publish attempt**: the base branch's sha is read once to build the
commit, and re-read immediately before `createBranch` is called; if it
moved in between, publishing stops (`base_branch_changed`) and no branch
is created. This is a real, tested race window (however narrow), not a
placeholder — but it does not, and cannot, detect a base-branch change
that happened entirely before this publish attempt started (that drift is
caught by ordinary content re-verification instead: any file the base
branch's move actually touched would already fail its own `stale_file`
check).

Nothing is made visible by the read-only steps that happen in between —
the tree and commit objects already built have no ref pointing at them, so
stopping here leaves no trace to clean up.

## Commit and push behavior (Sections 6–8)

One commit, built from `review.proposedChanges` exactly as approved — no
regeneration, no additional LLM involvement, no file outside the approved
proposal. The commit message (`pr-content.ts`'s `buildCommitMessage`)
references the run/review/execution identifiers only, never file content.

"Push" has no separate primitive in the GitHub REST API — `createBranch`
(create a new ref pointing at the built commit) **is** the push. It is
the one call in this whole flow with a side effect anyone else can
observe.

## Verifying remote state (Section 4/12)

After `createBranch` returns success, the branch is read back
(`getRef`) and its sha is compared against the commit that was just
built — a 2xx response is never assumed to mean the state is what was
intended.

## Pull request content (Section 9)

`pr-content.ts`'s `buildPullRequestContent` includes: the plan's
requirements understanding, the list of applied file paths and operations,
the validation summary (tests/typecheck/build, each pass/fail with a short
summary — never full command output), and the run/review/execution
identifiers. It explicitly states the changes were generated through the
approved AISDLC workflow and that merge remains human-controlled. It never
includes `ProposedChange.proposedContent`, a token, or a credential-shaped
string — asserted directly by `pr-content.test.ts`.

## Idempotency (Section 10)

`GithubPublicationRepository.createIfAbsent` is idempotent on
`executionId` (`executionId_unique`): a given approved, successfully
executed change is published at most once, ever. `publish-service.ts`
checks `findByExecutionId` as a fast path before doing any eligibility
work, so a duplicate call for an already-published execution makes zero
GitHub calls. Concurrent calls for the same `(runId, executionId)` pair
are de-duplicated in-process — the same `inFlight: Map` shape
`change-execution/execution-service.ts` and every earlier phase's service
already use.

As a second layer, independent of the persisted row: because the branch
name is deterministic, a branch already existing at that exact name (that
this attempt did not itself just create) is refused as `branch_conflict`
rather than reused or overwritten.

## Failure recovery (Sections 11–12)

**Only `createBranch` and `createPullRequest` are ambiguous on failure** —
they are the only two calls with an externally visible, non-idempotent
side effect (see "Why a single commit" above). For both, an
ambiguous (ie. not a definitive "already exists") failure triggers an
immediate reconciliation read before the attempt is declared failed:

- `createBranch` fails ambiguously → re-read the branch (`getRef`); if it
  now exists and points at the commit just built, treat the push as
  successful (it landed despite the response failure) rather than
  retrying it.
- `createPullRequest` fails ambiguously, or reports 422
  (`pull_request_already_exists`) → look up the existing PR
  (`findPullRequestForBranch`) and use it, rather than opening a second one.

`createTree` and `createCommit` need no such treatment: an object with no
ref pointing at it has no observable effect, so a failure there is always
safe to simply report — nothing needs reconciling.

**Never blindly retried.** This service makes exactly one attempt per
call; it does not loop internally. A caller may call
`publishApprovedChanges` again later, and idempotency (the persisted row,
plus the reconciliation above) makes that safe.

## Audit events

All under the existing `AuditLog`, actor `system:github-publish`.

| Action | Subject | When |
| --- | --- | --- |
| `github.write.failed` | `run` | An eligibility-phase refusal — nothing was attempted, nothing persisted |
| `github.write.started` | `changeExecution` | Eligibility passed; the attempt phase begins |
| `github.branch.created` | `changeExecution` | The branch was published and its remote state verified |
| `github.pr.created` | `changeExecution` | A pull request was opened (or recovered via reconciliation) |
| `github.write.completed` | `githubPublication` | The attempt succeeded — recorded by `publish-repository.ts` |
| `github.write.failed` | `githubPublication` | An attempt-phase failure — recorded by `publish-repository.ts` |

**Deliberately fewer events than one per GitHub call.** No
`github.changes.published` (redundant with `github.branch.created` — in
this design they are the same moment, since nothing is visible until the
branch exists) and no per-object `github.commit.created` (a commit with no
ref pointing at it has no observable effect, so auditing its creation
separately tells a reader nothing actionable) — preserving the existing
project's audit conventions rather than adding events with no
information content.

**Never logged or audited:** GitHub tokens, JWTs, private keys, API keys,
`Authorization` headers, or file contents. A dedicated test asserts no
audit `detail` contains proposed or live file content, or the substring
`token`.

## Security model (unchanged, reused)

- GitHub App installation tokens only — `authorizeRepositoryAccess` and
  `TokenIssuer`, unchanged. No personal access token anywhere.
- Every write request sets `redirect: 'error'` — a renamed/redirected
  repository is refused, never silently followed.
- Path/file safety (`coding-agent/path-safety.ts`) re-checked immediately
  before publishing, on top of every earlier check in
  `change-execution/`.
- The base branch is never a valid publish target — enforced structurally
  (this workflow only ever calls `createBranch` for the generated
  `aisdlc/...` name) and by `validateBranchName`'s explicit
  `protected_branch` check.
- No secrets anywhere reachable by a caller: `PublishResult` carries no
  token, and neither does any audit entry.

## Current limitations

- **No HTTP API layer.** `GithubPublishService` is a callable entry point,
  the same shape every earlier phase's service already is.
- **No orchestrator scheduler wired up yet.** A caller supplies `runId`
  and `executionId` explicitly; nothing calls this automatically when a
  `ChangeExecutionDocument` succeeds.
- **Stale-base-branch protection only covers the window of a single
  publish attempt** — see "Stale base branch protection" above for
  exactly what is and is not covered, and why.
- **A `create`-operation path that has since come to exist on the base
  branch is not detected** — the same documented limitation
  `change-execution/local-apply.ts` already has for local execution; this
  phase inherits it rather than closing it, since closing it needs a
  per-path existence probe this phase's `GitHubAppClient` surface does not
  yet have a cheap way to express.
- **No merge, no deployment, no post-deployment validation** — the next
  phase, explicitly not implemented here:
  ```
  Pull Request → Human Review → Human Approval → Merge → Deployment / Post-Deployment Validation
  ```
