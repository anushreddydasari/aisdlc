/**
 * Strict environment-variable validation.
 *
 * Contract (see .env.example): every variable is read from the environment
 * with NO literal fallback. A missing or malformed variable is a startup
 * failure that names the VARIABLE and never the VALUE, so error messages from
 * this module are safe to log and safe to print to a terminal.
 *
 * `loadConfig` is pure: it takes an environment record rather than reading
 * `process.env` itself, so tests never have to mutate global state.
 */

export type NodeEnvironment = 'development' | 'test' | 'production';

/** Variables the running service needs. Phase 0 group only. */
export interface RuntimeConfig {
  readonly mongodbUri: string;
  readonly port: number;
  readonly nodeEnv: NodeEnvironment;
}

/**
 * Variables the one-off index/validator setup needs. Deliberately separate
 * from RuntimeConfig: the service process never loads the migration URI, so a
 * compromised service cannot alter the auditLog validator.
 */
export interface MigrationConfig {
  readonly mongodbMigrationUri: string;
}

export class ConfigError extends Error {
  /** Names of the variables at fault. Never their values. */
  readonly variables: readonly string[];

  constructor(message: string, variables: readonly string[]) {
    super(message);
    this.name = 'ConfigError';
    this.variables = variables;
  }
}

export type EnvSource = Readonly<Record<string, string | undefined>>;

const NODE_ENVIRONMENTS: readonly NodeEnvironment[] = ['development', 'test', 'production'];

/**
 * Treats whitespace-only as absent. `AISDLC_MONGODB_URI=` in a .env file
 * arrives as an empty string, which is a missing value, not a valid one.
 */
