# Coding Agent

**THE CODING AGENT IS READ-ONLY IN THIS PHASE.** It analyzes approved
requirements and a confirmed repository's content, and proposes an
implementation plan and file changes for a human to review. It never
writes to GitHub — no branch, no commit, no pull request, no merge exists
anywhere in this codebase yet.

## Architecture

```
Approved Run
    ↓  runs.findById(runId) — obtains intakeItemId only; run readiness
    ↓  itself is re-checked, authoritatively, by GitHub Access Integration below
Requirements
    ↓  requirements.findByIntakeItemId(intakeItemId) — must be status: 'completed'
Confirmed Repository
    ↓  (validated entirely by GitHub Access Integration, reused unchanged)
GitHub Access Integration
    ↓  repository-context.ts's buildRepositoryContext() → accessRepositoryForRun()
Repository Context
    ↓  owner, repo, branch, defaultBranch, visibility, files — no credential of any kind
Coding Agent
    ↓  plan.ts → provider.generateImplementationPlan()
Implementation Plan (validated)
    ↓  changes.ts → provider.generateProposedChanges()
Proposed Changes (validated, hashed)
    ↓
Validation
    ↓
Human Review  ← THIS PHASE STOPS HERE
```

Module boundaries, and why each exists:

| Module | Owns | Never does |
| --- | --- | --- |
| `types.ts` | Every result model and the failure taxonomy | Any logic |
| `path-safety.ts` | Path/file-reference validation | Know about plans, changes, or providers |
| `repository-context.ts` | File selection policy + building `RepositoryContext` | Talk to GitHub or a registry/selection repository directly — only ever calls `GitHubAccessIntegration` |
| `provider.ts` | The `CodingAgentProvider` interface + deterministic mock | Call a real LLM |
| `openai-provider.ts` | The real, OpenAI-backed provider | Anything GitHub-related |
| `plan.ts` | Implementation-plan generation + validation | Generate or validate proposed changes |
| `changes.ts` | Proposed-change generation + validation + hashing | Apply anything |
| `service.ts` | Orchestrates all of the above; the only public entry point | Write to GitHub, MongoDB state beyond what already exists, or bypass any validation step |

**No GitHub access logic is mixed into the Coding Agent itself.**
`repository-context.ts` is the only file that references
`GitHubAccessIntegration`, and it only ever calls
`accessRepositoryForRun` — the same read-only, fully-validated entry point
[`docs/github-access-integration.md`](github-access-integration.md)
already documents. Every validation that entry point performs (run
readiness, intake approval, human confirmation, live registry/branch
checks) is inherited for free.

## Input contract

```ts
interface CodingAgentInput {
  readonly runId: ObjectId;
  readonly candidateFilePaths: readonly string[];
}
```

Deliberately minimal. Repository identity and branch are never accepted as
caller-supplied input — they are always DERIVED from the run's confirmed
selection via GitHub Access Integration. This is what makes "the Coding
Agent must never select a different repository than the confirmed
selection" true by construction, and why "repository mismatch" / "branch
mismatch" are not validation scenarios this service can even encounter —
there is no code path by which a mismatched value could be supplied.

`candidateFilePaths` exists because there is no Coding Agent-specific
"which files matter" policy yet — see "File selection" below.

## Repository-context contract

```ts
interface RepositoryContext {
  readonly repositoryId: string;
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  readonly defaultBranch: string;
  readonly visibility: 'public' | 'private' | 'internal';
  readonly files: readonly { path: string; content: string }[];
}
```

No credential field exists on this type, anywhere. This is what makes "the
provider must not receive GitHub tokens/JWTs/private keys" true by
construction rather than by discipline alone — there is nothing to
accidentally forward.

### File selection

