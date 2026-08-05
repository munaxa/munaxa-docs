import { z } from 'zod';

import { pageQuerySchema } from '../common/pagination';
import { searchTermSchema } from '../common/query';

/**
 * Phase 10 — soft delete and retention (`docs/architecture/adr/0010-soft-delete-and-retention.md`).
 *
 * Four surfaces, and what each one deliberately is not.
 *
 * **The recycle bin lists; it does not restore.** A bin item carries the identifiers and version
 * the *owning* module's restore endpoint wants — `POST /documents/{id}/restore`,
 * `POST /admin/folders/{id}/restore` — because restoring is Document's and Library's own use case,
 * with rules a second endpoint would inevitably restate slightly differently.
 *
 * **A delete carries a reason, and the reason is mandatory.** On the wire as a body rather than a
 * query parameter, because it is content somebody typed, and bounded because the trail stores it.
 *
 * **A legal hold has a reason at both ends.** Placing without a stated matter and releasing
 * without a stated ground are both refused — a hold nobody can justify releasing is a hold nobody
 * can justify placing.
 *
 * **A disposition is approved, never commanded.** There is no purge request shape anywhere in
 * this file, and that absence is ADR-0010 §4: the only manual step is confirming what the policy
 * already scheduled, and the sweep is what executes it.
 */

// --- The recycle bin -------------------------------------------------------------------------

export const recycleBinKindSchema = z.enum(['DOCUMENT', 'FOLDER']);

export type RecycleBinKind = z.infer<typeof recycleBinKindSchema>;

export interface RecycleBinItem {
  readonly id: string;
  readonly kind: RecycleBinKind;
  readonly name: string;
  /** Null for a folder, and for a document that was never numbered. */
  readonly documentNumber: string | null;
  readonly path: string | null;
  readonly deletedAt: string;
  readonly deletedBy: string | null;
  readonly deletedByName: string | null;
  /** Null when a cascade took the row — the cascade's own audit event carries the why. */
  readonly deleteReason: string | null;
  /** Set when this row went with a folder delete; restoring that folder brings it back. */
  readonly cascadeId: string | null;
  /** What the owning module's restore endpoint wants as `If-Match`. */
  readonly version: number;
}

export const recycleBinQuerySchema = pageQuerySchema.extend({
  search: searchTermSchema.optional(),
  kind: recycleBinKindSchema.optional(),
  sortBy: z.enum(['deletedAt']).default('deletedAt'),
  sortDirection: z.enum(['asc', 'desc']).default('desc'),
});

export type RecycleBinQuery = z.infer<typeof recycleBinQuerySchema>;

// --- Deleting with a reason ------------------------------------------------------------------

/**
 * Bounded like every stored sentence: long enough for a real explanation, short enough that the
 * recycle bin can show it beside the row rather than behind a tooltip.
 */
export const deleteDocumentSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

export type DeleteDocumentBody = z.infer<typeof deleteDocumentSchema>;

// --- Legal holds -----------------------------------------------------------------------------

export interface LegalHold {
  readonly id: string;
  readonly documentId: string;
  readonly reason: string;
  readonly placedBy: string;
  readonly placedAt: string;
  readonly releasedAt: string | null;
  readonly releasedById: string | null;
  readonly releaseReason: string | null;
}

export const placeLegalHoldSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

export const releaseLegalHoldSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

export type PlaceLegalHoldBody = z.infer<typeof placeLegalHoldSchema>;
export type ReleaseLegalHoldBody = z.infer<typeof releaseLegalHoldSchema>;

// --- The disposition queue -------------------------------------------------------------------

export const retentionScheduleStateSchema = z.enum([
  'PENDING',
  'IN_REVIEW',
  'EXECUTED',
  'SUSPENDED',
  'CANCELLED',
]);

export interface RetentionScheduleView {
  readonly id: string;
  readonly documentId: string;
  readonly policyId: string | null;
  readonly trigger: string;
  readonly triggerAt: string;
  readonly dueAt: string;
  /** `admin/configuration.ts`'s `dispositionSchema` is the value set; restated as a string here. */
  readonly disposition: 'REVIEW' | 'ARCHIVE' | 'PURGE' | 'RETAIN_FOREVER';
  readonly state: z.infer<typeof retentionScheduleStateSchema>;
  readonly reviewRequired: boolean;
  readonly reviewedById: string | null;
  readonly reviewedAt: string | null;
  readonly reviewNote: string | null;
  readonly executedAt: string | null;
}

export const approveDispositionSchema = z.object({
  note: z.string().trim().min(1).max(500),
});

export type ApproveDispositionBody = z.infer<typeof approveDispositionSchema>;

// --- The disposition register ----------------------------------------------------------------

/**
 * What a purged document left behind. The register a records manager reconciles against the
 * policy register — and, beside the audit trail, the only place the number still names anything.
 */
export interface Tombstone {
  readonly documentId: string;
  readonly documentNumber: string | null;
  readonly title: string;
  readonly documentTypeName: string | null;
  readonly folderPath: string | null;
  readonly deletedAt: string | null;
  readonly purgedAt: string;
  readonly purgedById: string | null;
  readonly revisionsRemoved: number;
  readonly blobsDereferenced: number;
}
