import { type DomainEventDraft, defineEvent } from '@edms/domain';

/**
 * Preview's domain events.
 *
 * An event is a fact in the past tense, its payload shape never changes once shipped, and
 * delivery is at least once — so every handler is idempotent on `eventId`
 * (`docs/architecture/02-backend-architecture.md` §6).
 *
 * The payloads are deliberately thin: an event carries identifiers and the facts a consumer
 * cannot derive, never a copy of the aggregate. A fat event becomes a second schema that
 * nobody migrates.
 */
export const PREVIEW_AGGREGATE = 'preview';

/** Artefacts exist for a revision and can be served. */
export const PREVIEW_RENDERED = 'preview.rendered' as const;

export interface PreviewRenderedPayload {
  readonly revisionId: string;
  readonly pageCount: number;
  readonly renderer: string;
  readonly rendererVersion: string;
}

export const previewRenderedEvent = defineEvent<typeof PREVIEW_RENDERED, PreviewRenderedPayload>(
  PREVIEW_RENDERED,
  1,
  PREVIEW_AGGREGATE,
);

/** Rendering hit a limit or an unsupported format; the reason is operator-visible. */
export const PREVIEW_FAILED = 'preview.failed' as const;

export interface PreviewFailedPayload {
  readonly revisionId: string;
  readonly reason: string;
  readonly renderer: string | null;
}

export const previewFailedEvent = defineEvent<typeof PREVIEW_FAILED, PreviewFailedPayload>(
  PREVIEW_FAILED,
  1,
  PREVIEW_AGGREGATE,
);

/** Extracted text is available to the search projection. */
export const OCR_COMPLETED = 'preview.ocr-completed' as const;

export interface OcrCompletedPayload {
  readonly revisionId: string;
  readonly language: string;
  readonly confidence: number;
  readonly characterCount: number;
}

export const ocrCompletedEvent = defineEvent<typeof OCR_COMPLETED, OcrCompletedPayload>(
  OCR_COMPLETED,
  1,
  PREVIEW_AGGREGATE,
);

/** Every event type this module publishes, for the outbox's routing table. */
export const PREVIEW_EVENT_TYPES: readonly string[] = Object.freeze([
  PREVIEW_RENDERED,
  PREVIEW_FAILED,
  OCR_COMPLETED,
]);

export type PreviewEvent = DomainEventDraft;
