# Human PR Merge → Deployment → Post-Deployment Validation

**Pull Request merge remains human-controlled. AISDLC detects the merge but
does not perform the merge.** Nothing in this codebase — `github-app/client.ts`,
either of its implementations, or anything under `deployment/` — has a
`mergePullRequest`, `approvePullRequest`, or `autoMerge` method. This phase
begins strictly AFTER a human has already merged (or closed without
merging) a pull request `github-publish/` opened, and it begins by
detecting that fact, never causing it:

```
Pull Request Created
    ↓  github-publish/ (previous phase) — this phase's boundary starts here
WAIT — Human Reviews
    ↓
Human Merges (or closes without merging)     ← human-controlled, always
    ↓
AISDLC Detects Merge                          ← deployment/pr-merge-detection.ts, read-only
    ↓
Deployment Eligibility                        ← a `deployments` row, status 'eligible'
    ↓
Deployment                                    ← deployment/deployment-service.ts, mock provider only
    ↓
Post-Deployment Validation                    ← deployment/post-deployment-validator.ts, mock only
    ↓
Final Status                                  ← pipeline/run-status.ts
```

**Deployment orchestration is implemented behind a provider abstraction;
real production deployment remains disabled until the deployment
environment is explicitly configured and verified.** This repository has no
Dockerfile, no CI/CD workflow, no cloud-platform configuration, and no
deploy script anywhere in it (verified before writing this phase) — see
"Current limitations" below.

## Architecture

| Module | Owns | Never does |
| --- | --- | --- |
| `types.ts` | `DeploymentResult`, `PostDeploymentValidationSummary`, and the failure taxonomy | Any logic |
| `deployment-repository.ts` | `deployments` — the durable, idempotent-on-`publicationId` record | Decide whether to deploy — only records the outcome |
| `deployment-provider.ts` | `DeploymentProvider` interface + `createMockDeploymentProvider` | Merge a PR, touch GitHub, or receive a GitHub/database credential |
| `post-deployment-validator.ts` | `PostDeploymentValidator` interface + `createMockPostDeploymentValidator` | Anything beyond health/readiness of the identifier it's given |
| `pr-merge-detection.ts` | Reads `GitHubAppClient.getPullRequest`, verifies identity, creates the `deployments` row | Merge, approve, or write to a pull request in any way |
| `deployment-service.ts` | Orchestrates claim → validate → deploy → post-deployment validation → record | Deploy an arbitrary commit, retry blindly, or roll back |
| `deployment-queue.ts` | Batch driver — `findEligible` → `runDeployment` per row | Any eligibility logic of its own (the claim IS the check) |

`github-app/client.ts` gained exactly one further, READ-ONLY method for
this phase: `getPullRequest(installationId, owner, repo, number)`. There is
no `mergePullRequest`, `approvePullRequest`, or `autoMerge` method anywhere
in that interface — asserted directly by `deployment/security.test.ts` and
`github-app/*.test.ts`.

## The human merge boundary (Section 2)

AISDLC MAY: detect that a PR exists, read its state/merged flag/checks, and
update run status to reflect it. AISDLC MUST NOT, and cannot, because no
such capability exists anywhere in this codebase: automatically merge a
pull request, approve a pull request, impersonate a human reviewer, bypass
branch protection or required checks, or merge on a human's behalf.

## PR status integration (Section 3)

`getPullRequest` is the only extension to the existing GitHub client — it
reuses the same installation-token auth (`authorizeRepositoryAccess`) and
error-classification (`isRetryable`, the same `GitHubAccessFailureKind`
taxonomy) every other client method already uses. It returns: PR number,
URL, state (`open`/`closed`), `merged` (boolean), `mergeCommitSha`
(`string | null`), and `headRef`/`baseRef`. `real-client.ts` implements it
via `GET /repos/{owner}/{repo}/pulls/{number}`; `mock-client.ts` reads from
declaratively-seeded `MockRepository.pullRequests` — a way to model "a
human already merged this PR", never a way to perform a merge.

## Merge detection (Section 5)

