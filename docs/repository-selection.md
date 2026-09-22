# Repository Registry and Repository Selection

Identifies exactly one authorized GitHub repository for an approved Neutara
ticket before the (not yet implemented) Coding Agent can work on it. Two
collections, one matching worker, one human-confirmation API.

## Scope

This phase does **not**:

- Clone, pull, push, or otherwise touch a real Git repository.
- Implement GitHub App authentication or any live GitHub API call.
- Store any credential or private key. `accessPolicy` on a registry entry may
  only ever hold non-secret metadata (e.g. a GitHub App installation id).
- Choose between multiple candidate repositories on its own. A human always
  confirms, even when only one candidate exists (decision D2).

## The registry: `repositoryRegistry`

One document per repository mapping. `_id` is an ObjectId, used only for
admin CRUD addressing; `repositoryId` is a separate, operator-chosen stable
name and is deliberately **not** the primary key, because the same
repository can legitimately be mapped into more than one project (a shared
or mono-repo serving several Neutara spaces).

| Field | Notes |
| --- | --- |
| `projectIdentifier` | Neutara's `spaceKey`. A lookup key only, never itself a source of authorization. |
| `repositoryId` | Operator-chosen stable name. Unique only among *active* rows for the same `projectIdentifier` (a partial unique index — see below). |
| `repositoryUrl` | Must match `https://github.com/<org>/<repo>[.git]`. SSH URLs are rejected — see Known limitations. |
| `defaultBranch` | Must be covered by `allowedBranches`. |
| `allowedBranches` | Exact names (`main`) or a single trailing wildcard pattern (`feature/*`) — see Branch rules below. At least one entry required. |
| `status` | `active` \| `inactive`. |
| `accessPolicy` | Non-secret GitHub App metadata only, or `null`. Enforced by convention and code review, not by the schema. |
| `createdBy` / `updatedBy` | `operator:<name>` — see Authorization below. |

**Uniqueness.** A partial unique index on `(projectIdentifier, repositoryId)`,
scoped to `status: 'active'`, prevents the same repository from being
registered twice as the active mapping for the same project, while still
allowing two genuinely different repositories to be active for one project
at once (the legitimate "multiple matches → ambiguous" case decision D6
requires) and allowing the same repository to be active for two different
projects.

### Branch rules

A deliberately narrow grammar: an exact name (`main`, `release/1.0`), or a
prefix followed by a single trailing `/*` wildcard segment (`feature/*`,
`bugfix/*`). This is the shape the business decision named, not an inference
about what git or GitHub itself supports — see
`isValidBranchName`/`isValidBranchPattern` in
[`src/repository-registry/repository.ts`](../src/repository-registry/repository.ts).

## The selection: `repositorySelections`

One document per run (unique on `runId`), created and updated by the
matching worker, and finalized only by a human.

| Field | Notes |
| --- | --- |
| `candidateRepositoryIds` | The `repositoryId`s found active for this project at the time of the last match attempt. |
| `status` | `pending` \| `selected` \| `failed` \| `ambiguous`. Independent of `runs.status` and `intakeItems.status` — never overloaded onto either, matching this codebase's existing state-machine separation. |
| `selected*` fields | A **snapshot** taken at confirmation time. Never re-read from `repositoryRegistry` afterwards — a later edit to the registry entry does not retroactively change what an already-confirmed run will use. |
| `failureReason` | Set when `status` is `failed`. |
| `attempts` / `nextAttemptAt` | Retry bookkeeping for `failed`/`ambiguous` rows, same shape as `webhookDeliveries`. |
| `confirmedBy` / `confirmedAt` | Set only by a human confirmation. |
| `lastNotifiedStatus` | Dedupes the notification audit entry — see Notifications below. |

### Lifecycle

```
queued run, no selection yet
        │
        ▼
   match attempt ── 0 candidates ──────────► failed ──┐
        │                                              │ retry (backoff)
        ├── 1 candidate ──────────────────► pending    │
        │                                     │        │
        └── 2+ candidates ───────────────────►│        │
                                          ambiguous ◄───┘
                                               │
                              human confirms (pending or ambiguous only)
                                               │
                                               ▼
                                            selected
```

- **`pending` is not skipped for a single match.** Decision D2 is explicit:
  human confirmation is always required, even when exactly one active
  repository matches. The matching worker never sets `status: 'selected'`;
  only [`confirm()`](../src/repository-selection/repository.ts) does.
- **A `pending` row is never automatically re-matched.** Once a single
  candidate exists, the outstanding step is a human confirmation, not
  another match attempt — decision D6 only calls out retrying "no match or
  multiple matches." See Known limitations.
- **`failed` and `ambiguous` rows retry automatically**, with exponential
  backoff (1 minute, doubling, capped at 1 hour — same shape as the
  enrichment worker's backoff), so a registry change (an admin adding the
  missing mapping, or deactivating one of several ambiguous ones) is picked
  up without operator intervention.
