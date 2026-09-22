# Atlas users, roles, and audit-log protection

Two database users, two custom roles, one purpose: the running service must
not be able to alter the record of what it did.

> **Status: enforced.** Custom roles are applied on this cluster and verified
> against it. `auditLog` is append-only **at the database layer** — the server
> refuses an update or delete from the service credential. The application
> guard in `src/db/audit-log.ts` is defence in depth on top of that.
>
> An earlier revision of this document stated that database-level enforcement
> was unavailable on M0 and that protection was application-level only. That
> was wrong. The live grants below were read back from the cluster with
> `connectionStatus: { showPrivileges: true }`.

## The two users

| | `aisdlc_app` | `aisdlc_migrator` |
| --- | --- | --- |
| Used by | the running service | `npm run db:init`, once per deploy |
| Env var | `AISDLC_MONGODB_URI` | `AISDLC_MONGODB_MIGRATION_URI` |
| Loaded by the service process | yes | **never** |
| Role | `aisdlcAppRole` | `aisdlcMigratorRole` |
| Can create collections / indexes / validators | **no** | yes |
| Can write documents | yes | **no** |
| Can modify `auditLog` entries | **no** | **no** |
| Can drop a collection | **no** | **no** |

Both are created in the `admin` database, so connection strings need
`authSource=admin`. Note that a URI ending `/aisdlc` without an explicit
`authSource` authenticates against `aisdlc` and fails — the defaultauthdb
becomes the authSource. Keep `authSource=admin` in both strings.

`src/config/env.ts` refuses to start if the two URIs are identical.

## The live grants

Read back from the cluster, not aspirational:

```
aisdlcAppRole
  aisdlc.auditLog           find insert
  aisdlc.webhookDeliveries  find insert remove update
  aisdlc.intakeItems        find insert remove update
  aisdlc.runs               find insert remove update
  aisdlc.runArtifacts       find insert remove update
  aisdlc.checkpoints        find insert remove update
  aisdlc.outboundWrites     find insert remove update
  aisdlc.*                  listCollections listIndexes

aisdlcMigratorRole
  aisdlc.*                  collMod createCollection createIndex dropIndex
                            find listCollections listIndexes
```

What each deliberately lacks:

- **`aisdlcAppRole` has no `update` or `remove` on `auditLog`**, and no DDL
  anywhere — no `createCollection`, `createIndex`, `collMod`, `dropIndex` or
  `dropCollection`. The service cannot weaken a validator or rebuild an index.
- **`aisdlcMigratorRole` has no `insert`, `update` or `remove`.** It can shape
  the schema but cannot write, alter or forge data, and cannot drop a
  collection. A bug in the setup script cannot destroy the audit log.

Neither role can `dropCollection`, so neither can drop `auditLog` and recreate
it without a validator.

**MongoDB privileges are additive — there are no deny rules.** Every
collection is enumerated individually in `aisdlcAppRole`, which is what makes
the `auditLog` exception possible. The maintenance consequence: **adding a
collection means editing the role.** Until you do, the service has no access
to it at all. That is the right direction to fail, but it belongs on the
deploy checklist.

## How `auditLog` stays append-only

Three layers, ordered by how much each guarantees.

**Layer 1 — Role privileges. This is the enforcement.** `aisdlcAppRole` grants
`find` and `insert` and nothing else, so `updateOne` or `deleteMany` from the
service fails at the server with *"user is not allowed to do action [update]
on [aisdlc.auditLog]"*. This holds even against a compromised service, and
against anyone holding the app connection string. Two integration tests assert
it directly.

**Layer 2 — Application guard. Defence in depth.** `src/db/audit-log.ts`
exposes `append()` and `query()` only, and `guardAuditCollection()` throws
`AuditLogMutationError` on thirteen mutating methods. This turns a mistake
into a compile error or a local throw rather than a round trip that comes back
`Unauthorized`. It is not what provides the guarantee; it makes the guarantee
cheap to respect.

**Layer 3 — The validator, protected.** `$jsonSchema` constrains the shape of
inserts. The service cannot `collMod` it away, because that privilege belongs
to the migrator, whose credential the service never loads.

### What is still not covered

- **Anyone holding the `aisdlc_migrator` credential** can `collMod` the
  validator, though not write or delete data.
- **Any Atlas project owner** can change roles or delete anything. No
  in-database control defends against the account owner.
- **Tampering is prevented, not detected.** If someone with sufficient
  privileges does alter history, nothing in the current design reveals it.
  See D4 below.

So the accurate statement is:

