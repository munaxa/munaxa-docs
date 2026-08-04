import { z } from 'zod';

import {
  ALL_NUMBER_ORIGINS,
  ALL_NUMBER_RESERVATION_STATES,
  ALL_NUMBER_SEGMENT_KINDS,
  ALL_SEQUENCE_RESET_SCOPES,
  type NumberOriginKey,
  type NumberReservationStateKey,
  type NumberSegmentKindKey,
  NumberSegmentKind,
  SequenceResetScope,
  type SequenceResetScopeKey,
} from '@edms/domain';

import { isoDateTimeSchema, uuidSchema } from '../common/identifiers';
import { pageQuerySchema } from '../common/pagination';
import { adminListQuerySchema } from '../common/query';
import { administered, configurationKeySchema, descriptionSchema, nameSchema } from './record';

/**
 * The document-number recipe (`09-numbering-architecture.md` §1).
 *
 * A rule is an ordered list of segments plus a reset scope, and it is entirely configuration:
 * no format string, no template language, nothing a tenant can write that the formatter has to
 * interpret. That is why the shape is a discriminated union rather than
 * `{ type: string, ...anything }` — a segment either is a kind the formatter knows how to
 * resolve, or the rule does not save.
 */

export const numberSegmentKindSchema = z.enum(
  ALL_NUMBER_SEGMENT_KINDS as [NumberSegmentKindKey, ...NumberSegmentKindKey[]],
);

export const sequenceResetScopeSchema = z.enum(
  ALL_SEQUENCE_RESET_SCOPES as [SequenceResetScopeKey, ...SequenceResetScopeKey[]],
);

/**
 * How wide a zero-padded counter is.
 *
 * Fixed for the life of a series, and the bound is not arbitrary: widening padding mid-series
 * would give one number two textual forms (`0042` and `00042`), which is the same defect as
 * reusing one. The rule refuses the change; a new series is created instead (§1).
 */
export const paddingSchema = z.number().int().min(1).max(12);

/** A literal that a person reads aloud and types back in — so, no separators of its own. */
const literalValueSchema = z
  .string()
  .trim()
  .min(1)
  .max(16)
  .regex(/^[A-Za-z0-9]+$/, 'A literal segment is letters and digits only.');

/**
 * A segment.
 *
 * `optional` means "drop this segment, and its separator, when it resolves empty" — a branch code
 * for a document that belongs to no branch. It is the one flag that can make two different
 * documents produce the same number, so the validator refuses a rule where dropping an optional
 * segment collides with a shorter combination (§1).
 */
export const numberSegmentSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal(NumberSegmentKind.LITERAL),
    value: literalValueSchema,
  }),
  z.object({
    kind: z.literal(NumberSegmentKind.COMPANY_CODE),
    optional: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal(NumberSegmentKind.ENTITY_CODE),
    optional: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal(NumberSegmentKind.BRANCH_CODE),
    optional: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal(NumberSegmentKind.DEPARTMENT_CODE),
    optional: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal(NumberSegmentKind.DOCUMENT_TYPE_CODE),
    optional: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal(NumberSegmentKind.CATEGORY_CODE),
    optional: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal(NumberSegmentKind.YEAR),
    /** Two or four digits of the **assignment** year, in the tenant's timezone (§1). */
    digits: z.union([z.literal(2), z.literal(4)]).default(4),
  }),
  z.object({
    kind: z.literal(NumberSegmentKind.MONTH),
  }),
  z.object({
    kind: z.literal(NumberSegmentKind.SEQUENCE),
    padding: paddingSchema.default(4),
  }),
]);

export type NumberSegment = z.infer<typeof numberSegmentSchema>;

/** Something a number is joined with, and that therefore may not appear inside a segment. */
export const separatorSchema = z.enum(['-', '/', '.', '_', '']);

