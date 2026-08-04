import { z } from 'zod';

import {
  Disposition,
  MetadataDataType,
  RetentionTrigger,
  RevisionLabelStyle,
  requiresOptions,
} from '@edms/domain';

import { uuidSchema } from '../common/identifiers';
import { adminListQuerySchema } from '../common/query';
import {
  administered,
  codeSchema,
  configurationKeySchema,
  descriptionSchema,
  nameSchema,
} from './record';

/**
 * The configuration Administration owns: what a document *is*, how sensitive, how long kept.
 *
 * Nothing here is hardcoded anywhere else in the product. A tenant that needs a new document
 * type, field, retention rule or confidentiality level configures it and does not wait for a
 * release (`03-domain-model.md` §3).
 */

// --- Confidentiality levels --------------------------------------------------------------

/**
 * Rank is the level's identity to the product, not decoration: conditions compare it
 * (`confidentiality.rank >= 3`), audit-on-read is triggered by it, and "more sensitive than"
 * has to be a total order or those questions have no answer. Hence unique per tenant.
 */
export const confidentialityRankSchema = z.number().int().min(0).max(100);

export const createConfidentialityLevelSchema = z.object({
  code: codeSchema,
  name: nameSchema,
  description: descriptionSchema.optional(),
  rank: confidentialityRankSchema,
  /**
   * Handling rules. Each **subtracts only** — a level may forbid download to somebody who holds
   * `document:download`, and can never grant it to somebody who does not
   * (`08-permission-model.md` §4).
   */
  allowDownload: z.boolean().default(true),
  allowPrint: z.boolean().default(true),
  watermark: z.boolean().default(false),
  /** Forces a stated reason, recorded in the audit trail, even for a permitted read. */
  requireReason: z.boolean().default(false),
});

export const updateConfidentialityLevelSchema = createConfidentialityLevelSchema
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, 'Name at least one field to change.');

export const confidentialityLevelSchema = administered({
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  rank: confidentialityRankSchema,
  allowDownload: z.boolean(),
  allowPrint: z.boolean(),
  watermark: z.boolean(),
  requireReason: z.boolean(),
  /** Document types defaulting to this level — what blocks a delete. */
  documentTypeCount: z.number().int().min(0),
});

export const confidentialityLevelListQuerySchema = adminListQuerySchema([
  'createdAt',
  'updatedAt',
  'name',
  'code',
  'rank',
]);

export type CreateConfidentialityLevelBody = z.infer<typeof createConfidentialityLevelSchema>;
export type UpdateConfidentialityLevelBody = z.infer<typeof updateConfidentialityLevelSchema>;
export type ConfidentialityLevel = z.infer<typeof confidentialityLevelSchema>;
export type ConfidentialityLevelListQuery = z.infer<typeof confidentialityLevelListQuerySchema>;

// --- Retention policies ------------------------------------------------------------------

export const retentionTriggerSchema = z.nativeEnum(RetentionTrigger);
export const dispositionSchema = z.nativeEnum(Disposition);

/**
 * A retention period in whole months.
 *
 * Months rather than days because that is how record-keeping regimes are written — "seven years
 * after supersession" — and converting to days at configuration time would bake in an assumption
 * about month length that the schedule then has to un-bake.
 *
 * `RETAIN_FOREVER` needs no period, and every other disposition does; the refinement below is
 * what stops a policy that says "purge, eventually".
 */
export const retentionPeriodSchema = z.number().int().min(0).max(1200);

const retentionShape = {
  code: codeSchema,
  name: nameSchema,
  description: descriptionSchema.optional(),
  trigger: retentionTriggerSchema,
  periodMonths: retentionPeriodSchema,
  disposition: dispositionSchema,
  /** A human must confirm before the disposition runs. Required for irreversible ones. */
  reviewRequired: z.boolean().default(false),
};

function coherentRetention(
  value: {
    readonly disposition?: z.infer<typeof dispositionSchema> | undefined;
    readonly periodMonths?: number | undefined;
  },
  context: z.RefinementCtx,
): void {
  if (value.disposition === undefined || value.periodMonths === undefined) {
    return;
  }
  if (value.disposition === Disposition.RETAIN_FOREVER) {
    if (value.periodMonths !== 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['periodMonths'],
        message: 'A policy that retains forever has no period.',
      });
    }
    return;
  }
  if (value.periodMonths === 0) {
    // A period of zero with a real disposition means "dispose the moment the trigger fires",
    // which reads as a configuration mistake far more often than as an intent — and when it is
    // the intent, one month costs nothing and leaves a window to notice.
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['periodMonths'],
      message: 'State how long the record is kept before this disposition runs.',
    });
  }
}