`detectMergedPullRequests` polls every `published` `GithubPublicationDocument`
without a `deployments` row yet (`findPublished`), and for each:

1. Re-derives the installation via `authorizeRepositoryAccess` (reused,
   unchanged) from the run's own confirmed repository selection — never
   from the publication's stored owner/repo alone.
2. Refuses if the freshly-authorized owner/repo does not match what was
   published (`pr_identity_mismatch`-shaped refusal) — a repository swap
   after publishing is never silently followed.
3. Reads the PR via `getPullRequest`.
4. **Verifies the PR's `headRef`/`baseRef` match the publication's own
   `branch`/`baseBranch`** before trusting anything else about the
   response — the PR number alone is never sufficient proof of identity.
5. Branches explicitly on GitHub's own `state` and `merged` fields:
   - `state === 'open'` → still waiting, nothing recorded.
   - `state === 'closed'` and `merged === false` → a `deployments` row is
     created with `status: 'closed_unmerged'`, terminal.
   - `state === 'closed'` and `merged === true` → a `deployments` row is
     created with `status: 'eligible'` and the real `mergeCommitSha`.

**"Closed" is never treated as "merged."** Every branch above reads
GitHub's own `merged` boolean explicitly; there is no code path that
infers a merge from `state` alone (`pr-merge-detection.test.ts` has a
dedicated case for exactly this).

## Run state (Section 4)

`pipeline/run-status.ts`'s `computeRunStatus` — already a pure, derived
view over existing collections, never a second stored state — gained six
more stages, reached only once a `deployments` row exists for the
publication: `pr_closed_unmerged`, `deployment_eligible`, `deploying`,
`deployed`, `deployment_validation_failed`, `deployment_failed`. No
separate `merged` stage exists: `deployment_eligible` already implies it,
since `pr-merge-detection.ts` only ever creates an `eligible` row the
moment a merge is confirmed — nothing distinct happens between those two
facts in this design.

## Deployment record (Section 10)

One `deployments` document per publication, ever
(`publicationId_unique`): `runId`, `executionId`, `publicationId`, `owner`,
`repo`, `pullRequestNumber`, `mergeCommitSha` (null only for
`closed_unmerged`), `status`, `provider`, `target`, `deploymentIdentifier`,
`validation`, `failureCategory`/`failureMessage`, `createdAt`/`startedAt`/`completedAt`.
No credential of any kind is ever a field on this document.

## Deployment states (Section 11)

`eligible → running → succeeded | failed`, plus the terminal
`closed_unmerged` that never enters this chain at all. `queued` exists in
the schema for completeness (a future, higher-concurrency worker could use
it) but the current single-claim worker moves `eligible → running`
directly — there is no intermediate queueing step to model yet. Human PR
review is a wholly separate concern, represented on the `githubPublications`
row, never folded into this state model.

## Deployment provider (Sections 7–8)

**Mock only, this phase, deliberately.** A dedicated research pass before
writing this phase confirmed no Dockerfile, CI/CD workflow, cloud-platform
configuration file, or deploy npm script exists anywhere in this
repository. Inventing a deployment mechanism now would mean guessing at
infrastructure this project has never adopted — exactly what this phase
was told not to do.

`DeploymentProvider` is a three-method interface: `validateDeployment`
(configuration/target validity, never a network attempt),
`deploy` (the attempt itself), and `getDeploymentStatus` (reconciliation).
`createMockDeploymentProvider` is deterministic, in-memory, offline, and
tracks which `deploymentIdentifier`s it has "deployed" internally — the
only implementation any test, or currently any running instance, uses.

**Never receives unnecessary secrets.** `DeploymentRequest` carries
identifiers only (run/execution/publication ids, the merge commit sha,
owner/repo, a target name, the deployment identifier) — no GitHub token, no
database credential, no API key of any kind. A real provider would need
its own deployment credential, supplied to its own constructor the way
`RealGitHubAppClientOptions` supplies a private key — never threaded
through a `DeploymentRequest`. Asserted directly by
`deployment/security.test.ts`.

