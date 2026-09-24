/**
 * Writes GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY into the local .env from
 * a downloaded GitHub App private key file, without the key ever being
 * printed, pasted into a terminal, or sent through a browser.
 *
 *   npm run github:configure -- <app-id> <path-to-downloaded.pem>
 *
 * Why a script and not a console page: the private key lets its holder act
 * as the GitHub App on every repository the App is installed on. `.env` is
 * the only place credentials live in this project (README.md), and a web
 * form would mean shipping the key through the browser and persisting it
 * somewhere the service can read. This reads the file locally and writes
 * the one file that is already gitignored for exactly this purpose.
 *
 * The key is stored as a double-quoted multi-line value, which Node's
 * --env-file parser (Node 22) reads back verbatim — newlines included —
 * and which github-app/config.ts's PEM shape check accepts unchanged.
 *
 * Output names what happened and a short, non-reversible fingerprint (so
 * two runs can be compared), never any part of the key itself.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { GITHUB_APP_ID_VARIABLE, GITHUB_APP_PRIVATE_KEY_VARIABLE, isValidAppId, looksLikePemPrivateKey } from '../github-app/config.ts';

/**
 * Returns `env` with `name` set to `value`, replacing an existing entry —
 * including a multi-line double-quoted one — or appending a new line.
 * Every other line is kept byte-for-byte.
 */
export function upsertEnvValue(env: string, name: string, value: string): string {
  const lines = env.split(/\r?\n/);
  const out: string[] = [];
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.startsWith(`${name}=`)) {
      out.push(line);
      continue;
    }
    // Skip the old value, including the continuation lines of a quoted multi-line one.
    const rest = line.slice(name.length + 1);
    const closedOnSameLine = rest.length > 1 && /"\s*$/.test(rest);
    if (rest.startsWith('"') && !closedOnSameLine) {
      while (i + 1 < lines.length) {
        i++;
        if (/"\s*$/.test(lines[i]!)) break;
      }
    }
    if (!replaced) out.push(`${name}=${value}`);
    replaced = true;
  }
  if (!replaced) {
    while (out.length > 0 && out[out.length - 1] === '') out.pop();
    out.push(`${name}=${value}`, '');
  }
  return out.join('\n');
}

/** The quoted .env form of a PEM: real newlines, no trailing whitespace, no embedded quotes. */
export function pemEnvValue(pem: string): string {
  const normalized = pem.replace(/\r\n/g, '\n').trim();
  if (normalized.includes('"')) throw new Error('the key file contains a double quote; it is not a PEM private key');
  return `"${normalized}"`;
}

export function fingerprint(pem: string): string {
  return createHash('sha256').update(pem.replace(/\r\n/g, '\n').trim()).digest('hex').slice(0, 12);
}

// ── CLI ──────────────────────────────────────────────────────────────────
if (process.argv[1]?.endsWith('configure-github-app.ts')) {
  const [appId, pemPath] = process.argv.slice(2);
  const fail = (message: string): never => {
    console.error(message);
    process.exit(64); // EX_USAGE
  };

  if (appId === undefined || pemPath === undefined) fail('usage: npm run github:configure -- <app-id> <path-to-downloaded.pem>');
  if (!isValidAppId(appId!.trim())) fail(`the App ID must be a positive number (you gave '${appId}')`);
  if (!existsSync(pemPath!)) fail(`no file at ${pemPath} — check the path to the downloaded .pem`);
  if (!existsSync('.env')) fail('no .env in this folder — run this from the aisdlc-service folder');

  const pem = readFileSync(pemPath!, 'utf8');
  if (!looksLikePemPrivateKey(pem)) fail(`${pemPath} does not look like a PEM private key (expected "-----BEGIN ... PRIVATE KEY-----")`);

  let env = readFileSync('.env', 'utf8');
  env = upsertEnvValue(env, GITHUB_APP_ID_VARIABLE, appId!.trim());
  env = upsertEnvValue(env, GITHUB_APP_PRIVATE_KEY_VARIABLE, pemEnvValue(pem));
  writeFileSync('.env', env);

  console.log(`.env updated: ${GITHUB_APP_ID_VARIABLE}=${appId!.trim()}, ${GITHUB_APP_PRIVATE_KEY_VARIABLE}=(key, fingerprint ${fingerprint(pem)})`);
  console.log('The key itself was not printed. Restart `npm run dev` so the service picks it up.');
  console.log(`You can now move ${pemPath} somewhere safe, or delete it — .env holds the only copy the service needs.`);
}
