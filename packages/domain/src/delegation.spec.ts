import { describe, expect, it } from 'vitest';

import {
  DelegationChainProblem,
  type DelegationEdge,
  DelegationPeriodProblem,
  delegationChainProblem,
  delegationCoversInstant,
  delegationPeriodProblem,
  delegationRefusalFor,
  proposedDelegationDepth,
} from './delegation';
import { DelegationRefusal } from './enums/delegation';
import { Permission, type PermissionKey } from './permissions';

/**
 * The three rules of `07-workflow-architecture.md` §4 that are decidable from values.
 *
 * Each of these is a privilege-escalation defect in its smallest form. A chain that is one hop too
 * deep is an authority two people removed from the person who holds it; a cycle is an authority
 * that never terminates; and an unbounded period is §4's "open-ended delegations are refused"
 * quietly not refused. None of them is visible in an integration test that happens to use two
 * people, which is why they are asserted here as arithmetic.
 */

const ALICE = 'alice';
const BOB = 'bob';
const CAROL = 'carol';
const DAVE = 'dave';

const NOW = new Date('2026-08-05T09:00:00.000Z');

function edge(delegatorId: string, delegateId: string, depth = 0): DelegationEdge {
  return { delegatorId, delegateId, depth };
}

describe('the period', () => {
  it('accepts a bounded period inside the maximum', () => {
    expect(
      delegationPeriodProblem({
        startsAt: NOW,
        endsAt: new Date('2026-08-19T09:00:00.000Z'),
        now: NOW,
        maximumDays: 90,
      }),
    ).toBeNull();
  });

  it('refuses an end at or before its start', () => {
    expect(
      delegationPeriodProblem({
        startsAt: NOW,
        endsAt: NOW,
        now: NOW,
        maximumDays: 90,
      }),
    ).toBe(DelegationPeriodProblem.NOT_ORDERED);
  });

  /**
   * Well ordered and still worthless. The two answers are kept apart because the sentence a person
   * is shown differs: one is "your dates are the wrong way round" and the other is "that is in the
   * past".
   */
  it('refuses a period that is already over', () => {
    expect(
      delegationPeriodProblem({
        startsAt: new Date('2026-07-01T09:00:00.000Z'),
        endsAt: new Date('2026-07-10T09:00:00.000Z'),
        now: NOW,
        maximumDays: 90,
      }),
    ).toBe(DelegationPeriodProblem.ALREADY_ENDED);
  });

  it('refuses a period longer than the tenant permits', () => {
    expect(
      delegationPeriodProblem({
        startsAt: NOW,
        endsAt: new Date('2026-12-05T09:00:00.000Z'),
        now: NOW,
        maximumDays: 90,
      }),
    ).toBe(DelegationPeriodProblem.TOO_LONG);
  });

  /** The emergency path is the same arithmetic with a much smaller number, not a second rule. */
  it('applies the emergency maximum through the same arithmetic', () => {
    const threeDays = { startsAt: NOW, endsAt: new Date('2026-08-08T09:00:00.000Z'), now: NOW };
    expect(delegationPeriodProblem({ ...threeDays, maximumDays: 90 })).toBeNull();
    expect(delegationPeriodProblem({ ...threeDays, maximumDays: 72 / 24 })).toBeNull();
    expect(delegationPeriodProblem({ ...threeDays, maximumDays: 24 / 24 })).toBe(
      DelegationPeriodProblem.TOO_LONG,
    );
  });
});

