import { type DomainEventDraft, defineEvent } from '@edms/domain';

/**
 * Organization's domain events.
 *
 * An event is a fact in the past tense, its payload shape never changes once shipped, and
 * delivery is at least once — so every handler is idempotent on `eventId`
 * (`docs/architecture/02-backend-architecture.md` §6).
 *
 * The payloads are deliberately thin: an event carries identifiers and the facts a consumer
 * cannot derive, never a copy of the aggregate. A fat event becomes a second schema that
 * nobody migrates.
 */
export const ORGANIZATION_AGGREGATE = 'organization';

/** Ancestry changed, so inherited permissions changed with it. */
export const DEPARTMENT_MOVED = 'organization.department-moved' as const;

export interface DepartmentMovedPayload {
  readonly departmentId: string;
  readonly fromParentId: string | null;
  readonly toParentId: string;
  readonly path: string;
}

export const departmentMovedEvent = defineEvent<typeof DEPARTMENT_MOVED, DepartmentMovedPayload>(
  DEPARTMENT_MOVED,
  1,
  ORGANIZATION_AGGREGATE,
);

/** A node is retired; its libraries stay readable. */
export const ORGANIZATION_NODE_ARCHIVED = 'organization.node-archived' as const;

export interface OrganizationNodeArchivedPayload {
  readonly nodeId: string;
  readonly scopeType: string;
}

export const organizationNodeArchivedEvent = defineEvent<
  typeof ORGANIZATION_NODE_ARCHIVED,
  OrganizationNodeArchivedPayload
>(ORGANIZATION_NODE_ARCHIVED, 1, ORGANIZATION_AGGREGATE);

/** Every event type this module publishes, for the outbox's routing table. */
export const ORGANIZATION_EVENT_TYPES: readonly string[] = Object.freeze([
  DEPARTMENT_MOVED,
  ORGANIZATION_NODE_ARCHIVED,
]);

export type OrganizationEvent = DomainEventDraft;
