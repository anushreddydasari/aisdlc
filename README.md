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
  api/server.ts        node:http server and routing
  logging/logger.ts    structured JSON logging with redaction
  scripts/init-indexes.ts   one-off database setup (migration user)
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