**Reconciliation, not blind retry.** `DeploymentRequest.deploymentIdentifier`
is deterministic and caller-supplied (`deployment-<runId>-<executionId>`,
derived by `deployment-service.ts`, mirroring `github-publish/`'s
deterministic branch naming) — so an ambiguous `deploy()` failure is
reconciled via `getDeploymentStatus(deploymentIdentifier)` before being
declared genuine, the same discipline `github-publish/publish-service.ts`
already established for `createBranch`/`createPullRequest`.

## Deployment eligibility (Section 9)

A deployment is only ever attempted for a row that is, at the moment of
`claim()`, still `status: 'eligible'` — which by construction (the only
caller of `createIfAbsent` with that status is `pr-merge-detection.ts`,
which only reaches it after verifying the PR's identity and reading
`merged: true` directly from GitHub) means: the correct run/publication
exists, the PR was actually merged, the merge commit sha is known, the
repository/branch identity was verified, and an approved execution exists
upstream (a `published` row cannot exist without one — see
`docs/github-publish.md`'s eligibility table). `claim`'s compare-and-set
additionally guarantees no conflicting deployment is already in flight.
**A `closed_unmerged` row can never be claimed** — `claim()`'s filter only
ever matches `status: 'eligible'`.

## Deployment safety (Section 12)

The commit deployed is always `deployment.mergeCommitSha`, read from the
already-persisted row — `runDeployment(deployment: DeploymentDocument)`
has no separate "commit" parameter any caller (HTTP or otherwise) could
substitute. There is no HTTP endpoint that accepts a commit, repository, or
target as input anywhere in this phase (see "HTTP API" below).

## Post-deployment validation (Sections 13–14)

This repository has no existing health/readiness/smoke-test mechanism to
reuse beyond `api/health.ts`'s own liveness/readiness contract — which is
exactly the CONCEPTUAL model `PostDeploymentValidator` mirrors (a `health`
step and a `readiness` step, each `{ ok, summary }`), documented as what a
real implementation would probe via HTTP against the deployed target.
`createMockPostDeploymentValidator` is deterministic and defaults both
steps to pass.

**Deployment succeeding and validation failing are recorded separately**
(Section 14). If `provider.deploy()` itself succeeds, the `deployments`
row is marked `succeeded` regardless of what post-deployment validation
finds — a failing health check does not retroactively make the deployment
not have happened. `DeploymentResult.ok` reflects the END-TO-END outcome a
caller cares about (`false`, category `validation_failed`, if validation
fails) even though the persisted row's own `status` is `'succeeded'`. **No
automatic rollback is attempted or invented** — see "Current limitations".

## Idempotency (Section 6)

Three independent layers:

1. `deployments.publicationId_unique` — one deployment row per publication,
   ever. `pr-merge-detection.ts` checks `findByPublicationId` before doing
   any GitHub call at all, so a publication that already has a row is
   skipped with zero API calls (`alreadyRecorded`).
2. `claim()`'s compare-and-set (`eligible → running`) — the deployment
   queue's own idempotency check; a row already claimed by a concurrent
   worker (or a prior pass) returns null and is reported as
   `already_deployed`, never re-attempted.
3. `getDeploymentStatus` reconciliation on an ambiguous `deploy()` failure
   (see "Deployment provider" above) — a lost response is never assumed to
   mean "not deployed."

Restart-safe by construction: nothing in this phase holds in-process state
that a worker restart would lose — every check re-derives from the
persisted `deployments` row and, for merge detection, a fresh read of
GitHub's own PR state.

## Failure taxonomy (Section 19)

| Category | Meaning | Retryable |
| --- | --- | --- |
| `not_eligible` | Reserved for a future stricter eligibility gate | No |
| `configuration_invalid` | No merge commit sha, or `validateDeployment` refused | No |
| `pr_access_failure` | Could not read the PR / authorize repository access | No |
| `pr_identity_mismatch` | PR head/base or repository does not match the publication | No |
| `conflict` | Reserved | No |
| `deployment_provider_failure` | `deploy()` genuinely failed (reconciled first) | No |
| `deployment_timeout` | `deploy()` timed out (reconciled first) | No |
| `deployment_rejected` | Reserved for a real provider's explicit rejection | No |
| `validation_failed` | Deployment succeeded; post-deployment validation did not | No |
| `validation_timeout` | Reserved for a real validator's timeout | No |
| `already_deployed` | The row was no longer `eligible` when claimed | No |
| `unexpected_error` | Anything uncategorized | No |

Every category defaults to non-retryable (`isRetryableDeploymentCategory`
always returns `false`) — this phase makes exactly one attempt per call and
never loops internally; a caller (the scheduler) may call again later, and
idempotency makes that safe. This mirrors `ExecutionFailureCategory`'s and
`PublishFailureCategory`'s own "reuse GitHub categories where applicable,
add new ones only where needed" discipline.

## Audit events (Section 15)

All under the existing `AuditLog`, actor `system:deployment`.

| Action | Subject | When | Owner |
| --- | --- | --- | --- |
| `github.pr.merge.detected` | `deployment` | A merge was confirmed; the eligible row was created | `deployment-repository.ts` |
| `github.pr.closed_without_merge.detected` | `deployment` | A PR was closed without merging | `deployment-repository.ts` |
| `deployment.started` | `deployment` | The row was claimed; an attempt begins | `deployment-service.ts` |
| `deployment.validation.started` | `deployment` | `deploy()` succeeded; post-deployment validation begins | `deployment-service.ts` |
| `deployment.validation.completed` | `deployment` | Validation passed | `deployment-service.ts` |
| `deployment.validation.failed` | `deployment` | Validation failed (deployment itself still succeeded) | `deployment-service.ts` |
| `deployment.completed` | `deployment` | The row was marked `succeeded` | `deployment-repository.ts` |
| `deployment.failed` | `deployment` | The row was marked `failed`, or an eligibility-phase refusal | `deployment-repository.ts` / `deployment-service.ts` |

**Deliberately no separate `deployment.eligible` event** — redundant with
`github.pr.merge.detected`, which fires at the exact same write with
overlapping information, the same "no duplicate events" discipline
`github-publish.md` already applies to `github.changes.published`.

**Never logged or audited:** GitHub tokens, JWTs, private keys, deployment
provider credentials, `Authorization` headers, or source content.
`deployment/security.test.ts` and `deployment-service.test.ts` assert no
audit `detail` contains the substring `token` or `authorization`.

## HTTP API (Section 16)

| Route | Method | Mounted as |
| --- | --- | --- |
| `/runs/:runId/deployment` | `GET` | `api/deployment-status.ts` — the detailed deployment record (status, provider, target, timestamps, full validation summary) beyond what the compact `GET /runs/:runId` view already carries |

Gated behind the operator bearer token, the same "mounted but refuses
without a token" choice every other optional route in `server.ts` already
makes. **No write endpoint of any kind exists on this surface**: no
`POST /merge`, no `POST /approve-pr`, no `POST /auto-deploy`. There is no
manual deploy-trigger endpoint either — none was needed, since the
scheduler already drives every eligible deployment automatically once a
merge is detected. `api/server.test.ts` has a dedicated test asserting
`/merge`, `/approve-pr`, `/auto-deploy`, and `/deploy` all 404, and that
`POST`/`PATCH`/`DELETE` on `/runs/:runId/deployment` are all `405`.

## Scheduler (Section 17)

`pipeline/scheduler.ts`'s single loop gained two more passes, run in the
same tick, in order, after the existing two: change execution → GitHub
publish → **PR-merge detection → deployment**. One loop, not four separate
ones — the same reasoning already documented in that file's own module
comment: each stage is strictly sequential, so running them back-to-back
in one tick lets a row advance through several stages without waiting a
full extra interval per stage. The loop shape itself (`setInterval` +
`inFlight` guard + `isReady` + `.unref()`) is unchanged, copied per domain
rather than shared — see `orchestrator/scheduler.ts`'s own comment for why.

## Recovery (Section 18)

- **Worker restart mid-merge-detection**: nothing was written yet (reads
  only until a definitive `merged`/`closed_unmerged` outcome), so a
  restart simply re-polls the same publication from scratch.
- **Worker restart mid-deployment**: if `claim()` already ran, the row is
  `running` and no longer `eligible`, so a naive re-poll will not pick it
  up again automatically in this phase — a genuinely stuck `running` row
  requires operator attention (see "Current limitations"). If `claim()`
  had not yet run, the row is untouched and the next pass claims it
  normally.
- **GitHub/provider/validator timeout**: `deploy()`'s ambiguous failure is
  always reconciled via `getDeploymentStatus` before being declared a
  genuine failure (see "Deployment provider"). Post-deployment validation
  has no reconciliation step of its own — a validation failure (including
  one caused by a timeout) is recorded as `validation_failed`, never
  retried automatically, matching Section 14's "no rollback" instruction.
- **Duplicate worker execution**: `claim()`'s compare-and-set is the sole
  arbiter; two workers racing for the same row always produce exactly one
  winner and one `already_deployed` outcome — tested directly in
  `deployment-repository.test.ts`'s concurrent-claim test.

## Security verification (Section 23)

Verified, with an executable test for each:

- AISDLC cannot merge or approve a pull request — no such method exists on
  `GitHubAppClient` (`deployment/security.test.ts`, `github-app/*.test.ts`).
- Deployment requires an actually-merged PR — a `closed_unmerged` row can
  never be claimed (`deployment/security.test.ts`).
- Deployment cannot target an arbitrary commit — the commit sent to the
  provider is always the persisted row's own `mergeCommitSha`
  (`deployment/security.test.ts`).
- Deployment cannot bypass human approval — a `deployments` row can only
  ever come from a `published` `githubPublications` row, which itself
  requires a `succeeded` execution of an `approved` review (see
  `docs/github-publish.md`'s eligibility table).
- Deployment cannot run twice for the same execution — `claim()`'s CAS
  plus `publicationId_unique` (`deployment/security.test.ts`,
  `deployment-repository.test.ts`).
- No credentials in logs or audit — asserted directly
  (`deployment/security.test.ts`, `deployment-service.test.ts`,
  `pr-merge-detection.test.ts`).
- No unauthorized repository — merge detection re-derives and verifies
  owner/repo via `authorizeRepositoryAccess`, refusing on mismatch
  (`pr-merge-detection.test.ts`).
- No arbitrary deployment target — `DeploymentRequest.target` always comes
  from the service's own configuration, never from HTTP input (there is no
  HTTP input on this surface at all — see "HTTP API").
- Deployment configuration is never exposed via the API — `GET
  /runs/:runId/deployment` returns only status/provider-name/target-name/
  timestamps/validation, never a credential-shaped field
  (`api/deployment-status.test.ts`).

## Current limitations

- **No real production deployment.** Only `createMockDeploymentProvider`
  and `createMockPostDeploymentValidator` are wired up in `index.ts`. Real
  deployment stays disabled until a genuine mechanism exists in this
  repository AND is explicitly configured — see the module comments in
  `deployment-provider.ts` and `post-deployment-validator.ts`.
- **No automatic rollback.** A deployment that succeeds but fails
  post-deployment validation is recorded as exactly that (Section 14) and
  surfaced via `GET /runs/:runId/deployment` and `pipeline/run-status.ts`'s
  `deployment_validation_failed` stage — no rollback mechanism is invented.
- **No manual deploy-trigger endpoint.** The scheduler drives every
  eligible deployment automatically; an operator cannot currently force a
  specific deployment to (re-)run via HTTP.
- **A stuck `running` row has no automatic recovery.** If a worker crashes
  between `claim()` and `markSucceeded`/`markFailed`, the row stays
  `running` indefinitely — there is no lease/timeout mechanism yet to
  reclaim it. Real deployment would need this before going live; the mock
  provider's calls are synchronous and in-process, so this window is not
  exercised in practice today.
- **`deployment_timeout`/`deployment_rejected`/`validation_timeout`/`not_eligible`/`conflict`
  categories are defined but not yet reachable** — they describe failure
  modes a real provider/validator would produce; the mock provider never
  produces them on its own.
