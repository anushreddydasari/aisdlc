/**
 * Configuration for the integration test suite.
 *
 * Separate from `src/config/env.ts`, and deliberately so: the service's
 * configuration and the test suite's configuration read DISJOINT sets of
 * environment variables.
 *
 *   production code  AISDLC_MONGODB_URI, AISDLC_MONGODB_MIGRATION_URI
 *   integration tests AISDLC_TEST_MONGODB_URI, AISDLC_TEST_MONGODB_MIGRATION_URI,
 *                     AISDLC_TEST_DATABASE, AISDLC_TEST_CLEANUP_MONGODB_URI (optional)
 *
 * Nothing here reads a production variable, and there is no fallback to one.
 * A test run therefore cannot authenticate as `aisdlc_app` or
 * `aisdlc_migrator` even by accident, and cannot reach the production
 * database even if a test is wrong about which database it is using.
 *
 * Factored out of the test file so this gate — a safety control — is itself
 * covered by the offline suite. The integration test is skipped offline, so
 * logic living inside it would never be exercised by `npm test`.
 */

export const TEST_APP_URI_VARIABLE = 'AISDLC_TEST_MONGODB_URI';
export const TEST_MIGRATION_URI_VARIABLE = 'AISDLC_TEST_MONGODB_MIGRATION_URI';
export const TEST_DATABASE_VARIABLE = 'AISDLC_TEST_DATABASE';
/**
 * Optional. A THIRD, narrower identity: `remove` only, only on the specific
 * test collections an integration test namespaces its own rows in — never
 * `auditLog`. Absent by default; nothing requires it. See
 * "Optional: a dedicated test-cleanup credential" in docs/atlas-roles.md.
 * When unset, integration tests fall back to best-effort cleanup with the
 * application credential and report what could not be removed, rather than
 * failing.
 */
export const TEST_CLEANUP_URI_VARIABLE = 'AISDLC_TEST_CLEANUP_MONGODB_URI';

/** Variables the integration suite must never read. Asserted by its tests. */
export const PRODUCTION_URI_VARIABLES = [
  'AISDLC_MONGODB_URI',
  'AISDLC_MONGODB_MIGRATION_URI',
] as const;

export interface IntegrationConfig {
  readonly appUri: string;
  readonly migrationUri: string;
  readonly databaseName: string;
  /** Undefined unless AISDLC_TEST_CLEANUP_MONGODB_URI is set — see its constant above. */
  readonly cleanupUri: string | undefined;
}

export type IntegrationConfigResult =
  | { readonly ok: true; readonly config: IntegrationConfig }
  | { readonly ok: false; readonly reason: string };

type EnvSource = Readonly<Record<string, string | undefined>>;

/** Whitespace-only counts as absent, as it does for the service config. */
function present(source: EnvSource, name: string): string | undefined {
  const raw = source[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Resolves the integration configuration, or explains why the suite must not
 * run. Refusing is always the safe outcome: a skipped suite costs coverage,
 * while a suite pointed at production costs data.
 */
export function resolveIntegrationConfig(
  source: EnvSource,
  productionDatabase: string,
): IntegrationConfigResult {
  const appUri = present(source, TEST_APP_URI_VARIABLE);
  const migrationUri = present(source, TEST_MIGRATION_URI_VARIABLE);
  const databaseName = present(source, TEST_DATABASE_VARIABLE);
  // Optional: never added to `missing` below, so its absence never blocks the suite.
  const cleanupUri = present(source, TEST_CLEANUP_URI_VARIABLE);

  const missing = [
    appUri === undefined ? TEST_APP_URI_VARIABLE : null,
    migrationUri === undefined ? TEST_MIGRATION_URI_VARIABLE : null,
    databaseName === undefined ? TEST_DATABASE_VARIABLE : null,
  ].filter((name): name is string => name !== null);

  if (missing.length > 0) {
    // Note what is NOT done here: no fallback to the production variables,
    // however convenient. That fallback is precisely the mistake this guard
    // exists to make impossible.
    return {
      ok: false,
      reason:
        `${missing.join(', ')} not set; ` +
        'see docs/atlas-roles.md for test-database setup',
    };
  }

  // Compared case-insensitively. MongoDB database names are case-sensitive,
  // but a host filesystem may not be, and 'AISDLC' is not a safe target.
  if (databaseName!.toLowerCase() === productionDatabase.toLowerCase()) {
    return {
      ok: false,
      reason:
        `${TEST_DATABASE_VARIABLE} is '${databaseName}', which is the ` +
        `production database '${productionDatabase}'; refusing to run`,
    };
  }

  return {
    ok: true,
    config: { appUri: appUri!, migrationUri: migrationUri!, databaseName: databaseName!, cleanupUri },
  };
}
