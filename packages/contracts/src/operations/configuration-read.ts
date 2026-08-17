import { z } from 'zod';

import { MetadataDataType } from '@edms/domain';

import { uuidSchema } from '../common/identifiers';
import { metadataOptionSchema } from '../admin/configuration';
import { optionListQuerySchema } from './option-query';

/**
 * The tenant's document vocabulary, as the people who *file* documents need it.
 *
 * ## Why these exist beside `admin/configuration.ts` rather than replacing it
 *
 * Those shapes are what an administrator edits: a document type carries its numbering rule, its
 * workflow, its retention policy, its revision-label style and the administered stamps; a
 * confidentiality level carries the handling rules that decide whether a reader may download,
 * print, or must state a reason. That is the right contract for the screen that configures them.
 *
 * It is the wrong contract for a picker. A document controller choosing a type needs a name and
 * the fields to fill in; it does not need the tenant's retention schedule, and it certainly does
 * not need the confidentiality *policy* — which is why `confidentialityOptionSchema` below carries
 * a rank and stops. Sending the administrative record because a dropdown needs a label is how a
 * read permission quietly becomes an administrative one.
 *
 * So each shape here is the subset a real consumer was measured to use, and the fields left out
 * are left out deliberately. `configuration-read.spec.ts` asserts their absence by name, because
 * an omission nothing checks is an omission somebody restores.
 */

/**
 * A field as the form that fills it in needs it.
 *
 * `options` and `description` are the whole reason `/admin/fields` used to be fetched: everything
 * else here already travelled on the document type. Folding them in is what lets the field
 * *catalogue* — every field in the tenant, attached or not, with the tenant-authored validation
 * regexes — stop being a dependency of the documents workspace altogether.
 *
 * `validation` is **not** here. The client has never rendered it; the API validates submissions
 * against it server-side, which is where a rule that must not be negotiable belongs.
 */
export const typeFieldOptionSchema = z.object({
  metadataFieldId: uuidSchema,
  key: z.string(),
  name: z.string(),
  dataType: z.nativeEnum(MetadataDataType),
  isRequired: z.boolean(),
  sortOrder: z.number().int(),
  defaultValue: z.string().nullable(),
  options: z.array(metadataOptionSchema),
  description: z.string().nullable(),
});

/**
 * `isActive` is carried rather than filtered away, and the reason is the *edit* path.
 *
 * A type that has been deactivated stays attached to the documents already filed under it —
 * `admin/configuration.ts` says so — and the properties form resolves a document's own type by id
 * to know which fields to render. Returning only active types would render an empty metadata
 * section for every document whose type was retired, which is a silent data-loss trap rather than
 * a tightening. The list query below takes `isActive`, and the documents workspace asks for active
 * types because that is what a *new* document may choose.
 */
export const documentTypeOptionSchema = z.object({
  id: uuidSchema,
  code: z.string(),
  name: z.string(),
  isActive: z.boolean(),
  defaultConfidentialityId: uuidSchema,
  fields: z.array(typeFieldOptionSchema),
});

export const categoryOptionSchema = z.object({
  id: uuidSchema,
  code: z.string(),
  name: z.string(),
  parentId: uuidSchema.nullable(),
  /** Materialised ancestry. The picker sorts and disambiguates by it — two `Drawings` are not one. */
  path: z.string(),
  depth: z.number().int().min(1),
});

/**
 * A confidentiality level as a picker needs it, which is a label and an order.
 *
 * `rank` is here because the properties form must not offer a level *below* the document's own:
 * confidentiality may be raised and never lowered, and a picker offering the reverse offers an
 * action the API refuses. The handling rules — `allowDownload`, `allowPrint`, `watermark`,
 * `requireReason` — are the tenant's security policy and are deliberately absent.
 */
export const confidentialityOptionSchema = z.object({
  id: uuidSchema,
  code: z.string(),
  name: z.string(),
  rank: z.number().int().min(0).max(100),
});

export const documentTypeOptionQuerySchema = optionListQuerySchema(['name', 'code']).extend({
  isActive: z.enum(['true', 'false']).optional(),
});

export const categoryOptionQuerySchema = optionListQuerySchema(['name', 'code', 'path']);

export const confidentialityOptionQuerySchema = optionListQuerySchema(['name', 'code', 'rank']);

export type TypeFieldOption = z.infer<typeof typeFieldOptionSchema>;
export type DocumentTypeOption = z.infer<typeof documentTypeOptionSchema>;
export type CategoryOption = z.infer<typeof categoryOptionSchema>;
export type ConfidentialityOption = z.infer<typeof confidentialityOptionSchema>;
export type DocumentTypeOptionQuery = z.infer<typeof documentTypeOptionQuerySchema>;
export type CategoryOptionQuery = z.infer<typeof categoryOptionQuerySchema>;
export type ConfidentialityOptionQuery = z.infer<typeof confidentialityOptionQuerySchema>;
