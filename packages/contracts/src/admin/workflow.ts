import { z } from 'zod';

import {
  ALL_CONDITION_OPERATORS,
  ALL_OVERDUE_ACTIONS,
  ALL_PARTICIPANT_KINDS,
  ALL_STAGE_COMPLETION_RULES,
  type ConditionOperatorKey,
  DeadlineCalendar,
  ManagerOfSubject,
  type OverdueActionKey,
  ParticipantKind,
  ParticipantScope,
  PublishTiming,
  RejectBehaviour,
  StageCompletionRule,
  type StageCompletionRuleKey,
  WorkflowVersionState,
  needsThreshold,
  type ParticipantKindKey,
} from '@edms/domain';

import { isoDateTimeSchema, uuidSchema } from '../common/identifiers';
import { adminListQuerySchema } from '../common/query';
import { administered, configurationKeySchema, descriptionSchema, nameSchema } from './record';

/**
 * A workflow definition, as data.
 *
 * The engine reads this; it never contains engine code, and it never names a document type,
 * department or role in TypeScript — which is what stops the product needing a release per
 * tenant (`07-workflow-architecture.md` §8). The future graphical designer is a UI over exactly
 * this JSON, which is why validating it properly here matters more than it looks.
 */

export const workflowVersionStateSchema = z.nativeEnum(WorkflowVersionState);
export const stageCompletionRuleSchema = z.enum(
  ALL_STAGE_COMPLETION_RULES as [StageCompletionRuleKey, ...StageCompletionRuleKey[]],
);
export const participantKindSchema = z.enum(
  ALL_PARTICIPANT_KINDS as [ParticipantKindKey, ...ParticipantKindKey[]],
);
export const overdueActionSchema = z.enum(
  ALL_OVERDUE_ACTIONS as [OverdueActionKey, ...OverdueActionKey[]],
);
export const conditionOperatorSchema = z.enum(
  ALL_CONDITION_OPERATORS as [ConditionOperatorKey, ...ConditionOperatorKey[]],
);

/**
 * An ISO-8601 duration, restricted to days and hours.
 *
 * Bounded on purpose: months and years in a duration are ambiguous against a working-day
 * calendar, and a deadline the engine cannot compute the same way twice is not a deadline.
 */
export const durationSchema = z
  .string()
  .regex(/^P(?:\d{1,3}D)?(?:T(?:\d{1,3}H)?)?$/, 'A duration is days and hours, e.g. P3D or PT8H.')
  .refine((value) => value !== 'P' && value !== 'PT', 'A duration cannot be empty.');

/**
 * How a stage's approvers are found. Resolved at stage activation, never stored as user ids —
 * so an org change does not break a workflow authored before it (§2).
 */
export const participantSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal(ParticipantKind.USER),
    userId: uuidSchema,
  }),
  z.object({
    kind: z.literal(ParticipantKind.ROLE),
    roleKey: configurationKeySchema,
    scope: z.nativeEnum(ParticipantScope).default(ParticipantScope.TENANT),
  }),
  z.object({
    kind: z.literal(ParticipantKind.DEPARTMENT),
    departmentId: uuidSchema,
    /** Only the department's managers, rather than every member. */
    managersOnly: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal(ParticipantKind.MANAGER_OF),
    of: z.nativeEnum(ManagerOfSubject),
  }),
  z.object({
    kind: z.literal(ParticipantKind.GROUP),
    /** An approval group configured in Administration, named by its key. */
    groupKey: configurationKeySchema,
  }),
  z.object({
    kind: z.literal(ParticipantKind.DOCUMENT_FIELD),
    /** A metadata field of type `USER`, named by its key — "Reviewer". */
    fieldKey: configurationKeySchema,
  }),
  z.object({
    kind: z.literal(ParticipantKind.OWNER),
  }),
]);

