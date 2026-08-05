import { z } from 'zod';

import { ALL_BULK_OPERATION_KINDS, type BulkOperationKindKey } from '@edms/domain';

import { isoDateTimeSchema, uuidSchema } from '../common/identifiers';
import { nameSchema } from '../admin/record';
import { pageQuerySchema } from '../common/pagination';
import { metadataInputSchema } from './document';

/**
 * Bulk operations — five acts, one result shape.
 *
 * **The result is the contract's whole reason for existing.** A bulk endpoint that answered `204`
 * would be an endpoint that cannot express the only interesting thing about a bulk operation:
 * that some of it did not happen, and why. So every one of these returns a tally and a row per
 * object, and the row's outcome is one of four values rather than a boolean — `REFUSED` (the
 * caller does not reach it), `BLOCKED` (a rule said no), `FAILED` (something broke), `APPLIED`.
 * A client that renders "42 of 50 succeeded" has thrown away the difference between somebody
 * selecting across a boundary they cannot see, a legal hold on a matter, and an incident.
 *
 * **`ids` is bounded by the tenant's `bulk.maxObjects` and not by this schema.** A ceiling written
 * here would be a second answer to a question the settings catalogue already answers, and the two
 * would disagree the first time an operator lowered one. What the schema enforces is the shape and
 * the floor: at least one identifier, and every one of them a UUID.
 */

export const bulkOperationKindSchema = z.enum(
  ALL_BULK_OPERATION_KINDS as unknown as [BulkOperationKindKey, ...BulkOperationKindKey[]],
);

export const bulkOperationStateSchema = z.enum(['REQUESTED', 'RUNNING', 'COMPLETED', 'FAILED']);

export const bulkItemOutcomeSchema = z.enum(['APPLIED', 'REFUSED', 'BLOCKED', 'FAILED']);

const targetIdsSchema = z.array(uuidSchema).min(1);

/**
 * A metadata change applied to many documents.
 *
 * `confidentialityId` is deliberately **absent**, and its absence is the contract rather than an
 * oversight. Changing a document's confidentiality changes who may see it, so the single-object
 * `PATCH` demands an `If-Match` for that field alone — and a bulk request cannot carry one version
 * per document. Offering the field here and failing every document on a version check would be a
 * worse answer than not offering it: the same refusal, discovered fifty times, after the operation
 * record was opened.
 */
export const bulkMetadataSchema = z
  .object({
    ids: targetIdsSchema,
    categoryId: uuidSchema.nullable().optional(),
    metadata: metadataInputSchema.optional(),
  })
  .refine(
    (body) => body.categoryId !== undefined || body.metadata !== undefined,
    'Name at least one field to change.',
  );

export const bulkRestoreSchema = z.object({
  ids: targetIdsSchema,
});

export const bulkExportSchema = z.object({
  ids: targetIdsSchema,
});

/**
 * Many already-uploaded files become many documents in one folder.
 *
 * The bytes moved through Phase 3's upload session, one file at a time, past the antivirus gate;
 * this names the blobs and what each document should be called. A `title` per file rather than one
 * derived from the filename, because a filename is what a scanner produced and a title is what the
 * business calls the record — deriving one from the other is how an import produces five thousand
 * documents named `SCAN_0001`.
 */
export const bulkUploadSchema = z.object({
  folderId: uuidSchema,
  documentTypeId: uuidSchema,
  categoryId: uuidSchema.nullable().optional(),
  confidentialityId: uuidSchema.optional(),
  files: z
    .array(
      z.object({
        fileObjectId: uuidSchema,
        filename: z.string().trim().min(1).max(255),
        title: nameSchema,
      }),
    )
    .min(1),
});

/**
 * Deciding many approval tasks.
 *
 * `decision` accepts only `APPROVED`. A rejection or a request for changes must say why, and one
 * sentence covering forty documents is a reason for the batch rather than for any of them — which
 * in a controlled-document system is exactly the field an auditor reads. The single-object route
 * takes the other two decisions and is unchanged.
 */
export const bulkApprovalSchema = z.object({
  taskIds: targetIdsSchema,
  decision: z.literal('APPROVED'),
  comment: z.string().trim().max(2_000).nullable().optional(),
});

export const bulkItemResultSchema = z.object({
  targetId: uuidSchema,
  outcome: bulkItemOutcomeSchema,
  /** The `ErrorCode` that refused it, so a client translates rather than displays a sentence. */
  errorCode: z.string().nullable(),
  detail: z.string().nullable(),
});

export const bulkTallySchema = z.object({
  requested: z.number().int().nonnegative(),
  applied: z.number().int().nonnegative(),
  refused: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

export const bulkOperationResultSchema = z.object({
  operationId: uuidSchema,
  kind: bulkOperationKindSchema,
  state: bulkOperationStateSchema,
  tally: bulkTallySchema,
  items: z.array(bulkItemResultSchema),
});

export const bulkOperationSchema = z.object({
  id: uuidSchema,
  kind: bulkOperationKindSchema,
  state: bulkOperationStateSchema,
  requestedAt: isoDateTimeSchema,
  startedAt: isoDateTimeSchema.nullable(),
  completedAt: isoDateTimeSchema.nullable(),
  tally: bulkTallySchema,
  /** The export manifest's file object, for `EXPORT`. Null for every other kind. */
  fileObjectId: uuidSchema.nullable(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().nullable(),
  error: z.string().nullable(),
});

/** One signed link per released document — a bulk export's deliverable, minted per request. */
export const bulkExportLinkSchema = z.object({
  documentId: uuidSchema,
  filename: z.string(),
  url: z.string(),
  expiresAt: isoDateTimeSchema,
});

export const bulkExportLinksSchema = z.object({
  operationId: uuidSchema,
  links: z.array(bulkExportLinkSchema),
});

export const bulkOperationListQuerySchema = pageQuerySchema;

export type BulkMetadataBody = z.infer<typeof bulkMetadataSchema>;
export type BulkRestoreBody = z.infer<typeof bulkRestoreSchema>;
export type BulkExportBody = z.infer<typeof bulkExportSchema>;
export type BulkUploadBody = z.infer<typeof bulkUploadSchema>;
export type BulkApprovalBody = z.infer<typeof bulkApprovalSchema>;
export type BulkOperationResult = z.infer<typeof bulkOperationResultSchema>;
export type BulkOperationView = z.infer<typeof bulkOperationSchema>;
export type BulkItemResultView = z.infer<typeof bulkItemResultSchema>;
export type BulkExportLinks = z.infer<typeof bulkExportLinksSchema>;
export type BulkTallyView = z.infer<typeof bulkTallySchema>;
