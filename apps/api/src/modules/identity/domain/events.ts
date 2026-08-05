import { type DomainEventDraft, defineEvent } from '@edms/domain';

/**
 * Identity's domain events.
 *
 * An event is a fact in the past tense, its payload shape never changes once shipped, and
 * delivery is at least once — so every handler is idempotent on `eventId`
 * (`docs/architecture/02-backend-architecture.md` §6).
 *
 * The payloads are deliberately thin: an event carries identifiers and the facts a consumer
 * cannot derive, never a copy of the aggregate. A fat event becomes a second schema that
 * nobody migrates.
 */
export const IDENTITY_AGGREGATE = 'identity';

/** A user record exists; it may not have signed in yet. */
export const USER_CREATED = 'user.created' as const;

export interface UserCreatedPayload {
  readonly userId: string;
  readonly email: string;
  readonly invited: boolean;
}

export const userCreatedEvent = defineEvent<typeof USER_CREATED, UserCreatedPayload>(
  USER_CREATED,
  1,
  IDENTITY_AGGREGATE,
);

/** Sessions are revoked and the user holds no access from this moment. */
export const USER_DISABLED = 'user.disabled' as const;

export interface UserDisabledPayload {
  readonly userId: string;
  readonly reason: string;
  readonly sessionsRevoked: number;
}

export const userDisabledEvent = defineEvent<typeof USER_DISABLED, UserDisabledPayload>(
  USER_DISABLED,
  1,
  IDENTITY_AGGREGATE,
);

/** Forces permission re-evaluation and cache invalidation. */
export const USER_ROLES_CHANGED = 'user.roles-changed' as const;

export interface UserRolesChangedPayload {
  readonly userId: string;
  readonly roleIds: readonly string[];
  readonly permissionVersion: number;
}

export const userRolesChangedEvent = defineEvent<
  typeof USER_ROLES_CHANGED,
  UserRolesChangedPayload
>(USER_ROLES_CHANGED, 1, IDENTITY_AGGREGATE);

/**
 * Somebody has asked to delegate, and somebody has to agree.
 *
 * Added by Phase 11 beside the two Phase 1 declared. It is a separate event from
 * `delegation.approved` rather than a status field on it because the audiences differ: this one is
 * addressed to whoever must approve, and the approval is addressed to the two parties. A single
 * event carrying a status would make every consumer branch on it to find out whether it was for
 * them.
 *
 * Delivery is Phase 12's. The outbox row is the record until a consumer exists — the position
 * Phase 4 took for `workflow.*`, Phase 9 for `audit.chain-broken` and Phase 10 for `retention.due`.
 */
export const DELEGATION_REQUESTED = 'delegation.requested' as const;

export interface DelegationRequestedPayload {
  readonly delegationId: string;
  readonly delegatorId: string;
  readonly delegateId: string;
  /** Who may agree to it — the delegator's managers, resolved when the request was made. */
  readonly approverIds: readonly string[];
  readonly startsAt: string;
  readonly endsAt: string;
}

export const delegationRequestedEvent = defineEvent<
  typeof DELEGATION_REQUESTED,
  DelegationRequestedPayload
>(DELEGATION_REQUESTED, 1, IDENTITY_AGGREGATE);

/** The delegate may act for the delegator within the stated scope and period. */
export const DELEGATION_APPROVED = 'delegation.approved' as const;

export interface DelegationApprovedPayload {
  readonly delegationId: string;
  readonly delegatorId: string;
  readonly delegateId: string;
  readonly startsAt: string;
  readonly endsAt: string;
}

export const delegationApprovedEvent = defineEvent<
  typeof DELEGATION_APPROVED,
  DelegationApprovedPayload
>(DELEGATION_APPROVED, 1, IDENTITY_AGGREGATE);

/** Ends a delegation before its end date. */
export const DELEGATION_REVOKED = 'delegation.revoked' as const;

export interface DelegationRevokedPayload {
  readonly delegationId: string;
  readonly revokedBy: string;
  readonly reason: string;
}

export const delegationRevokedEvent = defineEvent<
  typeof DELEGATION_REVOKED,
  DelegationRevokedPayload
>(DELEGATION_REVOKED, 1, IDENTITY_AGGREGATE);

/**
 * A delegation's period ended.
 *
 * Published by the nightly sweep, one per delegation it records. Both parties are told, because
 * §4's visibility rule runs in both directions: the delegator's cover has ended and the delegate
 * is no longer able to act, and neither of them asked for it to happen — a clock did.
 */
export const DELEGATION_EXPIRED = 'delegation.expired' as const;

export interface DelegationExpiredPayload {
  readonly delegationId: string;
  readonly delegatorId: string;
  readonly delegateId: string;
  readonly endsAt: string;
  /** How many decisions were taken under it, so the notice can say whether it was used at all. */
  readonly useCount: number;
}

export const delegationExpiredEvent = defineEvent<
  typeof DELEGATION_EXPIRED,
  DelegationExpiredPayload
>(DELEGATION_EXPIRED, 1, IDENTITY_AGGREGATE);

/** Every event type this module publishes, for the outbox's routing table. */
export const IDENTITY_EVENT_TYPES: readonly string[] = Object.freeze([
  USER_CREATED,
  USER_DISABLED,
  USER_ROLES_CHANGED,
  DELEGATION_REQUESTED,
  DELEGATION_APPROVED,
  DELEGATION_REVOKED,
  DELEGATION_EXPIRED,
]);

export type IdentityEvent = DomainEventDraft;
