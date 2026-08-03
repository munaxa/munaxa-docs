import { type DomainEventDraft, defineEvent } from '@edms/domain';

/**
 * Audit's domain events.
 *
 * An event is a fact in the past tense, its payload shape never changes once shipped, and
 * delivery is at least once — so every handler is idempotent on `eventId`
 * (`docs/architecture/02-backend-architecture.md` §6).
 *
 * The payloads are deliberately thin: an event carries identifiers and the facts a consumer
 * cannot derive, never a copy of the aggregate. A fat event becomes a second schema that
 * nobody migrates.
 */
export const AUDIT_AGGREGATE = 'audit';

/** A verification pass completed; carries the range and the count. */
export const AUDIT_CHAIN_VERIFIED = 'audit.chain-verified' as const;

export interface AuditChainVerifiedPayload {
  readonly from: string;
  readonly to: string;
  readonly eventsVerified: number;
}

export const auditChainVerifiedEvent = defineEvent<
  typeof AUDIT_CHAIN_VERIFIED,
  AuditChainVerifiedPayload
>(AUDIT_CHAIN_VERIFIED, 1, AUDIT_AGGREGATE);

/** A digest failed to recompute. Highest severity, immediate alert. */
export const AUDIT_CHAIN_BROKEN = 'audit.chain-broken' as const;

export interface AuditChainBrokenPayload {
  readonly brokenAtEventId: string;
  readonly expectedHash: string;
  readonly actualHash: string;
}

export const auditChainBrokenEvent = defineEvent<
  typeof AUDIT_CHAIN_BROKEN,
  AuditChainBrokenPayload
>(AUDIT_CHAIN_BROKEN, 1, AUDIT_AGGREGATE);

/** An evidence bundle is available for download. */
export const AUDIT_EXPORT_READY = 'audit.export-ready' as const;

export interface AuditExportReadyPayload {
  readonly exportId: string;
  readonly storageKey: string;
  readonly eventCount: number;
}

export const auditExportReadyEvent = defineEvent<
  typeof AUDIT_EXPORT_READY,
  AuditExportReadyPayload
>(AUDIT_EXPORT_READY, 1, AUDIT_AGGREGATE);

/** Every event type this module publishes, for the outbox's routing table. */
export const AUDIT_EVENT_TYPES: readonly string[] = Object.freeze([
  AUDIT_CHAIN_VERIFIED,
  AUDIT_CHAIN_BROKEN,
  AUDIT_EXPORT_READY,
]);

export type AuditEvent = DomainEventDraft;
