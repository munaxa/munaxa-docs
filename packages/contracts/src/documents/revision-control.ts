import { z } from 'zod';

import { isoDateTimeSchema, uuidSchema } from '../common/identifiers';
import { documentFileSchema, revisionStatusSchema } from './document';

/**
 * Revision control — check-out, check-in, publication, history, compare and restore.
 *
 * Two shapes of "date" appear here and they are different on purpose. Instants
 * (`publishedAt`, lock times) are ISO date-times; the effective window is calendar **days**
 * (`YYYY-MM-DD`), because "effective from the 1st" is a statement about a day in the
 * tenant's own calendar, not about a moment in UTC.
 */

const calendarDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A calendar day, as YYYY-MM-DD.');

/**
 * Checking new content in. The upload happened first, through the same pipeline and antivirus
 * gate as creation — this body carries the reference, never the bytes.
 *
 * `changeNote` is required. A controlled revision that cannot say what changed is a revision
 * an approver reads twice (`10-revision-architecture.md` §3 names the change summary in the
 * check-in call itself).
 */
export const checkInDocumentSchema = z.object({
  /** The blob this revision is. Must be `CLEAN` and belong to this tenant. */
  fileObjectId: uuidSchema,
  /** As uploaded. What a download of this revision is named. */
  filename: z.string().trim().min(1).max(255),
  changeNote: z.string().trim().min(1).max(2_000),
  /**
   * Keep the lock after checking in: the revision is recorded as the lock's working draft,
   * the document stays checked out, and a later check-in replaces the draft (the old one is
   * `DISCARDED`) or a cancel discards it. Default off: check in and release.
   */
  keepCheckedOut: z.boolean().default(false),
});

/**
 * Several documents checked in at once — the batch shape of the same operation.
 *
 * One file per document, each item its own transaction, outcomes reported per item. A
 * revision holds exactly one file (ADR-0003): several files for *one* document is not a
 * batch, it is a modelling mistake this schema refuses by construction.
 */
export const checkInManySchema = z.object({
  items: z
    .array(
      z.object({
        documentId: uuidSchema,
        fileObjectId: uuidSchema,
        filename: z.string().trim().min(1).max(255),
        changeNote: z.string().trim().min(1).max(2_000),
      }),
    )
    .min(1)
    .max(50),
});

export const checkInOutcomeSchema = z.object({
  documentId: uuidSchema,
  ok: z.boolean(),
  /** The new revision's label when the item succeeded. */
  revisionLabel: z.string().nullable().optional(),
  /** Why the item was refused, when it was. */
  reason: z.string().optional(),
});

export const checkInManyReportSchema = z.object({
  outcomes: z.array(checkInOutcomeSchema),
});

/** Releasing somebody else's lock. The note is the audit trail's, and it is not optional. */
export const forceCheckInSchema = z.object({
  note: z.string().trim().min(1).max(2_000),
  /**
   * Throw the holder's working draft away instead of preserving it as the document's latest
   * revision. Off by default: force check-in preserves uploaded work
   * (`10-revision-architecture.md` §3).
   */
  discardDraft: z.boolean().default(false),
});

/**
 * Publishing the approved revision. Publication is immediate — the effective date may state
 * today or a past day (a policy that has in truth applied since the 1st), never the future:
 * scheduled publication is a later phase's timer.
 */
export const publishDocumentSchema = z.object({
  effectiveFrom: calendarDaySchema.optional(),
  effectiveTo: calendarDaySchema.optional(),
});

/** Restoring an older revision's content as the next draft revision. */
export const restoreRevisionSchema = z.object({
  changeNote: z.string().trim().min(1).max(2_000).optional(),
});

/**
 * One row of the revision history — the timeline. Everything the list renders, including the
 * facts publication wrote and where a restore came from.
 */
export const revisionHistoryEntrySchema = z.object({
  id: uuidSchema,
  ordinal: z.number().int().nonnegative(),
  label: z.string(),
  status: revisionStatusSchema,
  changeNote: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  createdBy: uuidSchema.nullable(),
  createdByName: z.string().nullable(),
  publishedAt: isoDateTimeSchema.nullable(),
  effectiveFrom: calendarDaySchema.nullable(),
  effectiveTo: calendarDaySchema.nullable(),
  restoredFromRevisionId: uuidSchema.nullable(),
  /** The source revision's label, so the timeline reads "restored from R1" without a join. */
  restoredFromLabel: z.string().nullable(),
  file: documentFileSchema,
});

export const revisionHistorySchema = z.object({
  documentId: uuidSchema,
  revisions: z.array(revisionHistoryEntrySchema),
});

/**
 * The comparison of two revisions — read-only and derived, never authoritative
 * (`10-revision-architecture.md` §4).
 *
 * `content` is decided by checksum: content-addressed storage makes "identical bytes" exact
 * and free. `metadata` diffs the published snapshots when both sides carry one — a draft has
 * no snapshot yet, and the response says so rather than diffing live values that prove
 * nothing. `text` states its own unavailability: paragraph and page comparison consume the
 * preview pipeline's artefacts, and rendering them is Phase 7's — the contract is stable, the
 * state fills in.
 */
export const revisionCompareSideSchema = z.object({
  id: uuidSchema,
  ordinal: z.number().int().nonnegative(),
  label: z.string(),
  status: revisionStatusSchema,
  changeNote: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  createdBy: uuidSchema.nullable(),
  publishedAt: isoDateTimeSchema.nullable(),
  effectiveFrom: calendarDaySchema.nullable(),
  effectiveTo: calendarDaySchema.nullable(),
  file: documentFileSchema,
});

export const metadataChangeSchema = z.object({
  key: z.string(),
  name: z.string(),
  from: z.string().nullable(),
  to: z.string().nullable(),
});

export const revisionCompareSchema = z.object({
  documentId: uuidSchema,
  from: revisionCompareSideSchema,
  to: revisionCompareSideSchema,
  content: z.object({
    /** Checksum equality — exact, and free under content addressing. */
    identical: z.boolean(),
    sizeDelta: z.number().int(),
    mimeChanged: z.boolean(),
    filenameChanged: z.boolean(),
  }),
  metadata: z.object({
    /** False until both sides are published and carry their snapshot. */
    available: z.boolean(),
    changes: z.array(metadataChangeSchema),
  }),
  text: z.object({
    /** `UNAVAILABLE` until the preview pipeline (Phase 7) produces extractable artefacts. */
    state: z.enum(['UNAVAILABLE']),
  }),
});

export type CheckInDocumentBody = z.infer<typeof checkInDocumentSchema>;
export type CheckInManyBody = z.infer<typeof checkInManySchema>;
export type CheckInManyReport = z.infer<typeof checkInManyReportSchema>;
export type CheckInOutcome = z.infer<typeof checkInOutcomeSchema>;
export type ForceCheckInBody = z.infer<typeof forceCheckInSchema>;
export type PublishDocumentBody = z.infer<typeof publishDocumentSchema>;
export type RestoreRevisionBody = z.infer<typeof restoreRevisionSchema>;
export type RevisionHistory = z.infer<typeof revisionHistorySchema>;
export type RevisionHistoryEntry = z.infer<typeof revisionHistoryEntrySchema>;
export type RevisionCompare = z.infer<typeof revisionCompareSchema>;
export type RevisionCompareSide = z.infer<typeof revisionCompareSideSchema>;
export type MetadataChange = z.infer<typeof metadataChangeSchema>;
