import { z } from 'zod';

import { ALL_DOCUMENT_STATUSES, type DocumentStatusKey } from '@edms/domain';

import { isoDateTimeSchema, uuidSchema } from '../common/identifiers';
import { adminListQuerySchema, queryFlagSchema } from '../common/query';
import { administered, descriptionSchema, nameSchema } from '../admin/record';
import { scanStatusSchema } from './upload';

/**
 * Documents — the controlled record, its business metadata, and where it sits.
 *
 * **File metadata and business metadata are two different shapes here, deliberately.** `file` is
 * what the bytes *are* — digest, size, type, scan verdict — and it changes whenever the content
 * does. `metadata` is what the document *means* to the business, defined field by field by the
 * tenant, and it survives every replacement of the content. Collapsing them into one bag is the
 * modelling mistake this split exists to prevent: it makes "which documents expire this quarter"
 * a question about a file, and "has this been scanned" a question about a business field.
 */

export const documentStatusSchema = z.enum(
  ALL_DOCUMENT_STATUSES as unknown as [DocumentStatusKey, ...DocumentStatusKey[]],
);

export const documentOriginSchema = z.enum(['UPLOAD', 'SCAN']);

/**
 * One tenant-defined field's value.
 *
 * A discriminated shape rather than `unknown`, because the field's own `dataType` decides which of
 * these is legal — and the API refuses a value of the wrong shape rather than coercing it. A date
 * arriving as the string `"soon"` is somebody's bug, and storing `null` for it would hide the bug
 * and lose the document's data at the same time.
 */
export const metadataValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.null(),
]);

export const metadataInputSchema = z.record(metadataValueSchema);

/**
 * Creating a document from content that has already been uploaded.
 *
 * The upload happens first and separately, which is what lets the browser transfer a 2 GB drawing
 * straight to storage and then post a small JSON body. It also means a failed upload never leaves
 * a half-made document behind: there is nothing to half-make until the bytes exist.
 */
export const createDocumentSchema = z.object({
  folderId: uuidSchema,
  documentTypeId: uuidSchema,
  categoryId: uuidSchema.nullable().optional(),
  /** Overrides the type's default, and only ever upward — never to a less sensitive level. */
  confidentialityId: uuidSchema.optional(),
  title: nameSchema,
  description: descriptionSchema.optional(),
  /** The blob this document's first revision is. Must be `CLEAN` and belong to this tenant. */
  fileObjectId: uuidSchema,
  /** As uploaded. What a download is named; frequently not the same as the title. */
  filename: z.string().trim().min(1).max(255),
  metadata: metadataInputSchema.optional(),
  origin: documentOriginSchema.default('UPLOAD'),
  /**
   * Proceed even though an identical file is already filed somewhere.
   *
   * A warning rather than a refusal, because a duplicate is frequently legitimate — the same
   * signed form filed against two projects is not a mistake. What is a mistake is doing it
   * *without knowing*, so the API refuses once, names what it found, and accepts the second
   * attempt that says so.
   */
  acknowledgeDuplicate: z.boolean().default(false),
});

/**
 * Editing the document, not its content.
 *
 * Content is replaced by creating a revision, which is Phase 6's. Everything here is a property of
 * the record: what it is called, what it is classified as, how sensitive it is.
 *
 * `folderId` is deliberately absent. Moving a document changes the ACL chain it resolves through,
 * so it is its own endpoint, its own permission and its own audited operation — not a field
 * somebody can change by including it in a patch meant to fix a typo in the title.
 */