/**
 * A condition over document context.
 *
 * A small closed expression language, evaluated by a pure function: no expression ever reaches
 * an evaluator that can touch I/O or the database (§2). `field` is a dotted path into a fixed
 * fact set, allow-listed by the engine rather than by this schema — a path the engine cannot
 * resolve is refused at publish, where the message can say which paths exist.
 */
export const stageConditionSchema = z.object({
  field: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-z][A-Za-z0-9]*(?:\.[a-zA-Z0-9_]+)*$/, 'A condition field is a dotted path.'),
  op: conditionOperatorSchema,
  value: z.union([
    z.string().max(200),
    z.number(),
    z.boolean(),
    z.array(z.string().max(200)).max(50),
  ]),
});

export const overdueBehaviourSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('NOTIFY_ONLY') }),
  z.object({
    action: z.literal('ESCALATE'),
    to: participantSchema,
    /** Leave the original task open, so the first person to decide still can. */
    keepOriginal: z.boolean().default(true),
  }),
  z.object({
    action: z.literal('AUTO_APPROVE'),
    /**
     * Required, and required to be true.
     *
     * An approval nobody made is a control that is not there. The engine permits it only for a
     * stage the author has consciously declared informational, so this flag is the declaration —
     * not a switch that can be left at its default (§5).
     */
    nonControlling: z.literal(true),
  }),
  z.object({ action: z.literal('TERMINATE') }),
]);

export const stageDeadlineSchema = z.object({
  duration: durationSchema,
  calendar: z.nativeEnum(DeadlineCalendar).default(DeadlineCalendar.WORKING_DAYS),
});

const stageShape = {
  name: nameSchema,
  participants: z.array(participantSchema).min(1).max(20),
  completionRule: stageCompletionRuleSchema.default(StageCompletionRule.ALL),
  /** The count for `QUORUM`, the percentage for `PERCENT`. Absent for `ALL` and `ANY`. */
  threshold: z.number().int().min(1).max(100).optional(),
  /** Tasks inside a stage run in parallel unless this is set — one primitive, three routings. */
  ordered: z.boolean().default(false),
  condition: stageConditionSchema.nullable().default(null),
  deadline: stageDeadlineSchema.nullable().default(null),
  /** Offsets before the deadline. Each fires once, recorded on the task (§6). */
  reminders: z
    .array(z.object({ before: durationSchema }))
    .max(5)
    .default([]),
  onOverdue: overdueBehaviourSchema.default({ action: 'NOTIFY_ONLY' }),
  onReject: z.nativeEnum(RejectBehaviour).default(RejectBehaviour.TERMINATE),
  maxEscalations: z.number().int().min(0).max(10).default(2),
};

export const workflowStageSchema = z.object(stageShape).superRefine((stage, context) => {
  const wants = needsThreshold(stage.completionRule);
  if (wants && stage.threshold === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['threshold'],
      message: 'A quorum or percentage rule needs a threshold.',
    });
  }
  if (!wants && stage.threshold !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['threshold'],
      message: 'Only a quorum or percentage rule takes a threshold.',
    });
  }
  if (
    stage.completionRule === StageCompletionRule.QUORUM &&
    stage.threshold !== undefined &&
    stage.threshold > stage.participants.length
  ) {
    // A quorum larger than the number of resolvers is a stage that can never complete — and it
    // would fail at submission, in front of an author who cannot fix it.
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['threshold'],
      message: 'A quorum cannot exceed the number of participant resolvers.',
    });
  }
  if (stage.reminders.length > 0 && stage.deadline === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reminders'],
      message: 'A reminder needs a deadline to be measured against.',
    });
  }
  if (stage.onOverdue.action !== 'NOTIFY_ONLY' && stage.deadline === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['onOverdue'],
      message: 'An overdue behaviour needs a deadline to become overdue against.',
    });
  }
});

export const workflowAppliesToSchema = z.object({
  /** Document type codes this definition serves. Empty means every type. */
  documentTypes: z.array(z.string().trim().min(1).max(16)).max(50).default([]),
  condition: stageConditionSchema.nullable().default(null),
});

