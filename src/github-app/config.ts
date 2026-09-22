/**
 * GitHub App configuration and validation — no network, no crypto, no
 * token generation. Everything here is a pure function over an environment
 * source, mirroring `loadNeutaraConfig`/`loadOpenAiConfig` in
 * src/config/env.ts exactly: absent configuration is a valid state
 * (`configured: false`), never a startup failure, because nothing in this
 * service depends on GitHub App access existing yet — the same reason the
 * Requirements Agent runs its deterministic stub when `OPENAI_API_KEY` is
 * unset rather than refusing to start.
 *
 * Deliberately separate from src/config/env.ts rather than added to it:
 * this module belongs to github-app/, matching how src/intake/integration-config.ts
 * has its own configuration module rather than growing env.ts indefinitely.
 *
 * SECRET HANDLING: `loadGitHubAppConfig`'s error messages name only the
 * variable, never a value — the exact contract `ConfigError` already
 * documents ("Never their values") — and this module never logs anything
 * itself. The private key's SHAPE is validated (it must look like a PEM
 * block); its CONTENTS are never inspected, parsed as a real key, or used
 * to sign anything here — that is jwt.ts's job, one stage later.
 */

export const GITHUB_APP_ID_VARIABLE = 'GITHUB_APP_ID';
export const GITHUB_APP_PRIVATE_KEY_VARIABLE = 'GITHUB_APP_PRIVATE_KEY';

export interface GitHubAppConfig {
  readonly appId: number;
  /** PEM-format RSA private key. Never logged — see the module comment above. */
  readonly privateKey: string;
}

export type GitHubAppConfigResult =
  | { readonly configured: true; readonly config: GitHubAppConfig }
  | { readonly configured: false; readonly reason: string };

type EnvSource = Readonly<Record<string, string | undefined>>;

/** Whitespace-only counts as absent, matching every other config loader in this codebase. */
function present(source: EnvSource, name: string): string | undefined {
  const raw = source[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * A GitHub App id is a positive integer, always. Digits only — `Number()`
 * would accept `1e3` or `0x10`, the same reason `readPort` in env.ts uses
 * this exact check rather than a numeric coercion.
 */
export function isValidAppId(value: string): boolean {
  return /^\d+$/.test(value) && Number.parseInt(value, 10) > 0;
}

/**
 * Shared with access.ts, which extracts this same shape from a registry
 * entry's `accessPolicy.installationId`. A GitHub installation id is also
 * always a positive integer. Accepting `unknown` (not just `string`) is
 * what lets both call sites — one reading an env var string, one reading a
 * value already parsed out of a MongoDB document — use the same check.
 */
export function isValidInstallationId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Shape only — never a proof the key is valid or that it belongs to a real
 * App. Mirrors `isMongoUri`'s own "this is a shape check only" contract in
 * env.ts. The actual cryptographic validity of the key is discovered the
 * first time jwt.ts tries to sign with it, not here.
 */
export function looksLikePemPrivateKey(value: string): boolean {
  return /^-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+-----END (?:RSA )?PRIVATE KEY-----\s*$/.test(
    value.trim(),
  );
}

/**
 * The GitHub App integration's configuration group. Like
 * `loadNeutaraConfig`/`loadOpenAiConfig`, absent is a valid, non-fatal
 * state — nothing in this service starts, blocks, or refuses to boot over
 * a missing GitHub App configuration, because nothing consumes it yet
 * (Stage 2 stops at authentication; there is no run-execution worker to
 * wire this into).
 */
export function loadGitHubAppConfig(source: EnvSource): GitHubAppConfigResult {
  const rawAppId = present(source, GITHUB_APP_ID_VARIABLE);
  const privateKey = present(source, GITHUB_APP_PRIVATE_KEY_VARIABLE);

  const missing = [
    rawAppId === undefined ? GITHUB_APP_ID_VARIABLE : null,
    privateKey === undefined ? GITHUB_APP_PRIVATE_KEY_VARIABLE : null,
  ].filter((name): name is string => name !== null);

  if (missing.length > 0) {
    return {
      configured: false,
      reason: `${missing.join(', ')} not set; GitHub App integration is disabled`,
    };
  }

  if (!isValidAppId(rawAppId!)) {
    return {
      configured: false,
      reason: `${GITHUB_APP_ID_VARIABLE} is invalid (expected a positive integer)`,
    };
  }

  if (!looksLikePemPrivateKey(privateKey!)) {
    return {
      configured: false,
      // Never quotes the value — a malformed key is still a secret in shape.
      reason: `${GITHUB_APP_PRIVATE_KEY_VARIABLE} is invalid (expected a PEM-format private key)`,
    };
  }

  return {
    configured: true,
    config: { appId: Number.parseInt(rawAppId!, 10), privateKey: privateKey! },
  };
}
