/**
 * Target selection for the one-off database setup.
 *
 * Why this exists: `db:init` used to read AISDLC_MONGODB_MIGRATION_URI and
 * connect with the default database name, so it ALWAYS initialised
 * production. There was no way to point it at the test database, and nothing
 * said so — a reviewer asked for it to be run against `aisdlc_test` and the
 * command simply could not do that. Anyone following the README would have
 * initialised production believing otherwise.
 *
 * The fix is explicit selection with no default. Neither target is chosen
 * unless it is named on the command line, so the failure mode of a forgotten
 * flag is a refusal rather than a write to production.
 *
 * The test path reuses `resolveIntegrationConfig`, inheriting its guard, so
 * there is one definition of "which database is safe to write to" rather
 * than two that can drift.
 */

import { ConfigError, loadMigrationConfig } from '../config/env.ts';
import {
  TEST_MIGRATION_URI_VARIABLE,
  resolveIntegrationConfig,
} from '../intake/integration-config.ts';

export const TEST_FLAG = '--test';
export const PRODUCTION_FLAG = '--production';

export type InitTargetKind = 'test' | 'production';

export interface InitTarget {
  readonly kind: InitTargetKind;
  readonly uri: string;
  readonly databaseName: string;
}

export type ResolveInitTargetResult =
  | { readonly ok: true; readonly target: InitTarget }
  | { readonly ok: false; readonly reason: string };

type EnvSource = Readonly<Record<string, string | undefined>>;

const USAGE =
  `specify a target: '${TEST_FLAG}' (uses the AISDLC_TEST_* configuration) ` +
  `or '${PRODUCTION_FLAG}'. There is no default, deliberately: a forgotten ` +
  'flag must not initialise production.';

export function resolveInitTarget(
  argv: readonly string[],
  env: EnvSource,
  productionDatabase: string,
): ResolveInitTargetResult {
  const args = argv.filter((arg) => arg.trim() !== '');
  const unknown = args.filter((arg) => arg !== TEST_FLAG && arg !== PRODUCTION_FLAG);
  if (unknown.length > 0) {
    return { ok: false, reason: `unrecognised argument(s): ${unknown.join(', ')}. ${USAGE}` };
  }

  const wantsTest = args.includes(TEST_FLAG);
  const wantsProduction = args.includes(PRODUCTION_FLAG);

  if (wantsTest && wantsProduction) {
    return { ok: false, reason: `${TEST_FLAG} and ${PRODUCTION_FLAG} are mutually exclusive` };
  }
  if (!wantsTest && !wantsProduction) {
    return { ok: false, reason: USAGE };
  }

  if (wantsTest) {
    // Inherits the production-database guard, including its case-insensitive
    // comparison, from the integration suite's own configuration.
    const resolved = resolveIntegrationConfig(env, productionDatabase);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };

    // A cross-check the integration config cannot make, because it never
    // reads production variables: catch a production connection string
    // pasted into the test variable. The database guard would not see this —
    // the credential would simply have no rights on the test database, which
    // fails confusingly rather than clearly.
    const productionUri = env['AISDLC_MONGODB_MIGRATION_URI']?.trim();
    if (productionUri !== undefined && productionUri !== '' && productionUri === resolved.config.migrationUri) {
      return {
        ok: false,
        reason:
          `${TEST_MIGRATION_URI_VARIABLE} is identical to AISDLC_MONGODB_MIGRATION_URI; ` +
          'the test target must use the test migration user',
      };
    }

    return {
      ok: true,
      target: {
        kind: 'test',
        uri: resolved.config.migrationUri,
        databaseName: resolved.config.databaseName,
      },
    };
  }

  try {
    const config = loadMigrationConfig(env);
    return {
      ok: true,
      target: {
        kind: 'production',
        uri: config.mongodbMigrationUri,
        databaseName: productionDatabase,
      },
    };
  } catch (error) {
    if (error instanceof ConfigError) return { ok: false, reason: error.message };
    throw error;
  }
}