`FileSelectionPolicy` (in `repository-context.ts`) is an explicit,
pluggable interface — decision: "if the existing system does not yet
define how relevant files are selected, create an explicit
interface/policy... keep the first implementation conservative and
deterministic." The only implementation in this phase,
`createDefaultFileSelectionPolicy`, deduplicates, sorts, and bounds the
caller-supplied `candidateFilePaths` to `DEFAULT_MAX_CONTEXT_FILES` (25) —
**it does not crawl or infer relevance**. `GitHubAppClient` has no
repository-tree-listing capability (only `getFileContents` for an
already-known path — see `github-app/client.ts`), so there is no listing
to score in the first place, and no unrestricted recursive crawling is
implemented, per the explicit scope restriction.

## LLM/provider contract

```ts
interface CodingAgentProvider {
  generateImplementationPlan(input: { requirements, context }): Promise<GeneratePlanResult>;
  generateProposedChanges(input: { requirements, context, plan }): Promise<GenerateChangesResult>;
}
```

Two separate operations, never one combined call — "the first Coding Agent
operation should generate an implementation plan. Do not immediately
generate/apply code." `plan.ts` fully validates a plan before `service.ts`
ever calls `generateProposedChanges`; an LLM that produces a nonsensical
plan never gets the chance to propose file content at all.

**What the provider receives:** the `RequirementsResult` and the
`RepositoryContext` above (for `generateProposedChanges`, also the
already-validated `ImplementationPlan`). **What it never receives:**
GitHub installation tokens, JWTs, private keys, `Authorization` headers,
unrelated secrets, or unnecessary environment variables — there is no
field on any of these types for them to travel through, and
`openai-provider.test.ts`'s "secret-safe" suite asserts the built request
body and headers contain only the OpenAI API key, in its own header.

**Two implementations**, the same "interface, mock, real" split already
used throughout this codebase (`GitHubAppClient`/`mock-client.ts`/`real-client.ts`):

