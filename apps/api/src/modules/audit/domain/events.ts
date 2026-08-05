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

/**
 * A verification pass completed; carries the range and the count.
 *
 * The range is a pair of **sequences**, not timestamps, and Phase 9 is what settled that. A pass
 * resumes from the last signed checkpoint and stops at the tail or at its budget, so what it
 * covered is "from this position to that one" — a time range would be a re-description of the
 * same fact that a reader would then have to translate back to ask "and where does the next pass
 * start". Serialised as strings because a sequence is a `bigint` and JSON has no such thing.
 */
export const AUDIT_CHAIN_VERIFIED = 'audit.chain-verified' as const;

export interface AuditChainVerifiedPayload {
  /** The sequence the pass resumed from — the previous checkpoint's, or `0`. */
  readonly from: string;
  /** The sequence it reached, and therefore where the next pass begins. */
  readonly to: string;
  readonly eventsVerified: number;
  /** False when the deployment could not record a signed checkpoint; the pass still ran. */
  readonly checkpointed: boolean;
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
  /**
   * Which of the three accusations this is: `DIGEST_MISMATCH` (a field was altered),
   * `LINK_MISMATCH` (a record was inserted or removed mid-chain), or `SEQUENCE_GAP` (a record
   * was removed and took its link with it — the hole a hash alone cannot see).
   */
  readonly reason: string;
}

export const auditChainBrokenEvent = defineEvent<
  typeof AUDIT_CHAIN_BROKEN,
  AuditChainBrokenPayload
>(AUDIT_CHAIN_BROKEN, 1, AUDIT_AGGREGATE);

/** An evidence bundle is available for download. */
export const AUDIT_EXPORT_READY = 'audit.export-ready' as const;

export interface AuditExportReadyPayload {
  readonly exportId: string;
  /** The prefix the bundle's objects live under; the manifest inside it lists them. */
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
