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

export const OPERATOR_TOKEN_VARIABLE = 'OPERATOR_TOKEN';

export interface OperatorConfig {
  /** Absent means the approval endpoints refuse every request. */
  readonly operatorToken: string | undefined;
}

/**
 * The Phase 6 group. Mirrors loadWebhookConfig exactly: absent is a valid
 * state, not a startup failure — the service still serves health and
 * ingest, only POST /intake/:issueKey/approve|reject answer 401 to
 * everything until this is set. Deliberately separate from every other
 * credential this service loads (NEUTARA_API_TOKEN, the Mongo URIs): an
 * operator approving an intake item is a human decision, and nothing else
 * this process does should be able to make it on their behalf.
 */
export function loadOperatorConfig(source: EnvSource): OperatorConfig {
  const operatorToken = present(source, OPERATOR_TOKEN_VARIABLE);
  return { operatorToken };
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

/**
 * Same string as TEST_APP_URI_VARIABLE in src/intake/integration-config.ts.
 * Defined again here, deliberately not imported from there: that module's
 * whole point is that the integration suite's configuration is DISJOINT from
 * this one (see its own docstring, and the static source-scan tests that
 * assert it references no production variable). This module has its own,
 * separate reason to know the name — deciding which credential the running
 * service authenticates with — so it gets its own constant rather than a
 * cross-module import that would blur that boundary.
 */
export const TEST_APP_URI_VARIABLE = 'AISDLC_TEST_MONGODB_URI';

export type MongoIdentity = 'production' | 'test';

export type MongoUriResult =
  | { readonly ok: true; readonly uri: string; readonly identity: MongoIdentity }
  | { readonly ok: false; readonly reason: string };

/**
 * The username portion of a mongodb(+srv):// URI, or null when the URI
 * carries no credentials at all (a bare `host:port` authority). The
 * trailing `@` is required so a credential-free URI like
 * `mongodb://host:27017/db` isn't misread as username `host` — without it,
 * the host:port before the path looks identical in shape to user:pass@.
 * Never returns the password: the capture group stops at the first ':',
 * which is exactly the username/password boundary in this URI form.
 */
export function mongoUsername(uri: string): string | null {
  const match = /^mongodb(?:\+srv)?:\/\/([^:/@]+):[^/@]*@/.exec(uri);
  return match ? match[1]! : null;
}

/**
 * Decides which MongoDB credential the RUNNING SERVICE authenticates with.
 * Separate from resolveDatabaseName on purpose: that function decides WHICH
 * DATABASE a connection targets, this one decides WHICH IDENTITY makes the
 * connection. The two are independent knobs, and conflating them is exactly
 * how the service ended up authenticating as `aisdlc_app` — the production
 * identity, whose Atlas role (`aisdlcAppRole`) is scoped only to `aisdlc.*` —
 * while `AISDLC_DATABASE_NAME` pointed it at `aisdlc_test`, producing
 * `user is not allowed to do action [find] on [aisdlc_test.webhookDeliveries]`
 * only once a query actually ran, instead of a clear refusal at startup.
 *
 * In production this is unchanged: always RUNTIME_URI_VARIABLE, exactly as
 * before this function existed.
 *
 * Outside production there is no fallback to the production URI, the same
 * "no default outside production" stance resolveDatabaseName takes for the
 * database name — and the result is refused outright if the test URI would
 * authenticate as the same identity as the production one, whether by being
 * byte-identical or merely sharing a username. `aisdlc_app`'s role is
 * intentionally scoped to production only (see docs/atlas-roles.md); reusing
 * its identity outside production is not a convenience, it is the same
 * failure this function exists to catch at startup instead of at query time.
 */
export function resolveRuntimeMongoUri(
  source: EnvSource,
  nodeEnv: NodeEnvironment,
  productionUri: string,
): MongoUriResult {
  if (nodeEnv === 'production') {
    return { ok: true, uri: productionUri, identity: 'production' };
  }

  const testUri = present(source, TEST_APP_URI_VARIABLE);
  if (testUri === undefined) {
    return {
      ok: false,
      reason:
        `${TEST_APP_URI_VARIABLE} must be set when NODE_ENV is '${nodeEnv}'. ` +
        `There is no fallback to ${RUNTIME_URI_VARIABLE}, so a local run cannot ` +
        'silently authenticate as the production identity.',
    };
  }
  if (!isMongoUri(testUri)) {
    return {
      ok: false,
      reason: `${TEST_APP_URI_VARIABLE} is invalid (expected a mongodb:// or mongodb+srv:// connection string)`,
    };
  }

  if (testUri === productionUri) {
    return {
      ok: false,
      reason:
        `${TEST_APP_URI_VARIABLE} is identical to ${RUNTIME_URI_VARIABLE}; outside ` +
        'production the service must authenticate with a dedicated test identity, ' +
        'never the production one',
    };
  }

  const testUser = mongoUsername(testUri);
  const prodUser = mongoUsername(productionUri);
  if (testUser !== null && testUser === prodUser) {
    return {
      ok: false,
      reason:
        `${TEST_APP_URI_VARIABLE} authenticates as the same identity as ` +
        `${RUNTIME_URI_VARIABLE}; outside production it must use a dedicated test ` +
        'application user, never the production one',
    };
  }

  return { ok: true, uri: testUri, identity: 'test' };
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

export const OPENAI_API_KEY_VARIABLE = 'OPENAI_API_KEY';
export const OPENAI_MODEL_VARIABLE = 'OPENAI_MODEL';
export const DEFAULT_OPENAI_MODEL = 'gpt-4.1';

export interface OpenAiConfig {
  readonly apiKey: string;
  readonly model: string;
}

export type OpenAiConfigResult =
  | { readonly configured: true; readonly config: OpenAiConfig }
  | { readonly configured: false; readonly reason: string };

/**
 * Like NeutaraConfig, absent is a valid state: the Requirements Agent runs
 * with its deterministic stub analyzer rather than refusing to start. This is
 * what lets `npm test` and every existing unit test stay network-free — only
 * a caller that explicitly sets OPENAI_API_KEY opts into a real LLM call.
 */
export function loadOpenAiConfig(source: EnvSource): OpenAiConfigResult {
  const apiKey = present(source, OPENAI_API_KEY_VARIABLE);
  if (apiKey === undefined) {
    return {
      configured: false,
      reason: `${OPENAI_API_KEY_VARIABLE} not set; using the deterministic stub analyzer`,
    };
  }

  const model = present(source, OPENAI_MODEL_VARIABLE) ?? DEFAULT_OPENAI_MODEL;
  return { configured: true, config: { apiKey, model } };
}

/** Validates the deploy-only migration group. Never called by the service. */
export function loadMigrationConfig(source: EnvSource): MigrationConfig {
  const failures = new Failures();
  const mongodbMigrationUri = readMongoUri(source, MIGRATION_URI_VARIABLE, failures);
  rejectSharedCredential(source, failures);
  failures.throwIfAny('Invalid migration configuration');
  return { mongodbMigrationUri };
}