- `createMockCodingAgentProvider` (`provider.ts`) — deterministic, in-memory, the only implementation any test uses.
- `createOpenAiCodingAgentProvider` (`openai-provider.ts`) — real, `fetch`-based (no SDK, matching `requirements/openai-analyzer.ts`'s established pattern), structured output via a forced, strict OpenAI tool call (`submit_implementation_plan` / `submit_proposed_changes`), injectable `fetchFn` so no test ever reaches the network.

**Every provider failure is a Result, never a thrown exception** — one
deliberate difference from `openai-analyzer.ts`, which throws because its
one caller already had a catch-and-mark-failed path predating this
decision. The Coding Agent's failure taxonomy was designed as a Result
from the start (see "Error handling" below), so the provider matches it.

## Implementation-plan format

```ts
interface ImplementationPlanItem {
  readonly id: string;
  readonly filePath: string;
  readonly operation: 'create' | 'modify';
  readonly changeDescription: string;
}

interface ImplementationPlan {
  readonly summary: string;
  readonly requirementsUnderstanding: string;
  readonly relevantFiles: readonly string[];
  readonly items: readonly ImplementationPlanItem[];
  readonly dependenciesAndImpact: readonly string[];
  readonly testsRequired: readonly string[];
  readonly assumptions: readonly string[];
  readonly risks: readonly string[];
}
```

`operation` on each item — not explicitly named in the original field list
— was added deliberately: it is what lets plan validation check "does this
file reference make sense" precisely, the exact check `ProposedChange`
needs too, reused via `path-safety.ts`'s `validateFileReference` rather
than re-derived.

**Validation** (`plan.ts`), never a silent repair:

1. **Shape** (`isWellShapedPlan`) — every required field present and correctly typed. Failure: `malformed_model_output`.
2. **Content** (`validatePlanContent`), once the shape is known-good:
   - at least one item
   - item ids are unique (a `ProposedChange` must resolve its `relatedPlanItemId` unambiguously)
   - every item's `(filePath, operation)` makes sense against the repository context (`modify` → must already be in context; `create` → must not be)
   - every item's path is safe (`path-safety.ts`)
   - every item's path falls within the plan's own declared `relevantFiles` ∪ the repository context — a **structural consistency check**, not a semantic verification that the plan is truly related to the requirements (that would need the LLM's own judgement to verify, which this phase does not attempt to second-guess)

   Failure: `validation_failure`.

## Proposed-change format

```ts
interface ProposedChange {
  readonly filePath: string;
  readonly operation: 'create' | 'modify';
  readonly originalContentHash: string | null; // sha256, computed by this codebase — never the LLM
  readonly proposedContent: string;
  readonly reason: string;
  readonly relatedPlanItemId: string;
}
```

Only `create` and `modify` are supported — decision: "do not implement
deletion unless the existing architecture demonstrates a clear
requirement for it." Nothing does, so it is out of scope.

`originalContentHash` is computed by `changes.ts`'s `hashFileContent`
(plain sha256 of the raw file text — not `intake/hash.ts`'s `contentHash`,
which canonicalizes structured objects order-independently and is the
wrong tool for hashing a text blob) from the actual `RepositoryContext`
content, **never accepted from the provider**, which cannot be trusted to
compute a real hash. Null for `create` (no original exists); required for
`modify`.

**Validation** (`changes.ts`), never a silent repair:

1. **Shape** — every required field present and correctly typed. Failure: `malformed_model_output`.
2. **Plan correspondence** — `relatedPlanItemId` must resolve to a real item in the already-validated plan. Failure: `validation_failure`.
3. **Safety** (`path-safety.ts`'s `validateFileReference`, the SAME check plan items use) — safe path, sensible create/modify semantics against the repository context. Failure: **`unsafe_proposed_change`** — deliberately a different category than a plan item's `validation_failure`: an actual CHANGE proposing to touch a credential file or escape the repository is a safety concern, distinct from a plan item merely naming a bad path (which proposes nothing executable yet).

## Validation rules (path and file safety)

`path-safety.ts` rejects, never silently normalizes:

- absolute paths (POSIX `/...` and Windows `C:\...`)
- `../` traversal (which is also what "outside the repository root" reduces to for a repo-relative path model with no filesystem to resolve against)
- invalid paths (empty, whitespace, NUL bytes, backslash separators, URL-shaped, characters outside a conservative safe set)
- credential/secret files (`.env*`, `.git/`, `*.pem`/`*.key`/`*.p12`/`*.pfx`/`*.jks`, `id_rsa*`, `id_ed25519*`, `.ssh/`, `.aws/`)
- unauthorized configuration (`.github/workflows/`, `Dockerfile*`, `docker-compose*.yml`) — CI/CD and deployment config are exactly how a change could reach production infrastructure, out of scope for a read-only analysis phase
- files outside the approved scope — a `modify` targeting a file the run's repository context never included, or a `create`/`modify` whose path was never declared relevant by the plan

## Security restrictions maintained

Everything already established by GitHub App / GitHub Access Integration,
unchanged:

- GitHub App authentication (installation tokens, never a personal access token)
- HTTPS-only, registry-controlled repository URLs
- Owner/repository identity verification
- 10-second request timeouts, redirect rejection
- Mandatory human confirmation (a run without one never reaches this service — `GitHubAccessIntegration` refuses it first)
- One run maps to exactly one repository

New in this phase:

- **The provider never receives a credential of any kind** — see "LLM/provider contract" above.
- **No GitHub write capability exists anywhere this service can reach.** `GitHubAccessService`'s interface has exactly one method, `accessRepositoryForRun`, which is read-only — a write cannot happen because there is nothing to call.
- **Path/file safety validation** rejects credential files, secrets, and CI/CD/deployment configuration before they can ever become a `ProposedChange`.

## Audit events

All under the existing `AuditLog`, actor `system:coding-agent`,
`subjectType: 'run'`, `subjectId: runId`:

| Action | When | Detail |
| --- | --- | --- |
| `coding-agent.started` | Always, first | `candidateFilePaths` |
| `coding-agent.repository-context.created` | After `buildRepositoryContext` succeeds | `repositoryId`, `branch`, `fileCount` |
| `coding-agent.plan.created` | After the plan is generated AND validated | `repositoryId`, `itemCount` |
| `coding-agent.changes.proposed` | After changes are generated AND validated | `repositoryId`, `changeCount`, `paths` |
| `coding-agent.failed` | On any failure, at the point it occurred | `category`, `retryable`, `intakeItemId` (when known), `repositoryId` (when known) |

**Never audited or logged:** GitHub tokens, JWTs, private keys,
`Authorization` headers, LLM API keys, or complete file contents (proposed
or original). File *paths* are recorded — they are already-authorized
source locations, not secret.

## Error handling and retry behavior

`CodingAgentFailureCategory` (`types.ts`):

| Category | Source | Retryable |
| --- | --- | --- |
| `invalid_input` | This service (missing run, empty `candidateFilePaths`) | No |
| `missing_requirements` | This service (no completed requirements analysis) | No |
| `repository_context_failure` | `repository-context.ts` (e.g. no files selected) | No |
| `github_access_failure` | Wraps the full `GitHubAccessFailureCategory` taxonomy as one category | Passed through from the underlying failure's own `retryable`/`retryAfterMs` |
| `provider_failure` | Wraps most provider failures (auth, generic transient, unexpected) | Passed through from `isProviderFailureRetryable(kind)` |
| `timeout` | Unwrapped from either GitHub or the provider — a caller benefits from seeing this specifically | **Yes** |
| `rate_limited` | Unwrapped from either GitHub or the provider, same reasoning as `timeout` | **Yes** |
| `malformed_model_output` | `plan.ts` / `changes.ts` shape validation | No |
| `validation_failure` | `plan.ts` / `changes.ts` content validation | No |
| `unsafe_proposed_change` | `changes.ts` path/file safety | No |
| `unexpected_error` | Any exception this service did not anticipate | No |

**Never thrown out of `service.ts`.** `CodingAgentService.run()` wraps its
own execution in a `try/catch`; any unexpected exception (including one
thrown by a misbehaving provider) maps to `unexpected_error`.

## Idempotency

No new persisted "coding agent already ran" state. `repositorySelections.runId`
is already unique, so a run has exactly one confirmed repository —
repeated or concurrent execution can only ever reproduce the same
analysis, never conflict, the identical reasoning
`docs/github-access-integration.md` already documents for that layer.
Concurrent calls for the same `runId` are de-duplicated in-process (the
same `inFlight` map shape `github-access/service.ts` and `token-issuer.ts`
both use); a later, non-overlapping call runs fresh.

## Human-review boundary

`CodingAgentResult`, `ImplementationPlan`, and `ProposedChange` ARE the
interfaces a future human-review-and-apply workflow would consume. This
phase defines that boundary and stops at it — nothing here applies a
`ProposedChange`, and no interface for "apply this" exists yet.

```
Coding Agent
    ↓
Implementation Plan
    ↓
Proposed Changes
    ↓
Validation
    ↓
Human Review   ← this phase's boundary
    ↓
(future) Approve → Apply → Test → Branch → Commit → Pull Request
```

## Current limitations

- **Read-only**, confirmed: no write, branch, commit, or PR capability exists anywhere in this codebase.
- **No file-relevance discovery.** `candidateFilePaths` is caller-supplied; the default policy only deduplicates/bounds it — there is no repository-tree API to crawl or score against.
- **The "related to approved requirements" check is structural, not semantic.** A plan/change is checked for internal self-consistency (declared scope, valid file references), not verified to actually address the requirements text — that judgement is the LLM's, unverified by this phase.
- **Not wired to the orchestrator.** `CodingAgentService.run()` is a callable entry point; no scheduler invokes it automatically yet, the same deliberate gap `github-access/service.ts` has and for the same reason — no downstream consumer exists yet to design a scheduler's cadence/failure-handling around.
- **No deletion support**, and none is planned until a concrete requirement demonstrates the need.