const numberingRuleShape = {
  key: configurationKeySchema,
  name: nameSchema,
  description: descriptionSchema.optional(),
  separator: separatorSchema.default('-'),
  segments: z.array(numberSegmentSchema).min(1).max(12),
  /**
   * What the counter key is built from. `NEVER` means one continuous series, and it may not be
   * combined with anything — a rule that both never resets and resets yearly is two rules.
   */
  resetScope: z.array(sequenceResetScopeSchema).min(1).max(6),
  /**
   * Reserve a number at submission so reviewers have a stable reference, marked *pending* until
   * approval assigns it. A tenant that dislikes pending numbers turns this off and the number is
   * drawn at approval instead (§2).
   */
  reserveOnSubmit: z.boolean().default(true),
  /**
   * Gapless mode. Some regimes require an unbroken series, so reservation happens only at
   * approval and no reservation can be voided. The cost — the number is unknown during review —
   * is the trade-off the regime demands, and it is a tenant choice (§2).
   */
  strictGapless: z.boolean().default(false),
};

/**
 * The invariants a rule must satisfy, applied to both the create and the update shape.
 *
 * Every field is optional-and-possibly-undefined because `update` is a `PATCH`: the check runs on
 * whatever the caller named and stays silent about the rest, rather than refusing a patch for a
 * field it did not send.
 */
function coherentRule(
  value: {
    readonly segments?: readonly NumberSegment[] | undefined;
    readonly resetScope?: readonly SequenceResetScopeKey[] | undefined;
    readonly reserveOnSubmit?: boolean | undefined;
    readonly strictGapless?: boolean | undefined;
  },
  context: z.RefinementCtx,
): void {
  if (value.segments !== undefined) {
    const sequences = value.segments.filter(
      (segment) => segment.kind === NumberSegmentKind.SEQUENCE,
    );
    // Exactly one, not at least one: two counters in one number means two series, and no answer
    // to which one the reservation belongs to.
    if (sequences.length !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['segments'],
        message: 'A rule has exactly one sequence segment.',
      });
    }
  }

  if (value.resetScope !== undefined && value.resetScope.length > 1) {
    if (value.resetScope.includes(SequenceResetScope.NEVER)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['resetScope'],
        message: '“Never” cannot be combined with another reset scope.',
      });
    }
    if (
      value.resetScope.includes(SequenceResetScope.YEARLY) &&
      value.resetScope.includes(SequenceResetScope.MONTHLY)
    ) {
      // Monthly already restarts within a year; asking for both describes one behaviour twice
      // and leaves the scope key with a redundant component nobody can reason about.
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['resetScope'],
        message: 'Choose monthly or yearly, not both.',
      });
    }
    if (new Set(value.resetScope).size !== value.resetScope.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['resetScope'],
        message: 'A reset scope is named once.',
      });
    }
  }

  if (value.strictGapless === true && value.reserveOnSubmit === true) {
    // Gapless is defined by *not* reserving early: a reservation that can be abandoned is a gap.
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reserveOnSubmit'],
      message: 'A gapless series cannot reserve at submission.',
    });
  }
}

export const createNumberingRuleSchema = z.object(numberingRuleShape).superRefine(coherentRule);

/**
 * `segments` and `padding` may be edited, and doing so affects only documents numbered
 * afterwards. Existing numbers are stored, never recomputed — a re-render of an issued number is
 * a bug, not a feature (§1).
 */
export const updateNumberingRuleSchema = z
  .object(numberingRuleShape)
  .partial()
  .superRefine(coherentRule)
  .refine((patch) => Object.keys(patch).length > 0, 'Name at least one field to change.');

export const numberingRuleSchema = administered({
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  separator: separatorSchema,
  segments: z.array(numberSegmentSchema),
  resetScope: z.array(sequenceResetScopeSchema),
  reserveOnSubmit: z.boolean(),
  strictGapless: z.boolean(),
  /** A rendered example, so the builder shows what the rule produces as it is edited. */
  sample: z.string(),
  /** Live series drawn from this rule. A rule with a live series cannot change its padding. */
  sequenceCount: z.number().int().min(0),
  documentTypeCount: z.number().int().min(0),
});

export const numberingRuleListQuerySchema = adminListQuerySchema([
  'createdAt',
  'updatedAt',
  'name',
  'key',
]);

/**
 * A preview request.
 *
 * Deliberately a `POST` that claims nothing: the builder renders a sample from an *unsaved* rule,
 * so there is nothing to `GET`, and drawing a real number to show a preview would burn one.
 */