- **A confirmation is always re-checked against the CURRENT registry**, not
  against the selection's own (possibly stale) `candidateRepositoryIds`. The
  API handler looks up the chosen `repositoryId` among the project's
  currently-active entries and snapshots from there. `confirm()` itself still
  refuses a `repositoryId` that was never among the row's own candidates, so
  this cannot be used to slip in a repository the matching pass never
  offered.

### Notifications

Decision D6 requires that an unresolved selection (`failed` or `ambiguous`)
create "an auditable notification event for an authorized person." This is a
plain [`auditLog`](../src/db/audit-log.ts) entry
(`action: 'repository-selection.notification'`), not a new mechanism —
consistent with how the rest of this codebase treats state changes worth
surfacing. `lastNotifiedStatus` gates it: a retry that lands on the same
unresolved outcome does not re-notify; only a genuine transition into (or
between) `failed` and `ambiguous` does. A `pending` selection is never
notified — it is expected, visible state, not a problem.

## Authorization

**Known limitation, stated up front.** The task's business decision asked
for "administrators and authorized team members" to manage mappings
"according to their permissions, reusing the existing authentication and
authorization mechanisms." The existing mechanism
([`verifyOperatorToken`](../src/api/operator-auth.ts)) is a single shared
bearer secret (`OPERATOR_TOKEN`) with no role or permission concept at all —
there is no "administrator" distinct from "team member" anywhere in this
codebase. Rather than invent a new role system unasked, every endpoint below
reuses that exact mechanism: any caller holding the operator token may
perform any of these operations. The free-text `operator` field in each
request body (turned into `operator:<name>`) is for audit attribution only,
never for authorization. Introducing real per-person roles is follow-up work
if this limitation is not acceptable.

## API

All endpoints require `Authorization: Bearer <OPERATOR_TOKEN>`. A missing or
wrong token answers `401` before the body is read. A body's `operator` field
becomes `operator:<name>` in `createdBy`/`updatedBy`/`confirmedBy` and in the
audit trail.

### Registry management (`src/api/repository-registry.ts`)

| Route | Body | Notes |
| --- | --- | --- |
| `POST /repository-registry` | `{ projectIdentifier, repositoryId, repositoryUrl, defaultBranch, allowedBranches, accessPolicy?, operator }` | Creates an active entry. `409` on a duplicate active mapping. |
| `GET /repository-registry?projectIdentifier=&status=` | — | Lists entries, optionally filtered. |
| `GET /repository-registry/:id` | — | `:id` is the entry's ObjectId hex. |
| `PATCH /repository-registry/:id` | `{ repositoryUrl?, defaultBranch?, allowedBranches?, accessPolicy?, operator }` | Partial update; the merged shape is re-validated. |
| `POST /repository-registry/:id/deactivate` | `{ operator }` | Sets `status: 'inactive'`. |
| `POST /repository-registry/:id/reactivate` | `{ operator }` | Sets `status: 'active'`. `409` if it would collide with the partial unique index. |

### Confirmation (`src/api/repository-selection.ts`)

| Route | Body | Notes |
| --- | --- | --- |
| `POST /repository-selections/:runId/confirm` | `{ repositoryId, operator, reason? }` | Only valid from `pending` or `ambiguous`. `404` if no selection exists for the run; `409` if the row is not confirmable, or if `repositoryId` is not currently an active mapping for the project; `400` if `repositoryId` was never among the row's candidates. |

## Configuration

No new environment variables. Both the registry and the matching loop reuse
`OPERATOR_TOKEN` and the existing MongoDB connection — see
[`src/index.ts`](../src/index.ts). The matching loop polls every 30 seconds
(`DEFAULT_INTERVAL_MS` in
[`src/repository-selection/scheduler.ts`](../src/repository-selection/scheduler.ts)),
the same order of magnitude as the orchestrator and enrichment loops.

## Atlas grants

`repositoryRegistry` and `repositorySelections` are new collections and are
**not yet granted** on either the live test role (`aisdlcTestAppRole`) or the
production role (`aisdlcAppRole`) — confirmed missing by running the service
locally against `aisdlc_test`; see
[`docs/atlas-roles.md`](atlas-roles.md#test-database-and-roles) for the
error observed and the draft privilege blocks to apply.

## Known limitations / follow-up before the Coding Agent

1. **Authorization is a single shared operator token**, not per-person roles
   — see Authorization above.
2. **GitHub App integration is not implemented.** `accessPolicy` exists as a
   schema placeholder only; no credential is stored or used anywhere in this
   phase.
3. **SSH repository URLs are rejected.** Only `https://github.com/...` is
   accepted.
4. **A `pending` selection is never re-matched.** If the registry becomes
   ambiguous for a project *after* a run's selection already settled into
   `pending`, that row will not automatically flip to `ambiguous` — a human
   could confirm it against what is now a stale single-candidate view. The
   confirmation endpoint still re-checks the chosen `repositoryId` against
   the registry's current active state, which prevents confirming a
   *deactivated* repository, but it does not detect that a *second* active
   repository has since appeared.
5. **Atlas grants are not yet applied** to either environment — see above.
6. **The branch-pattern grammar is narrow by design** (exact name, or a
   single trailing `/*`), not general globbing.