> `auditLog` is append-only for the service: the database refuses updates and
> deletes from the application credential, and the application contains no
> code path that attempts one.

That is a real control and safe to describe as enforced. It is still not
"the audit log cannot be altered by anyone".

### Decision D4 — hash chaining, deferred

D4 deferred hash chaining on the basis that role privileges stop the service
and chaining would only add protection against a privileged insider. **That
basis holds.** The grants above are in place and verified, so chaining remains
an insider-tamper-evidence measure rather than the primary control.

(For a period this repository documented the cluster as having no custom
roles, which would have invalidated that reasoning. It does have them, so D4
stands as originally decided.)

If it is ever adopted: each entry stores `prevHash`, with
`hash = sha256(prevHash + canonicalJson(entry))`, making tampering detectable
by a verifier pass. `append()` is deliberately the single write path, so this
is a contained change to one function. Cost: appends serialize on reading the
chain head, plus a periodic verification job.

**Explicitly rejected: capped collections.** They forbid deletes but permit
in-place updates, and silently overwrite the oldest entries when full.

## Verifying the roles

`npm run test:integration` asserts all of this against the live cluster:

- schema changes over the application connection are refused
- `updateOne` and `deleteOne` on `auditLog` are refused by the server
- the application guard throws before reaching the wire
- validators reject malformed documents server-side

To check by hand, connect as `aisdlc_app` and confirm each of these fails:

```js
db.auditLog.updateOne({}, { $set: { actor: "someone-else" } });   // Unauthorized
db.auditLog.deleteOne({});                                        // Unauthorized
db.runCommand({ collMod: "auditLog", validator: {} });            // Unauthorized
db.webhookDeliveries.createIndex({ probe: 1 });                   // Unauthorized
```

And as `aisdlc_migrator`:

```js
db.auditLog.insertOne({ actor: "x" });   // Unauthorized — migrator cannot write
db.runCommand({ drop: "auditLog" });     // Unauthorized — no dropCollection
```

To inspect the live grants:

```js
db.getSiblingDB("admin").runCommand({ connectionStatus: 1, showPrivileges: true });
```

## Test database and roles

Integration tests refuse to run against the production database. They require
`AISDLC_TEST_DATABASE`, set explicitly to something other than `aisdlc`, and
skip otherwise — there is no fallback, because the failure mode of one here is
silent writes to live data.

The **running service** has the same shape of guarantee, added later and
separately: outside production, `src/config/env.ts`'s `resolveRuntimeMongoUri`
requires `AISDLC_TEST_MONGODB_URI` and refuses to start if it would
authenticate as the same identity as `AISDLC_MONGODB_URI` (`aisdlc_app`) —
whether byte-identical or merely sharing a username. Before this existed, the
service always authenticated as `aisdlc_app` regardless of which database
`AISDLC_DATABASE_NAME` pointed it at, which is exactly what produced:

```
user is not allowed to do action [find] on [aisdlc_test.webhookDeliveries]
user is not allowed to do action [insert] on [aisdlc_test.webhookDeliveries]
```

during a local end-to-end test — `aisdlc_app`'s role grants nothing on
`aisdlc_test`, by design (see above), and there was no code path for the
service to use a different credential.

**Current provisioning status, as verified against the live cluster in this
project so far:**

- `aisdlcTestMigratorRole` / the test migrator user — **confirmed live**.
  `npm run db:init:test` has successfully created collections, validators and
  indexes in `aisdlc_test` using it.
- `aisdlcTestAppRole` / the dedicated test application user (`aisdlc-test-app`)
  — **confirmed live for `intakeItems`, `webhookDeliveries` and `auditLog`.**
  A full local webhook-ingestion-to-enrichment run succeeded end to end
  through this identity: `find`/`insert`/`update` on `webhookDeliveries`,
  `find`/`insert` on `intakeItems`, and the audit-log appends all worked.