function present(source: EnvSource, name: string): string | undefined {
  const raw = source[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Collects failures so a fresh checkout sees every missing variable at once. */
class Failures {
  private readonly names: string[] = [];
  private readonly reasons: string[] = [];

  missing(name: string): void {
    this.names.push(name);
    this.reasons.push(`${name} is not set`);
  }

  invalid(name: string, expectation: string): void {
    this.names.push(name);
    this.reasons.push(`${name} is invalid (expected ${expectation})`);
  }

  conflict(names: readonly string[], reason: string): void {
    this.names.push(...names);
    this.reasons.push(reason);
  }

  get empty(): boolean {
    return this.names.length === 0;
  }

  throwIfAny(context: string): void {
    if (this.empty) return;
    throw new ConfigError(
      `${context}: ${this.reasons.join('; ')}. ` +
        'Copy .env.example to .env and fill these in. Values are never logged.',
      [...this.names],
    );
  }
}

/**
 * Accepts the two forms Atlas hands out. This is a shape check only: it does
 * not prove the credentials work, and it must never quote the URI back.
 */
export function isMongoUri(value: string): boolean {
  return /^mongodb(\+srv)?:\/\/\S+$/.test(value);
}

function readMongoUri(source: EnvSource, name: string, failures: Failures): string {
  const value = present(source, name);
  if (value === undefined) {
    failures.missing(name);
    return '';
  }
  if (!isMongoUri(value)) {
    failures.invalid(name, 'a mongodb:// or mongodb+srv:// connection string');
    return '';
  }
  return value;
}

function readPort(source: EnvSource, name: string, failures: Failures): number {
  const value = present(source, name);
  if (value === undefined) {
    failures.missing(name);
    return 0;
  }
  // Number() would accept '80.5', '0x50' and '1e3'. A port is digits only.
  if (!/^\d+$/.test(value)) {
    failures.invalid(name, 'an integer between 1 and 65535');
    return 0;
  }
  const port = Number.parseInt(value, 10);
  if (port < 1 || port > 65535) {
    failures.invalid(name, 'an integer between 1 and 65535');
    return 0;
  }
  return port;
}

function readNodeEnv(source: EnvSource, name: string, failures: Failures): NodeEnvironment {
  const value = present(source, name);
  if (value === undefined) {
    failures.missing(name);
    return 'development';
  }
  if (!NODE_ENVIRONMENTS.includes(value as NodeEnvironment)) {
    failures.invalid(name, `one of ${NODE_ENVIRONMENTS.join(', ')}`);
    return 'development';
  }
  return value as NodeEnvironment;
}

export const RUNTIME_URI_VARIABLE = 'AISDLC_MONGODB_URI';
export const MIGRATION_URI_VARIABLE = 'AISDLC_MONGODB_MIGRATION_URI';

/**
 * The privilege split is the whole point of having two URIs: the service runs
 * as aisdlc_app (no collMod, no remove on auditLog) and only the one-off setup
 * runs as aisdlc_migrator. If an operator pastes the migrator string into both,
 * that separation silently disappears and the service gains the rights the
 * design exists to withhold. Nothing else detects this, so refuse to start.
 */
function rejectSharedCredential(source: EnvSource, failures: Failures): void {
  const runtime = present(source, RUNTIME_URI_VARIABLE);
  const migration = present(source, MIGRATION_URI_VARIABLE);

  if (runtime !== undefined && migration !== undefined && runtime === migration) {
    failures.conflict(
      [RUNTIME_URI_VARIABLE, MIGRATION_URI_VARIABLE],
      `${RUNTIME_URI_VARIABLE} and ${MIGRATION_URI_VARIABLE} are identical; ` +
        'the service and migration users must be different Atlas users',
    );
  }
}

/** Validates the Phase 0 runtime group. Throws ConfigError naming every fault. */
export function loadConfig(source: EnvSource): RuntimeConfig {
  const failures = new Failures();

  const mongodbUri = readMongoUri(source, RUNTIME_URI_VARIABLE, failures);
  const port = readPort(source, 'AISDLC_PORT', failures);
  const nodeEnv = readNodeEnv(source, 'NODE_ENV', failures);
  rejectSharedCredential(source, failures);

  failures.throwIfAny('Invalid service configuration');

  return { mongodbUri, port, nodeEnv };
}

export const WEBHOOK_SECRET_VARIABLE = 'NEUTARA_WEBHOOK_SECRET';

export interface WebhookConfig {
  /** Absent means /ingest refuses every request. */
  readonly webhookSecret: string | undefined;
}

/**
 * The Phase 3 group.
 *
 * Deliberately NOT part of `loadConfig`: the service has to start without it,
 * or a Phase 0-2 checkout could not run at all. An absent secret is a valid
 * configuration in which `/ingest` answers 401 to everything, which is what
 * .env.example specifies — never accept unsigned requests.
 */
export function loadWebhookConfig(source: EnvSource): WebhookConfig {
  const secret = present(source, WEBHOOK_SECRET_VARIABLE);
  return { webhookSecret: secret };
}

export const DATABASE_NAME_VARIABLE = 'AISDLC_DATABASE_NAME';

export type DatabaseNameResult =
  | { readonly ok: true; readonly databaseName: string; readonly overridden: boolean }
  | { readonly ok: false; readonly reason: string };

/**
 * Decides which database the service writes to.
 *
 * In production the override is IGNORED. A deployment must not be able to
 * point itself somewhere else through an environment variable, however the
 * variable arrived.
 *
 * Outside production the override is REQUIRED, with no fallback. That is the
 * point: a local service that silently defaults to `aisdlc` writes test
 * traffic into production, and the failure is invisible until someone reads
 * the data. Refusing to start is the safe direction. It is also refused if it
 * names the production database, so "explicitly opting in to production from
 * a dev machine" is not a thing this can be talked into.
 */
export function resolveDatabaseName(
  source: EnvSource,
  nodeEnv: NodeEnvironment,
  productionDatabase: string,
): DatabaseNameResult {
  const override = present(source, DATABASE_NAME_VARIABLE);

  if (nodeEnv === 'production') {
    return { ok: true, databaseName: productionDatabase, overridden: false };
  }

  if (override === undefined) {
    return {
      ok: false,
      reason:
        `${DATABASE_NAME_VARIABLE} must be set when NODE_ENV is '${nodeEnv}'. ` +
        'There is no default outside production, so a local service cannot ' +
        `silently write to '${productionDatabase}'.`,
    };
  }

  // Case-insensitive, matching the integration-test guard: MongoDB names are
  // case-sensitive, but 'AISDLC' is not a safe target either.
  if (override.toLowerCase() === productionDatabase.toLowerCase()) {
    return {
      ok: false,
      reason:
        `${DATABASE_NAME_VARIABLE} is '${override}', which is the production ` +
        `database '${productionDatabase}'; refusing to run outside production`,
    };
  }

  return { ok: true, databaseName: override, overridden: true };
}

export const NEUTARA_BASE_URL_VARIABLE = 'NEUTARA_API_BASE_URL';
export const NEUTARA_TOKEN_VARIABLE = 'NEUTARA_API_TOKEN';

export interface NeutaraConfig {
  /** Origin only, no trailing slash. The client appends `/api/issues/{key}`. */
  readonly baseUrl: string;
  readonly token: string;
}

export type NeutaraConfigResult =
  | { readonly configured: true; readonly config: NeutaraConfig }
  | { readonly configured: false; readonly reason: string };

/**
 * Normalises and checks the Neutara base URL.
 *
 * It must be an ORIGIN. The client appends `/api/issues/{key}`, so a value
 * that already carries `/api` produces `/api/api/issues/...` and a confusing
 * 404 rather than an obvious configuration error. A trailing slash would
 * produce a double slash for the same reason. Both are caught here instead.
 */
export function normalizeNeutaraBaseUrl(
  value: string,
): { ok: true; baseUrl: string } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: `${NEUTARA_BASE_URL_VARIABLE} is not a valid URL` };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `${NEUTARA_BASE_URL_VARIABLE} must be http or https` };
  }
  if (url.search !== '' || url.hash !== '') {
    return { ok: false, reason: `${NEUTARA_BASE_URL_VARIABLE} must not carry a query or fragment` };
  }

  const path = url.pathname.replace(/\/+$/, '');
  if (path !== '') {
    return {
      ok: false,
      reason:
        `${NEUTARA_BASE_URL_VARIABLE} must be an origin with no path; ` +
        `the client appends '/api/issues/{key}' itself`,
    };
  }

  return { ok: true, baseUrl: url.origin };
}

