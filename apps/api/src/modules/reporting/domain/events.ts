import { type DomainEventDraft, defineEvent } from '@edms/domain';

/**
 * Reporting's domain events.
 *
 * An event is a fact in the past tense, its payload shape never changes once shipped, and
 * delivery is at least once — so every handler is idempotent on `eventId`
 * (`docs/architecture/02-backend-architecture.md` §6).
 *
 * The payloads are deliberately thin: an event carries identifiers and the facts a consumer
 * cannot derive, never a copy of the aggregate. A fat event becomes a second schema that
 * nobody migrates.
 */
export const REPORTING_AGGREGATE = 'reporting';

/** A queued export finished and is available for download. */
export const REPORT_EXPORT_READY = 'reporting.export-ready' as const;

export interface ReportExportReadyPayload {
  readonly exportId: string;
  readonly reportKey: string;
  readonly rowCount: number;
  readonly storageKey: string;
}

export const reportExportReadyEvent = defineEvent<
  typeof REPORT_EXPORT_READY,
  ReportExportReadyPayload
>(REPORT_EXPORT_READY, 1, REPORTING_AGGREGATE);

/** Every event type this module publishes, for the outbox's routing table. */
export const REPORTING_EVENT_TYPES: readonly string[] = Object.freeze([REPORT_EXPORT_READY]);

export type ReportingEvent = DomainEventDraft;