export const workflowCompletionSchema = z.object({
  /** Draw and assign the document number when the last stage completes (§8, [09]). */
  assignNumber: z.boolean().default(true),
  publish: z.nativeEnum(PublishTiming).default(PublishTiming.IMMEDIATELY),
});

/**
 * The body of a version: what the engine evaluates.
 *
 * Stages are an ordered array, so their index *is* their order — there is no separate `index`
 * field to disagree with the position. That removes the "stages ordered and contiguous" failure
 * mode by construction rather than by validation (§7).
 */
export const workflowDefinitionBodySchema = z.object({
  appliesTo: workflowAppliesToSchema.default({ documentTypes: [], condition: null }),
  stages: z.array(workflowStageSchema).min(1).max(20),
  onComplete: workflowCompletionSchema.default({
    assignNumber: true,
    publish: PublishTiming.IMMEDIATELY,
  }),
});

export type WorkflowStage = z.infer<typeof workflowStageSchema>;
export type WorkflowDefinitionBody = z.infer<typeof workflowDefinitionBodySchema>;
export type Participant = z.infer<typeof participantSchema>;
export type StageCondition = z.infer<typeof stageConditionSchema>;

// --- Definitions -------------------------------------------------------------------------

export const createWorkflowDefinitionSchema = z.object({
  key: configurationKeySchema,
  name: nameSchema,
  description: descriptionSchema.optional(),
  /** The first draft version. A definition with no version is a name with no behaviour. */
  definition: workflowDefinitionBodySchema,
});

export const updateWorkflowDefinitionSchema = z
  .object({
    name: nameSchema,
    description: descriptionSchema.nullable(),
    /** Inactive definitions cannot be attached to a document type; running instances continue. */
    isActive: z.boolean(),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, 'Name at least one field to change.');

/**
 * Editing a version.
 *
 * Only a `DRAFT` version accepts this. A published version is immutable, so "editing" a live
 * workflow means creating a new draft from it and publishing that — which is also what keeps
 * running instances on the rules they started under (§1).
 */
export const updateWorkflowVersionSchema = z.object({
  definition: workflowDefinitionBodySchema,
});

export const workflowVersionSchema = z.object({
  id: uuidSchema,
  version: z.number().int().min(1),
  state: workflowVersionStateSchema,
  definition: workflowDefinitionBodySchema,
  publishedAt: isoDateTimeSchema.nullable(),
  publishedBy: uuidSchema.nullable(),
  createdAt: isoDateTimeSchema,
  createdBy: uuidSchema.nullable(),
  /** Approvals bound to this version. Non-zero is why a version can never be edited or removed. */
  instanceCount: z.number().int().min(0),
});

export const workflowDefinitionSchema = administered({
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  isActive: z.boolean(),
  /** The highest published version, or null while only drafts exist. */
  publishedVersion: z.number().int().min(1).nullable(),
  latestVersion: z.number().int().min(1),
  versions: z.array(workflowVersionSchema),
  documentTypeCount: z.number().int().min(0),
});

export const workflowDefinitionListQuerySchema = adminListQuerySchema([
  'createdAt',
  'updatedAt',
  'name',
  'key',
]).extend({
  isActive: z.enum(['true', 'false']).optional(),
  state: workflowVersionStateSchema.optional(),
});

export type CreateWorkflowDefinitionBody = z.infer<typeof createWorkflowDefinitionSchema>;
export type UpdateWorkflowDefinitionBody = z.infer<typeof updateWorkflowDefinitionSchema>;
export type UpdateWorkflowVersionBody = z.infer<typeof updateWorkflowVersionSchema>;
export type WorkflowVersion = z.infer<typeof workflowVersionSchema>;
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
export type WorkflowDefinitionListQuery = z.infer<typeof workflowDefinitionListQuerySchema>;