export const previewNumberingRuleSchema = z.object({
  separator: separatorSchema,
  segments: z.array(numberSegmentSchema).min(1).max(12),
  /** Codes to render the sample with. Absent ones fall back to a readable placeholder. */
  context: z
    .object({
      companyCode: z.string().trim().max(16).optional(),
      entityCode: z.string().trim().max(16).optional(),
      branchCode: z.string().trim().max(16).optional(),
      departmentCode: z.string().trim().max(16).optional(),
      documentTypeCode: z.string().trim().max(16).optional(),
      categoryCode: z.string().trim().max(16).optional(),
    })
    .default({}),
});

export const numberingPreviewSchema = z.object({
  sample: z.string(),
  /** Segments dropped because they resolved empty — the builder shows which and why. */
  omittedSegments: z.array(numberSegmentKindSchema),
});

export const numberReservationStateSchema = z.enum(
  ALL_NUMBER_RESERVATION_STATES as [NumberReservationStateKey, ...NumberReservationStateKey[]],
);

export const numberOriginSchema = z.enum(
  ALL_NUMBER_ORIGINS as [NumberOriginKey, ...NumberOriginKey[]],
);

/**
 * One value drawn from a rule's sequence, whatever became of it (§2–§3). Voided and assigned
 * rows are history and never leave this list — a gap in a visible series is explained by the
 * voided value that made it, which is why the screen shows them rather than hiding them.
 */
export const numberReservationSchema = z.object({
  id: uuidSchema,
  scopeKey: z.string(),
  /** As text: a counter is a `bigint`, and JSON numbers stop being exact at 2^53. */
  sequenceValue: z.string(),
  formatted: z.string(),
  state: numberReservationStateSchema,
  origin: numberOriginSchema,
  documentId: uuidSchema.nullable(),
  workflowInstanceId: uuidSchema.nullable(),
  reservedAt: isoDateTimeSchema,
  assignedAt: isoDateTimeSchema.nullable(),
  voidedAt: isoDateTimeSchema.nullable(),
  voidReason: z.string().nullable(),
  note: z.string().nullable(),
});

export const numberReservationListQuerySchema = pageQuerySchema.extend({
  state: numberReservationStateSchema.optional(),
});

/**
 * A controller sets a run of values aside for an offline process (§3). The codes name which
 * series the block comes from; the server renders and stores each value as `HELD`, which the
 * automatic path can never draw — the sequence has already moved past it.
 */
export const holdNumberBlockSchema = z.object({
  count: z.number().int().min(1).max(100),
  note: z.string().trim().max(500).optional(),
  context: z
    .object({
      companyCode: z.string().trim().max(16).optional(),
      entityCode: z.string().trim().max(16).optional(),
      branchCode: z.string().trim().max(16).optional(),
      departmentCode: z.string().trim().max(16).optional(),
      documentTypeCode: z.string().trim().max(16).optional(),
      categoryCode: z.string().trim().max(16).optional(),
    })
    .default({}),
});

export const heldNumberBlockSchema = z.object({
  values: z.array(z.string()),
});

/** Voiding a held value a controller no longer needs. Retained forever, never re-issued. */
export const voidHeldNumberSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

export type CreateNumberingRuleBody = z.infer<typeof createNumberingRuleSchema>;
export type UpdateNumberingRuleBody = z.infer<typeof updateNumberingRuleSchema>;
export type NumberingRule = z.infer<typeof numberingRuleSchema>;
export type NumberingRuleListQuery = z.infer<typeof numberingRuleListQuerySchema>;
export type PreviewNumberingRuleBody = z.infer<typeof previewNumberingRuleSchema>;
export type NumberingPreview = z.infer<typeof numberingPreviewSchema>;
export type NumberReservation = z.infer<typeof numberReservationSchema>;
export type NumberReservationListQuery = z.infer<typeof numberReservationListQuerySchema>;
export type HoldNumberBlockBody = z.infer<typeof holdNumberBlockSchema>;
export type HeldNumberBlock = z.infer<typeof heldNumberBlockSchema>;
export type VoidHeldNumberBody = z.infer<typeof voidHeldNumberSchema>;