export const createRetentionPolicySchema = z.object(retentionShape).superRefine(coherentRetention);

export const updateRetentionPolicySchema = z
  .object(retentionShape)
  .partial()
  .superRefine(coherentRetention)
  .refine((patch) => Object.keys(patch).length > 0, 'Name at least one field to change.');

export const retentionPolicySchema = administered({
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  trigger: retentionTriggerSchema,
  periodMonths: retentionPeriodSchema,
  disposition: dispositionSchema,
  reviewRequired: z.boolean(),
  documentTypeCount: z.number().int().min(0),
});

export const retentionPolicyListQuerySchema = adminListQuerySchema([
  'createdAt',
  'updatedAt',
  'name',
  'code',
]).extend({
  trigger: retentionTriggerSchema.optional(),
  disposition: dispositionSchema.optional(),
});

export type CreateRetentionPolicyBody = z.infer<typeof createRetentionPolicySchema>;
export type UpdateRetentionPolicyBody = z.infer<typeof updateRetentionPolicySchema>;
export type RetentionPolicy = z.infer<typeof retentionPolicySchema>;
export type RetentionPolicyListQuery = z.infer<typeof retentionPolicyListQuerySchema>;

// --- Categories --------------------------------------------------------------------------

export const createCategorySchema = z.object({
  /** Null for a top-level category. Categories nest, and cut across folders. */
  parentId: uuidSchema.nullable().optional(),
  code: codeSchema,
  name: nameSchema,
  description: descriptionSchema.optional(),
});

export const updateCategorySchema = z
  .object({
    code: codeSchema,
    name: nameSchema,
    description: descriptionSchema.nullable(),
    parentId: uuidSchema.nullable(),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, 'Name at least one field to change.');

export const moveCategorySchema = z.object({
  parentId: uuidSchema.nullable(),
});

export const categorySchema = administered({
  parentId: uuidSchema.nullable(),
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  path: z.string(),
  depth: z.number().int().min(1),
  childCount: z.number().int().min(0),
});

export const categoryListQuerySchema = adminListQuerySchema([
  'createdAt',
  'updatedAt',
  'name',
  'code',
  'path',
]).extend({
  parentId: z.union([uuidSchema, z.literal('null')]).optional(),
  underId: uuidSchema.optional(),
});

export type CreateCategoryBody = z.infer<typeof createCategorySchema>;
export type UpdateCategoryBody = z.infer<typeof updateCategorySchema>;
export type MoveCategoryBody = z.infer<typeof moveCategorySchema>;
export type Category = z.infer<typeof categorySchema>;
export type CategoryListQuery = z.infer<typeof categoryListQuerySchema>;

// --- Metadata fields ---------------------------------------------------------------------

export const metadataDataTypeSchema = z.nativeEnum(MetadataDataType);

export const metadataOptionSchema = z.object({
  value: z.string().trim().min(1).max(100),
  label: nameSchema,
});

/**
 * Per-type validation, as far as a tenant may express it.
 *
 * A closed shape rather than free-form `jsonb`: validation a tenant writes runs against every
 * document they create, and "whatever they typed" is not something the product can promise to
 * evaluate the same way twice. `pattern` is the one escape hatch, and it is bounded and anchored
 * server-side.
 */
export const metadataValidationSchema = z
  .object({
    minLength: z.number().int().min(0).max(10_000).optional(),
    maxLength: z.number().int().min(1).max(10_000).optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    /** A bounded regular expression. Compiled once at save time; a rejected one is a 422. */
    pattern: z.string().max(200).optional(),
  })
  .strict();

const metadataFieldShape = {
  key: configurationKeySchema,
  name: nameSchema,
  description: descriptionSchema.optional(),
  dataType: metadataDataTypeSchema,
  options: z.array(metadataOptionSchema).max(200).default([]),
  validation: metadataValidationSchema.default({}),
  /** Indexed for search. Changing it re-indexes on the next revision, never retroactively. */
  isSearchable: z.boolean().default(true),
};

function coherentField(
  value: {
    readonly dataType?: z.infer<typeof metadataDataTypeSchema> | undefined;
    readonly options?: readonly unknown[] | undefined;
  },
  context: z.RefinementCtx,
): void {
  if (value.dataType === undefined || value.options === undefined) {
    return;
  }
  const needsOptions = requiresOptions(value.dataType);
  if (needsOptions && value.options.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['options'],
      message: 'A choice field needs at least one option.',
    });
  }
  if (!needsOptions && value.options.length > 0) {
    // Silently ignoring them would teach an administrator that they had configured something.
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['options'],
      message: 'Only choice fields have options.',
    });
  }
}

