# aisdlc-service

Intake, human approval gate and pipeline runtime for AISDLC.

Status: **Phase 0** — infrastructure and service skeleton. The health API,
configuration, logging and MongoDB modules exist; ingest, approval and the
pipeline arrive in later phases.

## Requirements

- Node.js **22.6 or newer** (`node --version`). The test suite and `npm run dev`
  run TypeScript directly via Node's type stripping, which needs 22.6+.
- A MongoDB **Atlas** cluster with the two custom roles applied (see
  [docs/atlas-roles.md](docs/atlas-roles.md)). There is no local MongoDB or
  Docker setup, by design. On a free-tier cluster, keep an eye on the 512 MB
  storage limit — `webhookDeliveries` stores raw payloads and is the
  collection most likely to grow, which is what its 90-day TTL is for.

## Setup

```bash
npm install
cp .env.example .env    # Windows: copy .env.example .env
```

Then open `.env` and fill in the values. `.env` is gitignored and must stay
that way — it is the only place credentials live. Never put a real value in
`.env.example`, in this README, or anywhere in `src/`.

For Phase 0 you only need the first group:

| Variable | What it is |
| --- | --- |
| `AISDLC_MONGODB_URI` | Atlas SRV string for the least-privilege application user (`aisdlc_app`) |
| `AISDLC_PORT` | Port the HTTP server binds |
| `NODE_ENV` | `development`, `test` or `production` |

`AISDLC_MONGODB_MIGRATION_URI` (the `aisdlc_migrator` user) is needed only to
run the one-off database setup below. The service process never loads it, so a
compromised service cannot alter the audit-log validator.

These must be **two different Atlas users**. The service refuses to start if
the two URIs are identical, because collapsing them silently gives the service
the migrator's privileges.

Each holds a **custom role** — `aisdlcAppRole` for the service (data access,
no DDL, and `auditLog` restricted to `find`+`insert`) and `aisdlcMigratorRole`
for setup (DDL only, no data writes). Both users live in the `admin` database,
so **both connection strings need `authSource=admin`**; a URI ending
`/aisdlc` without it authenticates against the wrong database and fails with
`bad auth`. See [docs/atlas-roles.md](docs/atlas-roles.md) for the live grants
and what they do and do not protect.

The remaining variables in `.env.example` belong to Phases 3–7 and can stay
empty until then.

### Getting the Atlas connection string

In the Atlas UI: **Database → Connect → Drivers**, then copy the `mongodb+srv://`
string and substitute the `aisdlc_app` user's password. Add your current IP
under **Network Access → IP Access List**, or connection attempts will hang
until the server-selection timeout and then fail.

The database name is fixed to `aisdlc` in code; the URI supplies the cluster.

## Commands

| Command | What it does |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` over `src/` |
| `npm test` | Unit tests. No database or network required. |
| `npm run build` | Compiles to `dist/` (tests excluded) |
| `npm run dev` | Runs from source with `--watch` |
| `npm start` | Runs the compiled build from `dist/` |
| `npm run db:init` | One-off: creates collections, indexes and validators |

`npm run db:init` uses the migration URI and is idempotent — every index is
explicitly named, so a second run changes nothing. Run it once per environment
before first start.

## Health

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Liveness. Never touches the database. Always 200 while the process is up. |
| `GET /health/ready` | Readiness. Pings MongoDB. 200 when reachable, 503 otherwise. |

```console
$ curl localhost:8090/health
{"status":"ok","service":"aisdlc-service","version":"0.1.0","uptimeSeconds":12}