- **`requirementsAnalyses` — confirmed MISSING**, not merely unconfirmed.
  `npm run requirements:run` against this identity fails with:

  ```
  user is not allowed to do action [find] on [aisdlc_test.requirementsAnalyses]
  ```

  `requirementsAnalyses` is a collection added after `aisdlcTestAppRole` was
  first drafted (for the Requirements Agent). Collection grants in this
  project are enumerated explicitly per collection (see "What each
  deliberately lacks" above), so a role never automatically gains access to a
  collection created after it was defined — this needs the privilege block
  below added to the LIVE role in the Atlas console; it is already correct in
  this document, just not yet applied to the cluster. The equivalent gap
  exists on production `aisdlcAppRole` too (unrelated to test), noted
  separately above.
- **`runs` (orchestrator) — status unknown, not yet exercised against the
  live cluster.** Unlike `requirementsAnalyses`, `runs` was already present
  in this draft from the original Phase 0 scaffolding (before
  `requirementsAnalyses` existed), so it may already be granted on the live
  role — but nothing has actually read or written it yet to confirm either
  way. Running the orchestrator locally for the first time (`npm run dev`
  against `aisdlc_test` with an approved intake item present) will settle
  it: if the grant is missing, expect the same `user is not allowed to do
  action [...] on [aisdlc_test.runs]` shape of error, surfaced in the
  service log as `"orchestrator pass failed"` rather than crashing the
  process (the loop swallows a failing pass and retries next tick — see
  src/orchestrator/scheduler.ts).
- **`repositoryRegistry` and `repositorySelections` — granted and confirmed
  live, `remove` deliberately excluded.** Originally confirmed MISSING
  entirely (`npm run dev` against `aisdlc_test` failed with `user is not
  allowed to do action [find] on [aisdlc_test.repositorySelections]`,
  surfaced as `"repository selection matching pass failed"` rather than
  crashing the process). `aisdlcTestAppRole` has since been updated. A
  `connectionStatus`/`showPrivileges` probe against the live cluster with the
  `aisdlc-test-app` credential shows

  ```
  aisdlc_test.repositoryRegistry     find insert update
  aisdlc_test.repositorySelections   find insert update
  ```

  `npm run test:integration` confirms this is exactly right for the
  application's needs: registry creation, lookup, duplicate-mapping
  rejection, selection matching, human confirmation, and audit-log queries
  all pass end to end against the live cluster, and the draft below has been
  updated to match this live grant (no `remove`, unlike every other data
  collection in the draft). **`remove` is intentionally not granted here** —
  nothing in the application ever deletes a `repositoryRegistry` or
  `repositorySelections` document (deactivation is a status flip, not a
  delete), so there is no product reason to widen this credential, and doing
  so "to make test cleanup easier" is exactly the shortcut this project's
  least-privilege discipline exists to refuse. Test-only cleanup instead uses
  either a separate, narrower, delete-only credential (see "Optional: a
  dedicated test-cleanup credential" below) or reports its own leftover rows
  without deleting them — see the header comment in
  `src/repository-selection/workflow.integration.test.ts`. The same
  narrower-than-usual grant is worth applying to production `aisdlcAppRole`
  too, once it adds these two collections to "The live grants" above.

If any of the above turns out not to be provisioned, create the role as
drafted below.

The test database is **`aisdlc_test`**. Create two roles and two users,
mirroring the production pair but scoped to it. In Atlas: **Database Access →
Custom Roles → Add New Custom Role**, then **Database Users → Add New
Database User** with the matching custom role.

```js
// aisdlcTestAppRole — mirrors aisdlcAppRole, scoped to aisdlc_test.
// auditLog stays find+insert so the append-only tests remain meaningful.
{
  role: "aisdlcTestAppRole",
  privileges: [
    { resource: { db: "aisdlc_test", collection: "intakeItems" },
      actions: ["find", "insert", "update", "remove"] },
    { resource: { db: "aisdlc_test", collection: "runs" },
      actions: ["find", "insert", "update", "remove"] },
    { resource: { db: "aisdlc_test", collection: "runArtifacts" },
      actions: ["find", "insert", "update", "remove"] },
    { resource: { db: "aisdlc_test", collection: "checkpoints" },
      actions: ["find", "insert", "update", "remove"] },
    { resource: { db: "aisdlc_test", collection: "outboundWrites" },
      actions: ["find", "insert", "update", "remove"] },
    { resource: { db: "aisdlc_test", collection: "webhookDeliveries" },
      actions: ["find", "insert", "update", "remove"] },
    { resource: { db: "aisdlc_test", collection: "requirementsAnalyses" },
      actions: ["find", "insert", "update", "remove"] },
    { resource: { db: "aisdlc_test", collection: "repositoryRegistry" },
      actions: ["find", "insert", "update"] },
    { resource: { db: "aisdlc_test", collection: "repositorySelections" },
      actions: ["find", "insert", "update"] },
    { resource: { db: "aisdlc_test", collection: "auditLog" },
      actions: ["find", "insert"] },
    { resource: { db: "aisdlc_test", collection: "" },
      actions: ["listCollections", "listIndexes"] }
  ],
  roles: []
}

// aisdlcTestMigratorRole — mirrors aisdlcMigratorRole, plus dropDatabase.
{
  role: "aisdlcTestMigratorRole",
  privileges: [
    { resource: { db: "aisdlc_test", collection: "" },
      actions: [
        "collMod", "createCollection", "createIndex", "dropIndex",
        "dropCollection", "dropDatabase",
        "find", "listCollections", "listIndexes"
      ] }
  ],
  roles: []
}
```

Then add three variables to `.env`. They are **separate from** the production
pair, which stays exactly as it is:

```
AISDLC_TEST_DATABASE=aisdlc_test
AISDLC_TEST_MONGODB_URI=<test app user>
AISDLC_TEST_MONGODB_MIGRATION_URI=<test migration user>
```

The integration suite reads only these three, plus one optional fourth
variable described next. It reads no production variable, and there is no
fallback to one — so a test run cannot authenticate as `aisdlc_app` or
`aisdlc_migrator` even when those credentials are loaded in the same
environment. `src/intake/integration-config.ts` is the single place that
resolves all of them, and offline tests in `src/intake/integration-config.test.ts`
assert statically that no production variable is referenced there or in
either integration test file.

### Optional: a dedicated test-cleanup credential

`repositoryRegistry` and `repositorySelections` deliberately do not grant
`remove` to `aisdlcTestAppRole` — see above. That means
`src/repository-selection/workflow.integration.test.ts` cannot delete its own
`ITEST-`-namespaced rows using the application credential. By default it
doesn't try to widen that credential; it reports the leftover rows instead
(by collection and count, in its `after()` hook) and moves on. Every row is
namespaced with a fresh run id, so this is a data-hygiene inconvenience, not
a correctness problem — a later run never collides with what an earlier one
left behind.

If you want the suite to fully clean up after itself, provision a THIRD,
narrower identity — `remove` only, only on the four collections this suite
writes test rows into, and **never `auditLog`**:

```js
// aisdlcTestCleanupRole — remove-only, and only on the collections
// src/repository-selection/workflow.integration.test.ts writes test rows
// into. Deliberately excludes auditLog: that collection has no cleanup
// path, by design, for any credential.
{
  role: "aisdlcTestCleanupRole",
  privileges: [
    { resource: { db: "aisdlc_test", collection: "repositoryRegistry" },
      actions: ["remove"] },
    { resource: { db: "aisdlc_test", collection: "repositorySelections" },
      actions: ["remove"] },
    { resource: { db: "aisdlc_test", collection: "runs" },
      actions: ["remove"] },
    { resource: { db: "aisdlc_test", collection: "intakeItems" },
      actions: ["remove"] }
  ],
  roles: []
}
```

This role cannot `find`, so a user holding only it cannot read data, only
delete documents it is separately told to target — the test still uses the
application credential's `find` to decide and report what remains. Create a
matching database user (e.g. `aisdlc-test-cleanup`) and add:

```
AISDLC_TEST_CLEANUP_MONGODB_URI=<test cleanup user>
```

This variable is **entirely optional**. Its absence never blocks the suite —
`resolveIntegrationConfig` treats it exactly like a missing optional field,
never like a missing required one. When present, `workflow.integration.test.ts`
opens a third connection with it in `before()`, verifies (the same way as
every other connection in this file) that it did not somehow resolve to the
production database, and uses it in `after()` instead of the application
credential.

Two deliberate differences from production:

- **Grant `dropDatabase` to the test migrator.** It is what makes cleanup
  possible, and it is the reason this must not be the production database —
  the production migrator must never hold it.
- **Do not extend the production roles to cover the test database.** It would
  be the quickest route and it silently widens the production credential.

Once provisioned, `after()` can drop the test database wholesale, which also
resolves the audit-row accumulation described below.

### If CI integration tests are required

Prefer a **separate cluster in a separate project**, not just a separate
database. The deciding factor is the IP allowlist: GitHub-hosted runners have
dynamic egress IPs, so CI access means allowlisting `0.0.0.0/0`. That is
acceptable for a disposable test cluster and not acceptable for the cluster
holding real intake data. On one cluster they share an allowlist, so CI forces
a choice between no integration tests and an internet-exposed production
database.

Other CI notes: credentials as repository secrets; do not run integration
tests on pull requests from forks; run `db:init` against the test target in CI
setup so schema drift surfaces as a test failure; keep the offline suite as
the required check on every PR.

## Test data in `auditLog`

Integration runs append entries namespaced `ITEST-<runId>-*`. **Neither
credential can delete them**, so they stay in the cluster permanently. This is
correct — an append-only log has no cleanup path — but it means the collection
accumulates test rows over time. Pruning requires a privileged operator
acting deliberately, which is the only way it should be possible.