describe('the chain', () => {
  it('permits an ordinary delegation from somebody who is nobody’s delegate', () => {
    expect(
      delegationChainProblem({
        delegatorId: ALICE,
        delegateId: BOB,
        live: [],
        chainingAllowed: false,
      }),
    ).toBeNull();
  });

  it('refuses re-delegation by default', () => {
    expect(
      delegationChainProblem({
        delegatorId: BOB,
        delegateId: CAROL,
        live: [edge(ALICE, BOB)],
        chainingAllowed: false,
      }),
    ).toBe(DelegationChainProblem.CHAINING_FORBIDDEN);
  });

  it('permits exactly one hop when the tenant allows chaining', () => {
    expect(
      delegationChainProblem({
        delegatorId: BOB,
        delegateId: CAROL,
        live: [edge(ALICE, BOB)],
        chainingAllowed: true,
      }),
    ).toBeNull();
  });

  /** "One hop, never two" — the setting opens the first and can never open the second. */
  it('refuses the second hop even when chaining is allowed', () => {
    expect(
      delegationChainProblem({
        delegatorId: CAROL,
        delegateId: DAVE,
        live: [edge(ALICE, BOB), edge(BOB, CAROL, 1)],
        chainingAllowed: true,
      }),
    ).toBe(DelegationChainProblem.TOO_DEEP);
  });

  /**
   * The assertion the depth counter alone would wave through: A → B and B → A are two edges of
   * depth one, so a hop count says "fine". Reachability says no.
   */
  it('refuses a cycle regardless of the setting', () => {
    for (const chainingAllowed of [true, false]) {
      expect(
        delegationChainProblem({
          delegatorId: BOB,
          delegateId: ALICE,
          live: [edge(ALICE, BOB)],
          chainingAllowed,
        }),
      ).toBe(DelegationChainProblem.CYCLE);
    }
  });

  it('refuses a longer cycle that comes back through a third person', () => {
    expect(
      delegationChainProblem({
        delegatorId: CAROL,
        delegateId: ALICE,
        live: [edge(ALICE, BOB), edge(BOB, CAROL, 1)],
        chainingAllowed: true,
      }),
    ).toBe(DelegationChainProblem.CYCLE);
  });

  it('refuses delegating to oneself', () => {
    expect(
      delegationChainProblem({
        delegatorId: ALICE,
        delegateId: ALICE,
        live: [],
        chainingAllowed: true,
      }),
    ).toBe(DelegationChainProblem.CYCLE);
  });

  /**
   * A graph that already contains a cycle must terminate rather than hang the request.
   *
   * Nothing should be able to write one, and a walk that trusted that would be a walk that spins
   * for ever the day something does. Dave is outside the cycle, so the honest answer is that his
   * delegation is fine — the assertion is that the walk *returns* it.
   */
  it('terminates on a graph that already contains a cycle', () => {
    expect(
      delegationChainProblem({
        delegatorId: DAVE,
        delegateId: ALICE,
        live: [edge(ALICE, BOB), edge(BOB, ALICE, 1)],
        chainingAllowed: true,
      }),
    ).toBeNull();
  });

  it('derives the depth of a proposed delegation rather than trusting one', () => {
    expect(proposedDelegationDepth(ALICE, [])).toBe(0);
    expect(proposedDelegationDepth(BOB, [edge(ALICE, BOB)])).toBe(1);
    expect(proposedDelegationDepth(CAROL, [edge(ALICE, BOB), edge(BOB, CAROL, 1)])).toBe(2);
  });
});

describe('the period predicate', () => {
  const period = {
    startsAt: new Date('2026-08-05T09:00:00.000Z'),
    endsAt: new Date('2026-08-12T09:00:00.000Z'),
  };

  it('is half-open, so two consecutive delegations never overlap', () => {
    expect(delegationCoversInstant(period, period.startsAt)).toBe(true);
    expect(delegationCoversInstant(period, period.endsAt)).toBe(false);
    expect(delegationCoversInstant(period, new Date(period.endsAt.getTime() - 1))).toBe(true);
  });
});

describe('the refusal at decision time', () => {
  const base = {
    inForce: true,
    startsAt: new Date('2026-08-01T00:00:00.000Z'),
    endsAt: new Date('2026-09-01T00:00:00.000Z'),
    permissions: [Permission.DOCUMENT_APPROVE] as readonly PermissionKey[],
    permission: Permission.DOCUMENT_APPROVE,
    delegatorHolds: [Permission.DOCUMENT_APPROVE] as readonly PermissionKey[],
    at: NOW,
  };

  it('authorises when every rule holds', () => {
    expect(delegationRefusalFor(base)).toBeNull();
  });

  it('refuses a delegation that is not in force', () => {
    expect(delegationRefusalFor({ ...base, inForce: false })).toBe(DelegationRefusal.NOT_IN_FORCE);
  });

  it('refuses outside the period', () => {
    expect(delegationRefusalFor({ ...base, at: new Date('2026-09-02T00:00:00.000Z') })).toBe(
      DelegationRefusal.OUTSIDE_PERIOD,
    );
  });

  it('refuses a permission the delegation does not name', () => {
    expect(delegationRefusalFor({ ...base, permissions: [Permission.DOCUMENT_VIEW] })).toBe(
      DelegationRefusal.PERMISSION_NOT_DELEGATED,
    );
  });

  /**
   * §4's central rule: checked at decision time, not at creation. The delegation is untouched and
   * still names the permission — the delegator simply no longer holds it.
   */
  it('refuses when the delegator no longer holds what they delegated', () => {
    expect(delegationRefusalFor({ ...base, delegatorHolds: [Permission.DOCUMENT_VIEW] })).toBe(
      DelegationRefusal.DELEGATOR_LACKS_AUTHORITY,
    );
  });
});