$ curl localhost:8090/health/ready
{"status":"degraded", ... ,"dependencies":{"database":"not_configured"}}
```

`database` reports:

| Value | Meaning |
| --- | --- |
| `ok` | reachable; readiness returns 200 |
| `connecting` | configured, not yet connected — still retrying with backoff |
| `unavailable` | connected but the ping failed, or the manager was stopped |
| `not_configured` | no database wired up at all |

A failed database connection does not stop the process from serving — it
reports itself unready and **keeps retrying in the background** with
exponential backoff capped at 30s. State is re-read on every probe, so an
instance that lost its database recovers on its own once the database returns;
no restart is needed. The readiness ping is bounded at 2s so it always answers
inside a typical probe deadline.

## Approval gate

| Endpoint | Purpose |
| --- | --- |
| `POST /intake/:issueKey/approve` | Approves an intake item currently `pending_approval`. |
| `POST /intake/:issueKey/reject` | Rejects it instead. |

Both require `Authorization: Bearer <OPERATOR_TOKEN>` and a JSON body naming
the operator: `{"operator": "jane", "reason": "optional"}`. `OPERATOR_TOKEN`
proves the caller may act as an operator; `operator` in the body is who,
recorded in the audit trail as `operator:jane` — never a service identity,
so a pipeline cannot approve its own work. Unset `OPERATOR_TOKEN` behaves
like an unset `NEUTARA_WEBHOOK_SECRET`: the routes stay mounted and answer
`401` to everything rather than the service refusing to start.

```console
$ curl -X POST localhost:8090/intake/CF-33261/approve \
    -H "Authorization: Bearer $OPERATOR_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"operator": "jane"}'
{"issueKey":"CF-33261","status":"approved","approvedBy":"operator:jane","approvedAt":"...","statusReason":null}
```

| Status | Meaning |
| --- | --- |
| `200` | approved or rejected |
| `401` | missing/wrong token, or `OPERATOR_TOKEN` unset |
| `400` | malformed body, or missing/blank `operator` |
| `404` | no intake item for that `issueKey` |
| `409` | not currently `pending_approval`, or it changed mid-request — read it again and retry |
| `503` | database unreachable |

## Configuration behaviour

Every variable is read with **no literal fallback**. A missing or malformed one
aborts startup with exit code 78 (`EX_CONFIG`) and a message naming the
variable — never its value:

```console
$ npm start
{"level":"error","msg":"startup aborted: invalid configuration","variables":["AISDLC_MONGODB_URI"], ...}
```

All faults are reported at once, so a fresh checkout sees the full list rather
than one variable per attempt. An empty or whitespace-only value counts as
missing.

### Neutara integration: mock vs real

`NEUTARA_API_BASE_URL` alone switches enrichment between a local mock
server (`npm run mock:neutara`, loopback host) and a real Neutara
test/staging origin — no code change, no other variable, ever required.
Startup logs which mode is active (`neutara integration enabled in
MOCK/REAL mode`), never the base URL or token value. **Never switches
automatically.** See
[docs/neutara-integration-modes.md](docs/neutara-integration-modes.md) for
the exact variables each mode needs and what switching does and does not
do (in particular: it does not make this service reachable by a real
Neutara webhook).

## Logging

One JSON object per line on stdout. Every field is redacted on the way out:
fields whose name looks secret (`password`, `token`, `uri`, `authorization`, …)
are blanked, and connection strings, `sk-ant-*`, `nta_*` and AWS key shapes are
stripped from free text as well. `redactUri` keeps the host and database but
removes the credentials, so a connection failure is still debuggable.

## Layout

```
src/
  config/env.ts        strict environment validation (pure, testable)
  db/client.ts         Atlas connection; connects only when called
  db/collections.ts    collection names, index specs, validators
  db/audit-log.ts      the only supported way to touch auditLog
  db/indexes.ts        idempotent collection + index setup
  api/health.ts        liveness and readiness payloads
  api/approval.ts      the human approval gate (approve/reject)
  api/operator-auth.ts bearer-token verification for the approval gate
  api/run-status.ts     GET /runs/:runId — the composed end-to-end status view
  api/coding-agent.ts    POST /runs/:runId/coding-agent — triggers the Coding Agent
  api/change-review.ts   POST /change-reviews/:reviewId/approve|reject
  api/server.ts        node:http server and routing
  logging/logger.ts    structured JSON logging with redaction
  scripts/init-indexes.ts   one-off database setup (migration user)
  repository-registry/  authorized project → GitHub repository mappings
  api/repository-ui.ts  GET /repositories — static admin page for the Repository Registry (no new business logic)
  repository-selection/ matches a run to a registry entry; human confirmation
  requirements/queue.ts, requirements/scheduler.ts   runs the Requirements Agent for every received intake item
  github-app/            GitHub App auth (JWT, installation tokens) + client
  github-access/service.ts  validates a run and reads its confirmed repository's files
  coding-agent/          analyzes requirements + repository content, proposes changes (read-only)
  change-execution/      human review of proposed changes; applies ONLY approved changes to a local working copy, then validates
  github-publish/        publishes an approved, executed, validated change: branch, commit, push, pull request (no merge)
  deployment/            detects a human PR merge (read-only), then deployment + post-deployment validation behind a mock provider
  api/deployment-status.ts  GET /runs/:runId/deployment — the detailed deployment record
  pipeline/              wires everything above into one end-to-end workflow: run-status view, Coding Agent trigger, change-execution/publish/merge-detection/deployment queue workers
  index.ts             entrypoint