/**
 * The Phase 4 group. Like the webhook secret, absent is a valid state: the
 * service runs without enrichment rather than refusing to start.
 */
export function loadNeutaraConfig(source: EnvSource): NeutaraConfigResult {
  const rawBaseUrl = present(source, NEUTARA_BASE_URL_VARIABLE);
  const token = present(source, NEUTARA_TOKEN_VARIABLE);

  const missing = [
    rawBaseUrl === undefined ? NEUTARA_BASE_URL_VARIABLE : null,
    token === undefined ? NEUTARA_TOKEN_VARIABLE : null,
  ].filter((name): name is string => name !== null);

  if (missing.length > 0) {
    return { configured: false, reason: `${missing.join(', ')} not set; enrichment is disabled` };
  }

  const normalized = normalizeNeutaraBaseUrl(rawBaseUrl!);
  if (!normalized.ok) return { configured: false, reason: normalized.reason };

  return { configured: true, config: { baseUrl: normalized.baseUrl, token: token! } };
}

/** Validates the deploy-only migration group. Never called by the service. */
export function loadMigrationConfig(source: EnvSource): MigrationConfig {
  const failures = new Failures();
  const mongodbMigrationUri = readMongoUri(source, MIGRATION_URI_VARIABLE, failures);
  rejectSharedCredential(source, failures);
  failures.throwIfAny('Invalid migration configuration');
  return { mongodbMigrationUri };
}
