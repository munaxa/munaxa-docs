import { ParticipantKind, StageCompletionRule, needsThreshold } from '@edms/domain';

/**
 * What a workflow version must satisfy before it may be published.
 *
 * Pure, and validated at *publish* rather than only at save, because a published version is immutable
 * and binds every approval started under it: a draft may be incoherent while somebody is building it,
 * and the moment it becomes the rules an approval runs by, it may not be.
 *
 * `07-workflow-architecture.md` §7 lists what the future graphical designer must respect, and it is
 * the same list as this: stages ordered and contiguous, every resolver well-formed, every condition
 * parseable, no unreachable stage, at least one stage. Two of those are free here — stages are an
 * array, so their index *is* their order, and there is no separate `index` field to disagree with the
 * position — and the rest are below.
 *
 * The one thing this deliberately does not do is resolve participants. A resolver names a role key or
 * a field key, and whether a holder exists is a question about *this document, at this moment* — which
 * is why §2 resolves them at stage activation and why a definition that resolves to nobody fails loudly
 * at submission rather than silently skipping a control.
 */

/** A stage, as stored. Mirrors `workflowStageSchema` in `@edms/contracts`. */
export interface StageShape {
  readonly name: string;
  readonly participants: readonly { readonly kind: string; readonly [key: string]: unknown }[];
  readonly completionRule: string;
  readonly threshold?: number | undefined;
  readonly ordered?: boolean;
  readonly condition?: { readonly field: string; readonly op: string } | null;
  readonly deadline?: { readonly duration: string } | null;
  readonly reminders?: readonly { readonly before: string }[];
  readonly onOverdue?: { readonly action: string; readonly nonControlling?: boolean };
  readonly maxEscalations?: number;
}

export interface DefinitionShape {
  readonly stages: readonly StageShape[];
  readonly appliesTo?: { readonly documentTypes?: readonly string[] } | undefined;
}

export type VersionRejection =
  | 'NO_STAGES'
  | 'STAGE_WITHOUT_NAME'
  | 'STAGE_WITHOUT_PARTICIPANTS'
  | 'DUPLICATE_STAGE_NAME'
  | 'THRESHOLD_MISSING'
  | 'THRESHOLD_NOT_APPLICABLE'
  | 'QUORUM_EXCEEDS_PARTICIPANTS'
  | 'PERCENT_OUT_OF_RANGE'
  | 'REMINDER_WITHOUT_DEADLINE'
  | 'OVERDUE_WITHOUT_DEADLINE'
  | 'AUTO_APPROVE_NOT_DECLARED'
  | 'UNREACHABLE_STAGE'
  | 'NAMED_USER_PARTICIPANT';

/**
 * The fields a condition may test.
 *
 * An allow-list rather than a free path, and it lives here rather than in the wire schema for one
 * reason: this is the set the *evaluator* can resolve, so it is the set a publish must be checked
 * against. A schema that accepted any dotted path would let a definition be saved with a condition
 * the engine cannot evaluate, and the failure would surface at somebody's submission.
 *
 * Metadata is addressed as `metadata.<key>`, which is checked by prefix — the keys are tenant data and
 * cannot be enumerated here.
 */
const CONDITION_FIELDS: ReadonlySet<string> = new Set([
  'documentType.code',
  'category.code',
  'confidentiality.rank',
  'department.code',
  'entity.code',
  'revision.isFirst',
  'revision.ordinal',
]);

const METADATA_PREFIX = 'metadata.';

export function isEvaluableConditionField(field: string): boolean {
  return CONDITION_FIELDS.has(field) || field.startsWith(METADATA_PREFIX);
}

/** Every field a condition may name, for an error message that says what is available. */
export const EVALUABLE_CONDITION_FIELDS: readonly string[] = Object.freeze([...CONDITION_FIELDS]);

/**
 * Whether a version may be published.
 *
 * Returns every reason. A workflow author fixing one stage and discovering the next problem is the
 * experience this avoids — and a definition is the kind of thing somebody builds once, carefully, at
 * the end of an implementation project.
 */
