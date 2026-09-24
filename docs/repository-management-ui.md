# Repository Management Admin UI

**The Repository Registry backend remains the authoritative source of
repository configuration. This page is only an administrative interface to
that existing system.** It adds no second source of truth, no new
authorization mechanism, and no new business logic — see
[docs/repository-selection.md](repository-selection.md) for everything this
page sits on top of unchanged.

`GET /repositories` serves a single, self-contained HTML/CSS/JS page (no
build step, no framework — this project has never had one) that calls the
pre-existing `/repository-registry` JSON API from the browser. Every rule —
repository URL shape, branch/allowed-branch validation, duplicate-mapping
detection, and authorization — is enforced exactly once, server-side, by
the code that already enforced it before this page existed
(`repository-registry/repository.ts`, `api/repository-registry.ts`).

## Why a static page, not a new frontend stack

`package.json` has never had a frontend dependency (no React, no bundler,
no CSS framework) — see `README.md`'s own Phase 0 rationale for `node:http`
over a web framework. Introducing one for a single admin page would be
dependency surface with nothing to show for it, the same reasoning that
already kept this project on `node:http`. `src/api/repository-ui.ts`
exports the page as a plain TypeScript string constant, so `tsc` compiles
it like any other source file — no separate static-asset build step to
maintain.

## Routes

| Route | Method | Handler | Deps |
| --- | --- | --- | --- |
| `/repositories` | `GET`/`HEAD` | `repository-ui.ts` (static content) | None — always mounted |
| `/repository-registry` | `GET`/`POST` | `api/repository-registry.ts` (pre-existing) | `repositoryRegistry` |
| `/repository-registry/:id` | `GET`/`PATCH` | `api/repository-registry.ts` (pre-existing) | `repositoryRegistry` |
| `/repository-registry/:id/deactivate`\|`/reactivate` | `POST` | `api/repository-registry.ts` (pre-existing) | `repositoryRegistry` |

**No new API endpoint was added for registry CRUD.** List, create, get,
update, and activate/deactivate already existed in full before this phase —
see "APIs reused" below. The only new route is the page itself.

## Authorization

Unchanged: the single shared `OPERATOR_TOKEN` bearer secret
(`verifyOperatorToken`, see `api/operator-auth.ts`), the exact mechanism
`docs/repository-selection.md`'s own "Known limitation" section already
documents (no per-person role system exists in this codebase). The page
asks the admin to paste that token into a field stored only in the current
browser tab's `sessionStorage`; it is sent back as the same
`Authorization: Bearer` header every operator-gated route already requires,
and never anywhere else. A caller who calls `/repository-registry` directly
— skipping this page entirely — is subject to exactly the same check; this
page cannot make an unauthorized request succeed, and cannot make an
authorized one fail. This page introduces no frontend-only authorization of
its own.

**Read-only users.** The existing backend has no distinct "read-only"
role — any caller holding the operator token can perform every operation,
create included. This page does not invent one either; it is a faithful
reflection of the backend's current authorization model, not an
improvement on it.

## What the UI does and does not change

- **Add Repository** — calls `POST /repository-registry`. The backend
  always creates a new entry with `status: 'active'`
  (`repository-registry/repository.ts`'s `create()` hard-codes it); the
  page's "Active" checkbox is shown checked and disabled, with a note
  explaining why, rather than implying the page controls something it
  does not.
- **Edit Repository** — calls `PATCH /repository-registry/:id`. Space/Project
  (`projectIdentifier`) and Repository ID (`repositoryId`) are immutable
  once created (`UpdateRegistryEntryInput` has no such fields) — the form
  disables both, matching the backend exactly rather than silently
  dropping an edit the API would reject anyway.
- **Activate / Deactivate** — calls
  `POST /repository-registry/:id/deactivate` or `/reactivate`, gated behind
  an explicit confirmation dialog naming the exact repository and project
  (e.g. "Deactivate repository company/test-app for TESTIN?"). Status is
  never part of the edit form — the backend's `update()` does not accept
  one either.
- **Selection safety** — entirely untouched. A ticket still resolves its
  repository through the registry, `repository-selection/worker.ts` still
  requires human confirmation for every run (even a single-candidate
  match), and a deactivated repository is still excluded from
  `findActiveByProjectIdentifier`'s candidates. This page cannot supply an
  arbitrary GitHub URL to a ticket — it only ever writes to the registry
  collection the selection worker already reads from.

## Display safety

The table shows: `projectIdentifier`, `repositoryId` + `repositoryUrl`,
`defaultBranch` + `allowedBranches`, the GitHub App installation id (just
the number, e.g. `#12345` — non-secret metadata, see
`repository-registry/repository.ts`'s own `accessPolicy` doc comment),
`status`, and `updatedBy`. It never renders a GitHub token, installation
token, private key, JWT, `Authorization` header, or the full `accessPolicy`
object (only the `installationId` field within it is extracted for
display) — asserted directly by `api/repository-ui.test.ts` and
`api/server.test.ts`.

## Audit

Unchanged — every write already audited by
`repository-registry/repository.ts` (`repository-registry.created`,
`repository-registry.updated`, `repository-registry.status-changed`),
attributed to the free-text `operator` field in the request body (never
the authorization mechanism), the same convention every other
operator-gated endpoint already uses. This page adds no new audit event and
introduces no "unauthorized attempt" audit entry — no handler anywhere in
this codebase audits a 401, only `logger.warn`s it; adding that pattern
here alone would be inconsistent with every existing gated endpoint rather
than an extension of one.

## Testing

- `api/repository-ui.test.ts` — structural/content assertions on the served
  page (required fields, required table columns, no external
  script/stylesheet, no secret-shaped literal, calls only
  `/repository-registry`).
- `api/server.test.ts`'s `/repositories admin UI routing` — the route is
  reachable, method-gated, and its response carries no operator-token or
  credential value.
- `api/repository-registry.test.ts` — the existing, and newly extended
  (auth-on-update/deactivate, secrets-never-returned), coverage of every
  handler this page calls.
- `pipeline/repository-management-e2e.test.ts` — the full scenario end to
  end, offline and deterministic: register a repository through the live
  HTTP server, confirm it is what the unchanged
  `repository-selection/worker.ts` finds for a TESTIN ticket, confirm human
  confirmation is still required, confirm the workflow then reaches
  `github-app/access.ts`'s `authorizeRepositoryAccess`, confirm a
  deactivated repository is no longer an eligible candidate, and confirm
  two active repositories for the same project still resolve to
  `ambiguous`, not an automatic choice.

## Current limitations

- **No real per-person authorization.** Inherited, not introduced — see
  "Authorization" above.
- **No delete.** The backend has no delete operation (by design — a
  registry entry is deactivated, never removed, preserving its audit
  history); the page has no delete action to match.
- **No live browser/GitHub verification.** Per this codebase's established
  testing convention (no real MongoDB, no real GitHub in any test suite),
  the end-to-end scenario was verified with the real HTTP server, the real
  registry/selection repositories, and a deterministic in-memory database —
  not a literal browser click-through or a real GitHub App installation.
