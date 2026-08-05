import { z } from 'zod';

import { isoDateTimeSchema, uuidSchema } from '../common/identifiers';
import { descriptionSchema, nameSchema } from '../admin/record';
import { adminListQuerySchema } from '../common/query';
import { metadataInputSchema } from './document';

/**
 * Document templates — a controlled starting point, not a document.
 *
 * The distinction is the whole contract. A template has no number, no revision, no approval and no
 * lifecycle; it is configuration that *produces* documents, in the same family as a document type
 * or a numbering rule. Modelling it as a document in a hidden folder would have been half the code
 * and would have given every template a workflow, a retention schedule and a place in search
 * results — three things nobody wants a blank form to have.
 *
 * **Creating from one is an ordinary `document:create`.** The template supplies defaults; every
 * rule the manual path enforces still runs, including the duplicate warning, the confidentiality
 * floor and the metadata validation. `template:manage` governs authoring templates, and holding it
 * confers no ability to create a document anywhere.
 */

export const documentTemplateSchema = z.object({
  id: uuidSchema,
  name: nameSchema,
  description: descriptionSchema.nullable(),
  documentTypeId: uuidSchema,
  documentTypeName: z.string(),
  categoryId: uuidSchema.nullable(),
  confidentialityId: uuidSchema,
  confidentialityName: z.string(),
  defaultFolderId: uuidSchema.nullable(),
  defaultFolderPath: z.string().nullable(),
  /** The template body, if it has one. A template of defaults alone is legitimate. */
  fileObjectId: uuidSchema.nullable(),
  filename: z.string().nullable(),
  defaultMetadata: metadataInputSchema,
  isActive: z.boolean(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  version: z.number().int().positive(),
});

export const createDocumentTemplateSchema = z.object({
  name: nameSchema,
  description: descriptionSchema.optional(),
  documentTypeId: uuidSchema,
  categoryId: uuidSchema.nullable().optional(),
  confidentialityId: uuidSchema,
  defaultFolderId: uuidSchema.nullable().optional(),
  fileObjectId: uuidSchema.nullable().optional(),
  filename: z.string().trim().min(1).max(255).nullable().optional(),
  defaultMetadata: metadataInputSchema.optional(),
  isActive: z.boolean().optional(),
});

export const updateDocumentTemplateSchema = createDocumentTemplateSchema
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, 'Name at least one field to change.');

/**
 * Creating a document from a template.
 *
 * Every field is optional except the folder, and the folder is required for the reason the
 * template's own `defaultFolderId` is optional: a template usable anywhere has no home, and a
 * caller filing one has to say where. Anything supplied here overrides the template; anything
 * omitted takes the template's value.
 *
 * The template's body becomes the new document's first revision **by reference**. Content
 * addressing (ADR-0007) means a thousand documents from one template are one blob with a thousand
 * references, and no code here does anything to obtain that — it is what not writing a copy path
 * buys.
 */
export const createFromTemplateSchema = z.object({
  folderId: uuidSchema.optional(),
  title: nameSchema,
  description: descriptionSchema.optional(),
  categoryId: uuidSchema.nullable().optional(),
  metadata: metadataInputSchema.optional(),
  /** Overrides the template's filename for this document's first revision. */
  filename: z.string().trim().min(1).max(255).optional(),
});

export const documentTemplateListQuerySchema = adminListQuerySchema(['name']).extend({
  documentTypeId: uuidSchema.optional(),
});

export type DocumentTemplate = z.infer<typeof documentTemplateSchema>;
export type CreateDocumentTemplateBody = z.infer<typeof createDocumentTemplateSchema>;
export type UpdateDocumentTemplateBody = z.infer<typeof updateDocumentTemplateSchema>;
export type CreateFromTemplateBody = z.infer<typeof createFromTemplateSchema>;
export type DocumentTemplateListQuery = z.infer<typeof documentTemplateListQuerySchema>;
