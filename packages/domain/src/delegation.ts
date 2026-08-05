import { DelegationRefusal, type DelegationRefusalKey } from './enums/delegation';
import type { PermissionKey } from './permissions';

/**
 * The rules of §4 that are arithmetic rather than I/O.
 *
 * `07-workflow-architecture.md` §4 states six properties of a delegation, and three of them are
 * decidable from values alone: the period is bounded, a chain is at most one hop, and a chain is
 * never a cycle. They live here rather than in the use case for the reason the working-day
 * calendar does — the API refuses on them and the delegation screen has to predict the same
 * refusal before somebody presses the button, and two implementations of "is this a cycle" is one
 * implementation too many.
 *
 * What is deliberately **not** here is the authority check. "Does the delegator still hold this
 * permission" is a question about the world at an instant, not about these values, and §4 requires
 * it at decision time — so it belongs to whoever can read the delegator's current grants, which is
 * Identity. Putting a stale copy of the delegator's permissions into a pure function would be
 * exactly the "checked at creation" the section forbids.
 */

/** The maximum depth a chain may reach when a tenant permits chaining at all: one hop. */
export const MAXIMUM_DELEGATION_DEPTH = 1;

/**
 * A delegation reduced to what the rules below need.
 *
 * Deliberately not the persistence record: these functions are called with rows loaded from the
 * database *and* with a delegation that does not exist yet, and a shape carrying an id would make
 * the second case require a fake one.
 */
export interface DelegationEdge {
  readonly delegatorId: string;
  readonly delegateId: string;
  /** Zero for a delegation of the delegator's own authority; one for a re-delegation. */
  readonly depth: number;
}

export const DelegationPeriodProblem = {
  /** `ends_at` is at or before `starts_at`. The database's check constraint says the same. */
  NOT_ORDERED: 'NOT_ORDERED',
  /** Already over before it began — an end date in the past authorises nothing, ever. */
  ALREADY_ENDED: 'ALREADY_ENDED',
  /** Longer than the tenant permits. §4: "bounded; open-ended delegations are refused". */
  TOO_LONG: 'TOO_LONG',
} as const;

export type DelegationPeriodProblemKey =
  (typeof DelegationPeriodProblem)[keyof typeof DelegationPeriodProblem];

const MILLISECONDS_PER_DAY = 86_400_000;

/**
 * Whether a stated period is one the tenant will accept.
 *
 * Null when it is. The maximum is passed in rather than read here because it is a tenant setting
 * and this file may not read settings — and because the emergency maximum and the ordinary one are
 * two different numbers applied by the same arithmetic.
 *
 * The comparison is against `now` rather than only against `startsAt`, which is what makes
 * "already ended" a distinct answer from "not ordered": a period that runs from last Tuesday to
 * last Friday is perfectly well ordered and authorises nothing.
 */
export function delegationPeriodProblem(period: {
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly now: Date;
  readonly maximumDays: number;
}): DelegationPeriodProblemKey | null {
  if (period.endsAt.getTime() <= period.startsAt.getTime()) {
    return DelegationPeriodProblem.NOT_ORDERED;
  }
  if (period.endsAt.getTime() <= period.now.getTime()) {
    return DelegationPeriodProblem.ALREADY_ENDED;
  }
  const days = (period.endsAt.getTime() - period.startsAt.getTime()) / MILLISECONDS_PER_DAY;
  return days > period.maximumDays ? DelegationPeriodProblem.TOO_LONG : null;
}

export const DelegationChainProblem = {
  /** The delegator is already somebody's delegate and the tenant forbids re-delegation. */
  CHAINING_FORBIDDEN: 'CHAINING_FORBIDDEN',
  /** Chaining is permitted, and this would be the second hop. Never permitted, by any setting. */
  TOO_DEEP: 'TOO_DEEP',
  /**
   * The authority would come back to somebody who has already passed it on.
   *
   * Refused whatever the setting says. §4 permits "one hop, never a cycle", and a cycle is not a
   * depth problem: A → B → A is two edges of depth one each, and counting hops would wave it
   * through. It is a reachability problem, so it is answered by walking.
   */
  CYCLE: 'CYCLE',
} as const;

export type DelegationChainProblemKey =
  (typeof DelegationChainProblem)[keyof typeof DelegationChainProblem];

/**
 * Whether a proposed delegation is a chain the tenant permits, and not a cycle.
 *
 * `live` is every delegation currently in force in the tenant, as edges. That is a whole-tenant
 * read for one decision, and it is the right shape anyway: a cycle is a property of the graph
 * rather than of any pair in it, and the graph is tiny — a delegation is a temporary arrangement
 * a handful of people have at any moment, not a row per document.
 *
 * The depth of the proposed edge is derived rather than supplied: it is one more than the deepest
 * live delegation *into* the proposer, or zero when they are nobody's delegate. Supplying it would
 * let a caller assert depth zero for a re-delegation, which is the one lie this function exists to
 * catch.
 */