```

## Collections

| Collection | Purpose | Key constraints |
| --- | --- | --- |
| `webhookDeliveries` | raw inbound payloads | unique `deliveryId`; **90-day TTL** |
| `intakeItems` | one row per ingested issue | unique `issueKey` |
| `runs` | pipeline executions | — |
| `runArtifacts` | outputs produced by a run | — |
| `checkpoints` | per-step progress, for resume | unique `(runId, step)` |
| `outboundWrites` | outbox for writes back to Neutara | unique `idempotencyKey`; no TTL |
| `auditLog` | record of every state change | append-only, enforced by role grants (see below) |

`checkpoints`, `outboundWrites` and `auditLog` carry strict `$jsonSchema`
validators enforcing their status vocabularies server-side. Internal
references are `ObjectId` throughout; `issueKey` and `deliveryId` stay strings
because their format belongs to the upstream system.

Two invariants worth knowing before touching this code:

- A checkpoint is only reused on resume when its `inputHash` still matches.
  If the intake item changed, the checkpoint is invalidated rather than
  silently producing results derived from stale input.
- The outbound drain worker **refuses any row where `approvedBy` is null**.
  That refusal is what makes the human approval gate real; the schema permits
  a null so a row can be enqueued before approval, but never sent.
- **An approved intake item must name a human operator.** `approvedBy` must
  carry the `operator:` prefix; a service identity is refused. Enforced twice
  — by the repository before any write, and by the database for any writer
  holding the app credential. There is no fallback to the acting identity:
  an earlier version defaulted `approvedBy` to `actor`, which meant a worker
  could record itself as approver and the outbound null-check above could
  never fire.

### `auditLog` — append-only, enforced by the database

Custom roles are applied on this cluster and verified against it.
`aisdlcAppRole` grants `find` and `insert` on `auditLog` **and nothing else**,
so an update or delete from the service is refused by the server:

```
user is not allowed to do action [update] on [aisdlc.auditLog]
```

Layered on top as defence in depth, [src/db/audit-log.ts](src/db/audit-log.ts):

- `createAuditLog()` exposes exactly `append()` and `query()`, so attempting a
  mutation is a compile error.
- `guardAuditCollection()` wraps the driver's `Collection` in a Proxy throwing
  `AuditLogMutationError` on all thirteen mutating methods, catching mistakes
  locally rather than as a round trip that returns `Unauthorized`.
- The `$jsonSchema` validator constrains insert shape, and the service cannot
  `collMod` it away — that privilege belongs to the migrator, whose credential
  the service never loads.

**Always write audit entries through `createAuditLog()`.** Calling
`db.collection('auditLog')` directly skips the guard and fails at the server
instead.

The property, stated accurately:

> `auditLog` is append-only for the service: the database refuses updates and
> deletes from the application credential, and the application contains no
> code path that attempts one.

It is still not "the audit log cannot be altered by anyone" — an Atlas project
owner can change roles or delete anything, and tampering is prevented rather
than *detected* (decision D4). [docs/atlas-roles.md](docs/atlas-roles.md) has
the live grants, the residual risks and the verification commands.

## GitHub Access Integration

Connects an approved, human-confirmed run to real repository content:
validates the run/intake/selection chain, then authorizes and reads the
confirmed repository via `github-app/`. **Read-only** — no write, branch,
commit, or pull request exists anywhere in this codebase yet. See
[docs/github-access-integration.md](docs/github-access-integration.md) for
the full workflow, validation rules, error/retry categories, and audit
events.

## Coding Agent

Consumes approved requirements and a confirmed repository's content (via
GitHub Access Integration) and produces a structured implementation plan
and proposed file changes for human review. **Read-only** — nothing here
applies a change, creates a branch, or writes to GitHub. See
[docs/coding-agent.md](docs/coding-agent.md) for the full architecture,
input/output contracts, validation rules, error handling, and the
human-review boundary.

## Human Review → Approved Change Execution

Takes the Coding Agent's proposed changes through a strict human-approval
boundary and, only after explicit approval, applies them to a local,
disposable working copy of the confirmed repository — then validates.
**The Coding Agent must never automatically approve its own changes**;
`ChangeReviewRepository.approve()` refuses any actor that is not a human
operator. See [docs/change-execution.md](docs/change-execution.md) for the
full review model, proposal-integrity guarantees, stale-file detection,
execution safety, and audit events.

## GitHub Write + Pull Request Workflow

Takes a successfully executed, successfully validated, human-approved
change and publishes it: a dedicated `aisdlc/<runId>/<executionId>`
branch off the confirmed base branch, one commit containing exactly the
approved changes, and a pull request. **Pull request merge remains
human-controlled** — nothing in this codebase has a merge method.
Re-verifies the repository/branch/file state live, immediately before
publishing, and never targets the base branch. See
[docs/github-publish.md](docs/github-publish.md) for the full security
boundary, branch/commit/push behavior, idempotency, failure recovery, and
audit events.

## End-to-End Orchestration

Wires every phase above into one controlled pipeline: ticket → requirements
→ human approval → repository selection → human confirmation → Coding
Agent → human change review → local execution → validation → GitHub
branch/commit/push → pull request → **human merge**. Four human gates,
never crossed automatically; `runs.status` is unchanged (five values) —
the detailed stage a run is in is derived, not stored, from the
collections each earlier phase already maintains. See
[docs/end-to-end-orchestration.md](docs/end-to-end-orchestration.md) for
the full lifecycle diagram, state derivation, worker responsibilities,
idempotency, recovery, audit, and the security review.

## Human PR Merge → Deployment → Post-Deployment Validation

**Pull Request merge remains human-controlled. AISDLC detects the merge
but does not perform the merge.** Once a human merges (or closes without
merging) the pull request the previous phase opened, this phase takes
over automatically: detects the merge (read-only), records a deployment as
eligible, deploys it, and runs post-deployment validation — all behind a
`DeploymentProvider` abstraction. **Deployment orchestration is
implemented behind a provider abstraction; real production deployment
remains disabled until the deployment environment is explicitly
configured and verified** — this repository has no Dockerfile, CI/CD
workflow, or cloud-platform configuration to build one from yet, so only a
deterministic mock provider and mock post-deployment validator are wired
up. See [docs/deployment.md](docs/deployment.md) for the full merge
detection, deployment, and post-deployment validation model, idempotency,
failure recovery, audit events, and the security review.

## Repository Management Admin UI

**The Repository Registry backend remains the authoritative source of
repository configuration; this page is only an administrative interface to
that existing system.** `GET /repositories` serves a single, self-contained
HTML/CSS/JS admin page (no build step, no frontend framework) that lets an
authorized administrator view, add, edit, and activate/deactivate
repository registry entries — entirely by calling the pre-existing
`/repository-registry` JSON API from the browser. No second source of
truth, no new authorization mechanism, and no change to the existing
repository selection safety rules (human confirmation, ambiguous-candidate
handling, deactivated repositories being unselectable). See
[docs/repository-management-ui.md](docs/repository-management-ui.md) for
the full route/authorization/audit model and the offline end-to-end
verification.

## Tests

### Integration tests

`npm run test:integration` runs against a real cluster and requires three
variables of its own, **separate from the production pair**:

| Variable | |
| --- | --- |
| `AISDLC_TEST_MONGODB_URI` | test application user |
| `AISDLC_TEST_MONGODB_MIGRATION_URI` | test migration user |
| `AISDLC_TEST_DATABASE` | must be set, and must not be `aisdlc` |

The suite reads **no** production variable and has no fallback to one, so it
cannot authenticate as `aisdlc_app` or `aisdlc_migrator` even when those are
loaded in the same shell. Without the three the suite skips; set
`AISDLC_TEST_DATABASE` to the production name and it refuses, case-insensitively.

The test database and its roles are **not yet provisioned**; see
[docs/atlas-roles.md](docs/atlas-roles.md#test-database-and-roles--not-yet-provisioned).

### Offline tests

`npm test` runs entirely offline. Configuration is tested as a pure function,
and database setup is tested against a recording fake, so no Atlas cluster or
credentials are needed to get a green suite.