export const updateDocumentSchema = z
  .object({
    title: nameSchema,
    description: descriptionSchema.nullable(),
    categoryId: uuidSchema.nullable(),
    confidentialityId: uuidSchema,
    metadata: metadataInputSchema,
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, 'Name at least one field to change.');

export const moveDocumentSchema = z.object({
  folderId: uuidSchema,
});

/**
 * Manual assignment or legacy import (`09-numbering-architecture.md` §3), behind
 * `numbering:manage`. The number is validated server-side against the document's own rule and
 * codes; a value that collides with any issued, reserved or voided number is refused.
 */
export const assignDocumentNumberSchema = z.object({
  documentNumber: z.string().trim().min(1).max(128),
});

/** What the bytes are. Never mixed with what the document means. */
export const documentFileSchema = z.object({
  fileObjectId: uuidSchema,
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  checksumSha256: z.string(),
  scanStatus: scanStatusSchema,
  /** False for anything but `CLEAN`: the content exists and cannot be opened. */
  reachable: z.boolean(),
  /** Present once an upload-time thumbnail exists. Short-lived and signed. */
  thumbnailUrl: z.string().nullable(),
});

export const documentRevisionSchema = z.object({
  id: uuidSchema,
  ordinal: z.number().int().nonnegative(),
  /** Rendered in the type's style at creation, so a style change never relabels history. */
  label: z.string(),
  status: z.enum(['DRAFT', 'IN_APPROVAL', 'PUBLISHED', 'SUPERSEDED']),
  changeNote: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  createdBy: uuidSchema.nullable(),
  file: documentFileSchema,
});

/** One field's value, with enough of the field's definition to render it without a second call. */
export const documentMetadataSchema = z.object({
  fieldId: uuidSchema,
  key: z.string(),
  name: z.string(),
  dataType: z.enum([
    'TEXT',
    'LONG_TEXT',
    'NUMBER',
    'DATE',
    'BOOLEAN',
    'SELECT',
    'MULTI_SELECT',
    'USER',
    'DEPARTMENT',
  ]),
  isRequired: z.boolean(),
  value: metadataValueSchema,
});

export const documentSchema = administered({
  folderId: uuidSchema,
  folderName: z.string(),
  /** The folder's path, so a breadcrumb needs no walk up the tree. */
  folderPath: z.string(),
  libraryId: uuidSchema,
  libraryName: z.string(),
  documentTypeId: uuidSchema,
  documentTypeName: z.string(),
  categoryId: uuidSchema.nullable(),
  categoryName: z.string().nullable(),
  confidentialityId: uuidSchema,
  confidentialityName: z.string(),
  confidentialityRank: z.number().int(),
  title: z.string(),
  description: z.string().nullable(),
  status: documentStatusSchema,
  origin: documentOriginSchema,
  /** Null until approval. Reserved forever once issued, even after deletion. */
  documentNumber: z.string().nullable(),
  /** When the number was assigned. Set with `documentNumber` and only with it. */
  numberedAt: isoDateTimeSchema.nullable(),
  /**
   * The reserved number a document under review shows, clearly marked pending — it is not the
   * document's number until approval assigns it (ADR-0004). Null once assigned, and always null
   * for a rule that draws only at approval.
   */
  pendingNumber: z.string().nullable(),
  ownerUserId: uuidSchema,
  /** The newest revision — the only one Phase 3 creates. */
  latestRevision: documentRevisionSchema.nullable(),
  metadata: z.array(documentMetadataSchema),
  isFavorite: z.boolean(),
});

/**
 * The row shape a list returns. Deliberately smaller than the document: a grid is not a form.
 *
 * It carries the administered stamps because the library's list *is* an administered list — searched,
 * sorted, paged, soft-deleted, restored, with a recycle bin — and the shared list component reads
 * them. Adding a document-shaped copy of that component instead would be a second list to keep in
 * step with the first.
 */
export const documentSummarySchema = administered({
  title: z.string(),
  status: documentStatusSchema,
  documentNumber: z.string().nullable(),
  folderId: uuidSchema,
  folderName: z.string(),
  documentTypeName: z.string(),
  categoryName: z.string().nullable(),
  confidentialityName: z.string(),
  ownerUserId: uuidSchema,
  isFavorite: z.boolean(),
  file: documentFileSchema.nullable(),
});

export const documentListQuerySchema = adminListQuerySchema([
  'createdAt',
  'updatedAt',
  'title',
  'status',
]).extend({
  /** Documents directly in this folder. */
  folderId: uuidSchema.optional(),
  /** Documents anywhere beneath this folder — what "include subfolders" means. */
  underFolderId: uuidSchema.optional(),
  libraryId: uuidSchema.optional(),
  documentTypeId: uuidSchema.optional(),
  categoryId: uuidSchema.optional(),
  confidentialityId: uuidSchema.optional(),
  status: documentStatusSchema.optional(),
  ownerUserId: uuidSchema.optional(),
  favorite: queryFlagSchema.optional(),
});

/** What a duplicate check found. Returned by the check endpoint and by a refused create. */
export const duplicateMatchSchema = z.object({
  documentId: uuidSchema,
  title: z.string(),
  documentNumber: z.string().nullable(),
  folderPath: z.string(),
  folderName: z.string(),
  createdAt: isoDateTimeSchema,
});

export const duplicateReportSchema = z.object({
  checksumSha256: z.string(),
  /** Empty when nothing matched. A warning, never a refusal on its own. */
  matches: z.array(duplicateMatchSchema),
});

export const recentDocumentSchema = documentSummarySchema.extend({
  viewedAt: isoDateTimeSchema,
});

export type CreateDocumentBody = z.infer<typeof createDocumentSchema>;
export type UpdateDocumentBody = z.infer<typeof updateDocumentSchema>;
export type MoveDocumentBody = z.infer<typeof moveDocumentSchema>;
export type AssignDocumentNumberBody = z.infer<typeof assignDocumentNumberSchema>;
export type Document = z.infer<typeof documentSchema>;
export type DocumentSummary = z.infer<typeof documentSummarySchema>;
export type DocumentRevisionView = z.infer<typeof documentRevisionSchema>;
export type DocumentFile = z.infer<typeof documentFileSchema>;
export type DocumentMetadataEntry = z.infer<typeof documentMetadataSchema>;
export type DocumentListQuery = z.infer<typeof documentListQuerySchema>;
export type DuplicateReport = z.infer<typeof duplicateReportSchema>;
export type DuplicateMatch = z.infer<typeof duplicateMatchSchema>;
export type RecentDocument = z.infer<typeof recentDocumentSchema>;
export type MetadataInput = z.infer<typeof metadataInputSchema>;