export function delegationChainProblem(input: {
  readonly delegatorId: string;
  readonly delegateId: string;
  readonly live: readonly DelegationEdge[];
  readonly chainingAllowed: boolean;
}): DelegationChainProblemKey | null {
  // The cycle is looked for **first**, and the order is load-bearing rather than stylistic. A → B
  // exists and B → A is proposed: that is one hop by the depth counter, so a depth-first ordering
  // would answer `CHAINING_FORBIDDEN` with chaining off and `TOO_DEEP` at the far end — both of
  // which read as "raise the setting" when the true answer is "never". A cycle is refused whatever
  // the tenant has configured, so it is the question asked before any configurable one.
  //
  // Self-delegation is the degenerate case and falls out of the same walk rather than needing a
  // special case above it.
  if (reachesBack(input.delegatorId, input.delegateId, input.live)) {
    return DelegationChainProblem.CYCLE;
  }

  const depth = proposedDelegationDepth(input.delegatorId, input.live);
  if (depth > 0 && !input.chainingAllowed) {
    return DelegationChainProblem.CHAINING_FORBIDDEN;
  }
  return depth > MAXIMUM_DELEGATION_DEPTH ? DelegationChainProblem.TOO_DEEP : null;
}

/**
 * How deep a delegation created *by* this person would sit.
 *
 * Zero when they hold their own authority; one more than the deepest delegation into them
 * otherwise. Exported because the row is written with it and the write must not re-derive it
 * differently from the check.
 */
export function proposedDelegationDepth(
  delegatorId: string,
  live: readonly DelegationEdge[],
): number {
  let deepest = -1;
  for (const edge of live) {
    if (edge.delegateId === delegatorId && edge.depth > deepest) {
      deepest = edge.depth;
    }
  }
  return deepest + 1;
}

/**
 * Whether authority handed to `delegateId` could arrive back at `delegatorId`.
 *
 * A breadth-first walk forward along live edges from the proposed delegate. Visited nodes are
 * tracked, so a graph that already contains a cycle — which nothing should be able to write, but
 * which a walk must survive rather than hang on — terminates.
 */
function reachesBack(
  delegatorId: string,
  delegateId: string,
  live: readonly DelegationEdge[],
): boolean {
  if (delegateId === delegatorId) {
    return true;
  }
  const outgoing = new Map<string, string[]>();
  for (const edge of live) {
    const existing = outgoing.get(edge.delegatorId);
    if (existing === undefined) {
      outgoing.set(edge.delegatorId, [edge.delegateId]);
    } else {
      existing.push(edge.delegateId);
    }
  }

  const seen = new Set<string>([delegateId]);
  const queue: string[] = [delegateId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const next of outgoing.get(current) ?? []) {
      if (next === delegatorId) {
        return true;
      }
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

/**
 * Whether a delegation's period covers an instant.
 *
 * Half-open — `startsAt` inclusive, `endsAt` exclusive — so a delegation ending at nine and one
 * starting at nine are never both in force for the same millisecond. The predicate is here rather
 * than inlined at its call sites because it is the *whole* of what makes an expired delegation
 * inert: no job has to have run, and a stalled queue can never leave one authorising.
 */
export function delegationCoversInstant(
  period: { readonly startsAt: Date; readonly endsAt: Date },
  at: Date,
): boolean {
  const instant = at.getTime();
  return period.startsAt.getTime() <= instant && instant < period.endsAt.getTime();
}

/**
 * The refusal, if any, for one delegation being used to exercise one permission at one instant.
 *
 * Everything except the delegator's current authority, which the caller supplies as
 * `delegatorHolds` — read at the moment of the decision, never copied onto the delegation when it
 * was created. The order matters and is the order §4 reads in: is it in force, is it current, does
 * it name this permission, and does the delegator still hold it. The last question is asked last
 * because it is the expensive one and because its answer is the one worth telling somebody about.
 */
export function delegationRefusalFor(input: {
  readonly inForce: boolean;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly permissions: readonly PermissionKey[];
  readonly permission: PermissionKey;
  readonly delegatorHolds: readonly PermissionKey[];
  readonly at: Date;
}): DelegationRefusalKey | null {
  if (!input.inForce) {
    return DelegationRefusal.NOT_IN_FORCE;
  }
  if (!delegationCoversInstant(input, input.at)) {
    return DelegationRefusal.OUTSIDE_PERIOD;
  }
  if (!input.permissions.includes(input.permission)) {
    return DelegationRefusal.PERMISSION_NOT_DELEGATED;
  }
  if (!input.delegatorHolds.includes(input.permission)) {
    return DelegationRefusal.DELEGATOR_LACKS_AUTHORITY;
  }
  return null;
}
