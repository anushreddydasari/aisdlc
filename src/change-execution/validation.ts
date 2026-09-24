/**
 * Change validation — running tests, typecheck, and build against a
 * local, applied working copy (Section 8).
 *
 * MOCK ONLY, DELIBERATELY, THIS PHASE. `ChangeValidationRunner` is a
 * pluggable interface; `createMockChangeValidationRunner` is its only
 * implementation right now. This mirrors the pattern this codebase has
 * already used repeatedly — `GitHubAppClient` shipped a mock in Stage 1 and
 * only grew a real implementation once the surrounding phases that needed
 * it (authentication, then file reads) were proven out; `CodingAgentProvider`
 * still exposes a mock alongside its real OpenAI-backed implementation.
 *
 * A REAL implementation would mean shelling out to run arbitrary `npm test`
 * / `tsc` / `npm run build` commands against LLM-modified, externally
 * sourced code — a materially different, security-critical capability
 * (arbitrary command execution) that deserves its own careful phase, the
 * same way this project explicitly deferred GitHub write operations rather
 * than bolting them onto this one. See docs/change-execution.md's "Current
 * limitations".
 */

import type { ValidationStepResult, ValidationSummary } from './types.ts';

export interface ChangeValidationContext {
  readonly runId: string;
  readonly workingDirectory: string;
}

export interface ChangeValidationRunner {
  run(context: ChangeValidationContext): Promise<ValidationSummary>;
}

export interface MockValidationOutcomes {
  readonly tests?: boolean;
  readonly typecheck?: boolean;
  readonly build?: boolean;
}

function step(ok: boolean, name: string): ValidationStepResult {
  return { ok, summary: ok ? `mock: ${name} passed` : `mock: ${name} failed` };
}

/**
 * Deterministic and offline — see Section 13's "all tests must be
 * deterministic and offline" requirement. Defaults to every step passing;
 * a test overrides exactly the step(s) it needs to fail.
 */
export function createMockChangeValidationRunner(outcomes: MockValidationOutcomes = {}): ChangeValidationRunner {
  return {
    async run(): Promise<ValidationSummary> {
      return {
        tests: step(outcomes.tests ?? true, 'tests'),
        typecheck: step(outcomes.typecheck ?? true, 'typecheck'),
        build: step(outcomes.build ?? true, 'build'),
      };
    },
  };
}
