/**
 * The intake state machine.
 *
 * Kept as data rather than scattered `if` statements so the legal transitions
 * can be read in one place and asserted in tests. Every transition in the
 * system goes through `assertTransition`, so an illegal one fails loudly
 * rather than leaving a row in a state nothing knows how to handle.
 *
 *   received ──→ pending_approval ──→ approved
 *       │                │        └─→ rejected
 *       └──→ failed ←────┘
 */

import type { IntakeStatus } from '../db/collections.ts';

/** The status every new intake item starts in. */
export const INITIAL_INTAKE_STATUS: IntakeStatus = 'received';

export const INTAKE_TRANSITIONS: Readonly<Record<IntakeStatus, readonly IntakeStatus[]>> = {
  received: ['pending_approval', 'failed'],
  pending_approval: ['approved', 'rejected', 'failed'],
  // Terminal. Phase 7 consumes `approved`; nothing moves out of it here.
  approved: [],
  rejected: [],
  // Terminal in Phase 1. Re-ingesting a failed issue is a Phase 3 concern,
  // and would arrive as a new delivery rather than a transition.
  failed: [],
};

export class InvalidTransitionError extends Error {
  readonly from: IntakeStatus;
  readonly to: IntakeStatus;

  constructor(from: IntakeStatus, to: IntakeStatus) {
    const allowed = INTAKE_TRANSITIONS[from];
    super(
      `intake cannot move from '${from}' to '${to}'. ` +
        (allowed.length === 0
          ? `'${from}' is terminal.`
          : `Allowed from '${from}': ${allowed.join(', ')}.`),
    );
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function canTransition(from: IntakeStatus, to: IntakeStatus): boolean {
  return INTAKE_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: IntakeStatus, to: IntakeStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function isTerminal(status: IntakeStatus): boolean {
  return INTAKE_TRANSITIONS[status].length === 0;
}
