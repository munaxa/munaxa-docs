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

/** Every event type this module publishes, for the outbox's routing table. */
export const IDENTITY_EVENT_TYPES: readonly string[] = Object.freeze([
  USER_CREATED,
  USER_DISABLED,
  USER_ROLES_CHANGED,
  DELEGATION_APPROVED,
  DELEGATION_REVOKED,
]);

export type IdentityEvent = DomainEventDraft;
