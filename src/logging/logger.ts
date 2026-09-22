/**
 * Structured logging: one JSON object per line on stdout, so a log shipper can
 * parse it without a regex.
 *
 * Every field passes through `redact` on the way out. This service handles an
 * Atlas URI with an embedded password, an `nta_` API token and a webhook
 * secret; a stray `logger.info('connecting', { uri })` must not be the thing
 * that leaks one.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Returns a logger that stamps `fields` onto every subsequent record. */
  child(fields: LogFields): Logger;
}

export const REDACTED = '[redacted]';

/** Field names whose value is replaced wholesale, matched case-insensitively. */
const SECRET_KEY_PATTERN =
  /password|secret|token|api[_-]?key|credential|authorization|cookie|uri|url|dsn/i;

/** Secret shapes worth catching even inside free text. */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /mongodb(\+srv)?:\/\/\S*:\S*@\S*/gi, // connection string carrying inline credentials
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic API key
  /\bsk-proj-[A-Za-z0-9_-]{8,}/g, // OpenAI project-scoped API key
  /\bnta_[A-Za-z0-9_-]{8,}/g, // Neutara personal API token
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bgh[a-z]_[A-Za-z0-9]{20,}\b/g, // GitHub App/personal token (ghs_, ghp_, gho_, ghu_, ghr_)
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, // GitHub fine-grained personal access token
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, // PEM private key block (GitHub App signing key)
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, // JWT (App-level auth token)
];

/** Strips credentials from a URI but keeps host and database, which are useful. */
export function redactUri(value: string): string {
  return value.replace(
    /^(mongodb(?:\+srv)?:\/\/)[^@/]*@/i,
    (_match, scheme: string) => `${scheme}${REDACTED}@`,
  );
}

function redactString(value: string): string {
  let out = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    // Each pattern is global, so reset lastIndex before reuse.
    pattern.lastIndex = 0;
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/**
 * Recursively redacts a value. Depth-limited because log fields occasionally
 * carry a deep or cyclic object (a Mongo client, a socket), and this must
 * never be the call that hangs the process.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      // A real secret this pattern targets (password, token, api key, URI)
      // is always a string. A number or boolean under a secret-shaped key —
      // e.g. `promptTokens` matching `token` — is never wholesale-redacted:
      // there is no secret to protect, and blanket-redacting it would only
      // destroy genuinely useful, non-sensitive data (see the LLM analyzers'
      // usage logging, which needed exactly this).
      const looksSecret = SECRET_KEY_PATTERN.test(key);
      const isNonStringPrimitive = typeof inner === 'number' || typeof inner === 'boolean';
      out[key] = looksSecret && !isNonStringPrimitive ? REDACTED : redact(inner, depth + 1);
    }
    return out;
  }
  return '[unserializable]';
}

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly base?: LogFields;
  /** Injectable for tests. Defaults to stdout. */
  readonly write?: (line: string) => void;
  /** Injectable for tests. Defaults to the wall clock. */
  readonly now?: () => Date;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const base = options.base ?? {};
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());
  const threshold = LEVEL_ORDER[level];

  function emit(recordLevel: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[recordLevel] < threshold) return;
    const record = {
      ts: now().toISOString(),
      level: recordLevel,
      msg: redactString(message),
      ...(redact({ ...base, ...fields }) as LogFields),
    };
    write(JSON.stringify(record));
  }

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (fields) => createLogger({ ...options, base: { ...base, ...fields } }),
  };
}