export function checkVersion(definition: DefinitionShape): readonly VersionRejection[] {
  const rejections: VersionRejection[] = [];

  if (definition.stages.length === 0) {
    // Not accompanied by every per-stage complaint: "you have not built anything yet" is one problem.
    return ['NO_STAGES'];
  }

  const names = new Set<string>();
  for (const [index, stage] of definition.stages.entries()) {
    if (stage.name.trim().length === 0) {
      rejections.push('STAGE_WITHOUT_NAME');
    }
    const lowered = stage.name.trim().toLowerCase();
    if (names.has(lowered)) {
      // Stages are referred to by name in notifications, task lists and audit events. Two stages with
      // one name makes every one of those ambiguous.
      rejections.push('DUPLICATE_STAGE_NAME');
    }
    names.add(lowered);

    if (stage.participants.length === 0) {
      // A stage with no resolvers is a control that will fail at submission, in front of an author who
      // cannot fix it.
      rejections.push('STAGE_WITHOUT_PARTICIPANTS');
    }
    if (stage.participants.some((participant) => participant.kind === ParticipantKind.USER)) {
      // Not a hard failure — §2 permits it and calls it discouraged — but a definition naming a person
      // breaks the day they leave, so it is reported for a publisher to acknowledge.
      rejections.push('NAMED_USER_PARTICIPANT');
    }

    rejections.push(...checkCompletion(stage));
    rejections.push(...checkTiming(stage));

    // A stage whose condition can never hold is unreachable, and §7 forbids one. The only case a pure
    // check can be certain of is a condition naming a fact the evaluator cannot resolve: it will never
    // be true, because it will never be evaluated.
    if (stage.condition != null && !isEvaluableConditionField(stage.condition.field)) {
      rejections.push('UNREACHABLE_STAGE');
    }
    void index;
  }

  return rejections;
}

function checkCompletion(stage: StageShape): readonly VersionRejection[] {
  const rejections: VersionRejection[] = [];
  const wants = needsThreshold(stage.completionRule as never);

  if (wants && stage.threshold === undefined) {
    rejections.push('THRESHOLD_MISSING');
  }
  if (!wants && stage.threshold !== undefined) {
    rejections.push('THRESHOLD_NOT_APPLICABLE');
  }
  if (
    stage.completionRule === StageCompletionRule.QUORUM &&
    stage.threshold !== undefined &&
    stage.threshold > stage.participants.length
  ) {
    // A quorum larger than the number of resolvers is a stage that can never complete. It would fail at
    // submission rather than here, which is the wrong place and the wrong person.
    rejections.push('QUORUM_EXCEEDS_PARTICIPANTS');
  }
  if (
    stage.completionRule === StageCompletionRule.PERCENT &&
    stage.threshold !== undefined &&
    (stage.threshold < 1 || stage.threshold > 100)
  ) {
    rejections.push('PERCENT_OUT_OF_RANGE');
  }
  return rejections;
}

function checkTiming(stage: StageShape): readonly VersionRejection[] {
  const rejections: VersionRejection[] = [];
  const hasDeadline = stage.deadline != null;

  if ((stage.reminders?.length ?? 0) > 0 && !hasDeadline) {
    // A reminder is an offset *before a deadline*. With none, there is nothing to measure it from.
    rejections.push('REMINDER_WITHOUT_DEADLINE');
  }
  const action = stage.onOverdue?.action;
  if (action !== undefined && action !== 'NOTIFY_ONLY' && !hasDeadline) {
    rejections.push('OVERDUE_WITHOUT_DEADLINE');
  }
  if (action === 'AUTO_APPROVE' && stage.onOverdue?.nonControlling !== true) {
    // An approval nobody made is a control that is not there. §5 permits it only for a stage the author
    // has consciously declared informational, and this is that declaration.
    rejections.push('AUTO_APPROVE_NOT_DECLARED');
  }
  return rejections;
}
