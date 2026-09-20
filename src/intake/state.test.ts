import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { INTAKE_STATUSES, type IntakeStatus } from '../db/collections.ts';
import {
  INITIAL_INTAKE_STATUS,
  INTAKE_TRANSITIONS,
  InvalidTransitionError,
  assertTransition,
  canTransition,
  isTerminal,
} from './state.ts';

describe('the transition table', () => {
  it('covers every declared status', () => {
    assert.deepEqual(Object.keys(INTAKE_TRANSITIONS).sort(), [...INTAKE_STATUSES].sort());
  });

  it('only ever targets a declared status', () => {
    for (const [from, targets] of Object.entries(INTAKE_TRANSITIONS)) {
      for (const to of targets) {
        assert.ok(
          (INTAKE_STATUSES as readonly string[]).includes(to),
          `${from} -> ${to} targets an unknown status`,
        );
      }
    }
  });

  it('never allows a self-transition', () => {
    for (const [from, targets] of Object.entries(INTAKE_TRANSITIONS)) {
      assert.ok(!targets.includes(from as IntakeStatus), `${from} can transition to itself`);
    }
  });

  it('starts new items in received', () => {
    assert.equal(INITIAL_INTAKE_STATUS, 'received');
  });

  it('makes every status reachable from received', () => {
    // A status nothing can reach is dead code in the validator enum.
    const seen = new Set<IntakeStatus>([INITIAL_INTAKE_STATUS]);
    const queue: IntakeStatus[] = [INITIAL_INTAKE_STATUS];
    while (queue.length > 0) {
      for (const next of INTAKE_TRANSITIONS[queue.shift()!]) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    assert.deepEqual([...seen].sort(), [...INTAKE_STATUSES].sort());
  });
});

describe('canTransition', () => {
  it('allows the intended happy path', () => {
    assert.ok(canTransition('received', 'pending_approval'));
    assert.ok(canTransition('pending_approval', 'approved'));
    assert.ok(canTransition('pending_approval', 'rejected'));
  });

  it('allows failure from either working state', () => {
    assert.ok(canTransition('received', 'failed'));
    assert.ok(canTransition('pending_approval', 'failed'));
  });

  it('refuses to skip the approval gate', () => {
    // This is the important one: nothing may reach `approved` without
    // passing through `pending_approval`.
    assert.ok(!canTransition('received', 'approved'));
  });

  it('refuses to move out of a terminal state', () => {
    for (const terminal of ['approved', 'rejected', 'failed'] as const) {
      for (const target of INTAKE_STATUSES) {
        assert.ok(!canTransition(terminal, target), `${terminal} -> ${target} should be illegal`);
      }
    }
  });

  it('refuses to un-reject or un-approve', () => {
    assert.ok(!canTransition('rejected', 'approved'));
    assert.ok(!canTransition('approved', 'rejected'));
  });
});

describe('isTerminal', () => {
  it('identifies exactly the terminal states', () => {
    assert.deepEqual(INTAKE_STATUSES.filter(isTerminal), ['approved', 'rejected', 'failed']);
  });

  it('treats the working states as non-terminal', () => {
    assert.ok(!isTerminal('received'));
    assert.ok(!isTerminal('pending_approval'));
  });
});

describe('assertTransition', () => {
  it('passes a legal transition silently', () => {
    assert.doesNotThrow(() => assertTransition('received', 'pending_approval'));
  });

  it('throws with the allowed targets listed', () => {
    assert.throws(
      () => assertTransition('received', 'approved'),
      (error: unknown) => {
        assert.ok(error instanceof InvalidTransitionError);
        assert.equal(error.from, 'received');
        assert.equal(error.to, 'approved');
        assert.match(error.message, /pending_approval, failed/);
        return true;
      },
    );
  });

  it('says so plainly when the source state is terminal', () => {
    assert.throws(() => assertTransition('approved', 'failed'), /'approved' is terminal/);
  });
});
