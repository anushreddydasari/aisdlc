/**
 * Content hashing for intake snapshots.
 *
 * `sourceHash` is what makes `checkpoints.inputHash` meaningful: a completed
 * checkpoint may only be reused on resume if the intake content behind it is
 * unchanged. That comparison is only sound if the hash is stable — the same
 * logical content must always produce the same digest, whatever order the
 * fields arrived in.
 *
 * `JSON.stringify` is not stable: it preserves insertion order, so two
 * objects with identical content but different key order hash differently.
 * Hence the explicit canonicalization below.
 */

import { createHash } from 'node:crypto';

/**
 * Serializes a value with object keys sorted, recursively.
 *
 * Rules, all chosen so that "same content" means "same string":
 *   - object keys sorted lexicographically
 *   - array order preserved (order is content for a list)
 *   - `undefined` properties omitted, matching JSON semantics
 *   - `Date` rendered as an ISO string
 *   - `null` preserved, and distinct from an absent key
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'null';

  if (value instanceof Date) return JSON.stringify(value.toISOString());

  const type = typeof value;
  if (type === 'string' || type === 'boolean') return JSON.stringify(value);
  if (type === 'number') {
    // NaN and Infinity have no JSON form and would silently become null,
    // collapsing distinct values onto the same hash.
    if (!Number.isFinite(value as number)) {
      throw new TypeError('cannot canonicalize a non-finite number');
    }
    return JSON.stringify(value);
  }
  if (type === 'bigint') return JSON.stringify((value as bigint).toString());

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }

  if (type === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, inner]) => inner !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    return `{${entries
      .map(([key, inner]) => `${JSON.stringify(key)}:${canonicalize(inner)}`)
      .join(',')}}`;
  }

  throw new TypeError(`cannot canonicalize a value of type ${type}`);
}

/** sha256 of the canonical form, as lowercase hex. */
export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}