export const createMetadataFieldSchema = z.object(metadataFieldShape).superRefine(coherentField);

/**
 * `dataType` is absent.
 *
 * Changing the type of a field that documents already carry values for makes every stored value
 * either wrong or unreadable — the value columns are typed, so a `TEXT` value has nowhere to go
 * in a `NUMBER` field. A field of the wrong type is deleted and replaced while it is unused.
 */
export const updateMetadataFieldSchema = z
  .object({
    name: nameSchema,
    description: descriptionSchema.nullable(),
    options: z.array(metadataOptionSchema).max(200),
    validation: metadataValidationSchema,
    isSearchable: z.boolean(),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, 'Name at least one field to change.');

export const metadataFieldSchema = administered({
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  dataType: metadataDataTypeSchema,
  options: z.array(metadataOptionSchema),
  validation: metadataValidationSchema,
  isSearchable: z.boolean(),
  documentTypeCount: z.number().int().min(0),
});

export const metadataFieldListQuerySchema = adminListQuerySchema([
  'createdAt',
  'updatedAt',
  'name',
  'key',
]).extend({
  dataType: metadataDataTypeSchema.optional(),
});

export type CreateMetadataFieldBody = z.infer<typeof createMetadataFieldSchema>;
export type UpdateMetadataFieldBody = z.infer<typeof updateMetadataFieldSchema>;
export type MetadataField = z.infer<typeof metadataFieldSchema>;
export type MetadataFieldListQuery = z.infer<typeof metadataFieldListQuerySchema>;

// --- Document types ----------------------------------------------------------------------

export const revisionLabelStyleSchema = z.nativeEnum(RevisionLabelStyle);

/** A field attached to a type, with the per-type facts the field itself does not carry. */
export const typeFieldSchema = z.object({
  metadataFieldId: uuidSchema,
  isRequired: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(1000).default(0),
  /** Pre-filled on a new document. Validated against the field's own type and options. */
  defaultValue: z.string().max(2000).nullable().default(null),
});

export const createDocumentTypeSchema = z.object({
  code: codeSchema,
  name: nameSchema,
  description: descriptionSchema.optional(),
  /** Required: a document type with no numbering rule is a type whose documents cannot be approved. */
  numberingRuleId: uuidSchema,
  /** Null means no approval is required — legitimate for a reference type. */
  workflowDefinitionId: uuidSchema.nullable().optional(),
  retentionPolicyId: uuidSchema.nullable().optional(),
  defaultConfidentialityId: uuidSchema,
  revisionLabelStyle: revisionLabelStyleSchema.default(RevisionLabelStyle.NUMERIC),
  /** Inactive types stay attached to existing documents and cannot be chosen for new ones. */
  isActive: z.boolean().default(true),
  fields: z.array(typeFieldSchema).max(100).default([]),
});

export const updateDocumentTypeSchema = createDocumentTypeSchema
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, 'Name at least one field to change.');

export const documentTypeSchema = administered({
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  numberingRuleId: uuidSchema,
  numberingRuleName: z.string(),
  workflowDefinitionId: uuidSchema.nullable(),
  workflowDefinitionName: z.string().nullable(),
  retentionPolicyId: uuidSchema.nullable(),
  retentionPolicyName: z.string().nullable(),
  defaultConfidentialityId: uuidSchema,
  defaultConfidentialityName: z.string(),
  revisionLabelStyle: revisionLabelStyleSchema,
  isActive: z.boolean(),
  fields: z.array(
    typeFieldSchema.extend({
      key: z.string(),
      name: z.string(),
      dataType: metadataDataTypeSchema,
    }),
  ),
});

export const documentTypeListQuerySchema = adminListQuerySchema([
  'createdAt',
  'updatedAt',
  'name',
  'code',
]).extend({
  isActive: z.enum(['true', 'false']).optional(),
  workflowDefinitionId: uuidSchema.optional(),
  retentionPolicyId: uuidSchema.optional(),
});

export type TypeFieldBody = z.infer<typeof typeFieldSchema>;
export type CreateDocumentTypeBody = z.infer<typeof createDocumentTypeSchema>;
export type UpdateDocumentTypeBody = z.infer<typeof updateDocumentTypeSchema>;
export type DocumentType = z.infer<typeof documentTypeSchema>;
export type DocumentTypeListQuery = z.infer<typeof documentTypeListQuerySchema>;
