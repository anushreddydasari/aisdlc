/**
 * Precondition check before an intake snapshot is analyzed.
 *
 * The intakeItems validator already requires title, description and
 * issueType to be strings (see INTAKE_ITEM_SCHEMA), but a string can still be
 * empty — Neutara has sent malformed payloads before (see the webhook
 * validator's nullable fields). This is what stops that from reaching the
 * analyzer as unusable input.
 */

import type { IntakeSnapshot } from '../intake/repository.ts';

export type SnapshotValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

const REQUIRED_FIELDS: readonly (keyof Pick<IntakeSnapshot, 'title' | 'description' | 'issueType'>)[] = [
  'title',
  'description',
  'issueType',
];

export function validateSnapshotForRequirements(snapshot: IntakeSnapshot): SnapshotValidationResult {
  const missing = REQUIRED_FIELDS.filter((field) => snapshot[field].trim() === '');

  if (missing.length > 0) {
    return {
      ok: false,
      reason: `intake snapshot is missing required field(s): ${missing.join(', ')}`,
    };
  }

  return { ok: true };
}
