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

/** Validates the deploy-only migration group. Never called by the service. */
export function loadMigrationConfig(source: EnvSource): MigrationConfig {
  const failures = new Failures();
  const mongodbMigrationUri = readMongoUri(source, MIGRATION_URI_VARIABLE, failures);
  rejectSharedCredential(source, failures);
  failures.throwIfAny('Invalid migration configuration');
  return { mongodbMigrationUri };
}
