'use client';

import { type ReactNode, useId } from 'react';

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Alert,
  Button,
  Checkbox,
  Field,
  Input,
  Select,
} from '@munaxa/ui';

import type { Participant, WorkflowDefinitionBody, WorkflowStage } from '@edms/contracts';
import {
  ALL_CONDITION_OPERATORS,
  type ConditionOperatorKey,
  DeadlineCalendar,
  type DeadlineCalendarKey,
  ManagerOfSubject,
  type ManagerOfSubjectKey,
  OverdueAction,
  type OverdueActionKey,
  ParticipantKind,
  type ParticipantKindKey,
  ParticipantScope,
  type ParticipantScopeKey,
  PublishTiming,
  type PublishTimingKey,
  RejectBehaviour,
  type RejectBehaviourKey,
  StageCompletionRule,
  type StageCompletionRuleKey,
} from '@edms/domain';
import type { MessageKey } from '@edms/i18n';

import { useTranslate } from '../../app/providers';
import type { Choice } from '../admin-shared';

const COMPLETION_LABELS: Readonly<Record<StageCompletionRuleKey, MessageKey>> = {
  ALL: 'admin.workflows.completionALL',
  ANY: 'admin.workflows.completionANY',
  QUORUM: 'admin.workflows.completionQUORUM',
  PERCENT: 'admin.workflows.completionPERCENT',
};

const PARTICIPANT_LABELS: Readonly<Record<ParticipantKindKey, MessageKey>> = {
  USER: 'admin.workflows.participantUSER',
  ROLE: 'admin.workflows.participantROLE',
  DEPARTMENT: 'admin.workflows.participantDEPARTMENT',
  MANAGER_OF: 'admin.workflows.participantMANAGER_OF',
  GROUP: 'admin.workflows.participantGROUP',
  DOCUMENT_FIELD: 'admin.workflows.participantDOCUMENT_FIELD',
  OWNER: 'admin.workflows.participantOWNER',
};

const SCOPE_LABELS: Readonly<Record<ParticipantScopeKey, MessageKey>> = {
  TENANT: 'admin.workflows.scopeTENANT',
  DOCUMENT_ENTITY: 'admin.workflows.scopeDOCUMENT_ENTITY',
  DOCUMENT_DEPARTMENT: 'admin.workflows.scopeDOCUMENT_DEPARTMENT',
};

const MANAGER_LABELS: Readonly<Record<ManagerOfSubjectKey, MessageKey>> = {
  AUTHOR: 'admin.workflows.managerOfAUTHOR',
  OWNER: 'admin.workflows.managerOfOWNER',
  ASSIGNEE: 'admin.workflows.managerOfASSIGNEE',
  PREVIOUS_APPROVER: 'admin.workflows.managerOfPREVIOUS_APPROVER',
};

const OVERDUE_LABELS: Readonly<Record<OverdueActionKey, MessageKey>> = {
  NOTIFY_ONLY: 'admin.workflows.overdueNOTIFY_ONLY',
  ESCALATE: 'admin.workflows.overdueESCALATE',
  AUTO_APPROVE: 'admin.workflows.overdueAUTO_APPROVE',
  TERMINATE: 'admin.workflows.overdueTERMINATE',
};

const REJECT_LABELS: Readonly<Record<RejectBehaviourKey, MessageKey>> = {
  TERMINATE: 'admin.workflows.rejectTERMINATE',
  RETURN_TO_AUTHOR: 'admin.workflows.rejectRETURN_TO_AUTHOR',
};

const PUBLISH_LABELS: Readonly<Record<PublishTimingKey, MessageKey>> = {
  IMMEDIATELY: 'admin.workflows.publishIMMEDIATELY',
  ON_EFFECTIVE_DATE: 'admin.workflows.publishON_EFFECTIVE_DATE',
  MANUALLY: 'admin.workflows.publishMANUALLY',
};

/** The body a new definition or a new draft starts from: one stage, approved by the owner's manager. */
export const STARTING_DEFINITION: WorkflowDefinitionBody = {
  appliesTo: { documentTypes: [], condition: null },
  stages: [
    {
      name: 'Review',
      participants: [{ kind: ParticipantKind.MANAGER_OF, of: ManagerOfSubject.AUTHOR }],
      completionRule: StageCompletionRule.ALL,
      ordered: false,
      condition: null,
      deadline: null,
      reminders: [],
      onOverdue: { action: OverdueAction.NOTIFY_ONLY },
      onReject: RejectBehaviour.TERMINATE,
      maxEscalations: 2,
    },
  ],
  onComplete: { assignNumber: true, publish: PublishTiming.IMMEDIATELY },
};

/**
 * The editor for a version's body: what applies, the stages, and what happens at the end.
 *
 * Controlled by the caller, because the body is a single value and this editor's job is to produce it —
 * the screen that owns it is the one that knows whether it is saving a new definition, a new draft or an
 * existing one.
 *
 * Two things are deliberately absent. There is no stage *index* — the array's order is the order, so the
 * "contiguous and ordered" failure mode does not exist to be validated. And there is no client-side
 * check that a stage is reachable or that a condition names a resolvable fact: the validator that
 * answers those lives in the domain and runs at publish, where it can say which facts exist. A second
 * copy here would be a second opinion, and the first time they disagreed the wrong one would win.
 */
export function DefinitionEditor({
  value,
  onChange,
  documentTypes,
  disabled,
}: {
  value: WorkflowDefinitionBody;
  onChange: (next: WorkflowDefinitionBody) => void;
  /** Type codes this definition may be limited to. Empty means every type. */
  documentTypes: readonly Choice[];
  disabled?: boolean;
}): ReactNode {
  const translate = useTranslate();
  const publishId = useId();

  const setStage = (index: number, stage: WorkflowStage): void => {
    onChange({
      ...value,
      stages: value.stages.map((current, position) => (position === index ? stage : current)),
    });
  };

  const moveStage = (index: number, offset: number): void => {
    const target = index + offset;
    if (target < 0 || target >= value.stages.length) {
      return;
    }
    const stages = [...value.stages];
    const moved = stages[index];
    const other = stages[target];
    if (moved === undefined || other === undefined) {
      return;
    }
    stages[index] = other;
    stages[target] = moved;
    onChange({ ...value, stages });
  };

  return (
    <>
      <Field
        label={translate('admin.workflows.appliesTo')}
        hint={translate('admin.workflows.appliesToAll')}
      >
        <div className="grid gap-2 sm:grid-cols-2">
          {documentTypes.map((type) => (
            <Checkbox
              key={type.value}
              checked={value.appliesTo.documentTypes.includes(type.value)}
              disabled={disabled}
              label={type.label}
              onChange={(event) => {
                const chosen = event.currentTarget.checked
                  ? [...value.appliesTo.documentTypes, type.value]
                  : value.appliesTo.documentTypes.filter((code) => code !== type.value);
                onChange({ ...value, appliesTo: { ...value.appliesTo, documentTypes: chosen } });
              }}
            />
          ))}
        </div>
      </Field>

      <Field label={translate('admin.workflows.stages')}>
        <div className="flex flex-col gap-2">
          <Accordion type="multiple">
            {value.stages.map((stage, index) => (
              <AccordionItem key={index} value={String(index)}>
                {/*
                  Level 3 — Phase 8.24, and it is the same correction as `PermissionMatrix`.

                  Every place this editor renders is inside a dialogue: the "Add workflow"
                  dialogue on `/admin/workflows` and the draft dialogue on a workflow's versions
                  screen. `Dialog` renders its title as an `h2`, so a stage heading at level 4 skips
                  3 in both — measured as `h1 Approval workflows` → `h2 Add workflow` → `4. 1
                  Review`.
                */}
                <AccordionTrigger level={3}>
                  {index + 1}.{' '}
                  {stage.name === '' ? translate('admin.workflows.stageName') : stage.name}
                </AccordionTrigger>
                <AccordionContent>
                  <div className="flex flex-col gap-3 pt-2">
                    <StageFields
                      stage={stage}
                      disabled={disabled === true}
                      onChange={(next) => {
                        setStage(index, next);
                      }}
                    />
                    <div className="flex gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={disabled === true || index === 0}
                        onClick={() => {
                          moveStage(index, -1);
                        }}
                      >
                        <span aria-hidden>↑</span> {translate('admin.actions.move')}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={disabled === true || index === value.stages.length - 1}
                        onClick={() => {
                          moveStage(index, 1);
                        }}
                      >
                        <span aria-hidden>↓</span> {translate('admin.actions.move')}
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        // A definition needs at least one stage: a workflow with none is an approval
                        // that approves nothing, and the contract refuses it.
                        disabled={disabled === true || value.stages.length === 1}
                        onClick={() => {
                          onChange({
                            ...value,
                            stages: value.stages.filter((_, position) => position !== index),
                          });
                        }}
                      >
                        {translate('admin.actions.delete')}
                      </Button>
                    </div>
                  </div>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>

          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled === true || value.stages.length >= 20}
            onClick={() => {
              onChange({
                ...value,
                stages: [
                  ...value.stages,
                  {
                    ...STARTING_DEFINITION.stages[0],
                    name: '',
                  } as WorkflowStage,
                ],
              });
            }}
          >
            {translate('admin.workflows.addStage')}
          </Button>
        </div>
      </Field>

      <Field label={translate('admin.workflows.onComplete')}>
        <div className="flex flex-col gap-2">
          <Checkbox
            checked={value.onComplete.assignNumber}
            disabled={disabled}
            label={translate('admin.workflows.assignNumber')}
            onChange={(event) => {
              onChange({
                ...value,
                onComplete: { ...value.onComplete, assignNumber: event.currentTarget.checked },
              });
            }}
          />
          <Field label={translate('admin.workflows.publishTiming')} htmlFor={publishId}>
            <Select
              id={publishId}
              value={value.onComplete.publish}
              disabled={disabled}
              onChange={(event) => {
                onChange({
                  ...value,
                  onComplete: {
                    ...value.onComplete,
                    publish: event.currentTarget.value as PublishTimingKey,
                  },
                });
              }}
            >
              {Object.values(PublishTiming).map((timing) => (
                <option key={timing} value={timing}>
                  {translate(PUBLISH_LABELS[timing])}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Field>
    </>
  );
}

/**
 * The duration and calendar of a stage's deadline.
 *
 * A component rather than JSX inside the branch that checked for null, and that is a type-level reason
 * worth stating: narrowing `stage.deadline` does not survive into the change handlers below it, so
 * spreading it there produces a shape with every field optional. Passing it as a prop makes the
 * non-null value the thing the handlers close over.
 */
function DeadlineControls({
  deadline,
  disabled,
  onChange,
}: {
  deadline: NonNullable<WorkflowStage['deadline']>;
  disabled: boolean;
  onChange: (deadline: NonNullable<WorkflowStage['deadline']>) => void;
}): ReactNode {
  const translate = useTranslate();
  return (
    <>
      <Input
        aria-label={translate('admin.workflows.deadlineDuration')}
        value={deadline.duration}
        placeholder="P3D"
        disabled={disabled}
        className="w-28"
        onChange={(event) => {
          onChange({ ...deadline, duration: event.currentTarget.value });
        }}
      />
      <Select
        aria-label={translate('admin.workflows.deadlineCalendar')}
        value={deadline.calendar}
        disabled={disabled}
        className="w-44"
        onChange={(event) => {
          onChange({ ...deadline, calendar: event.currentTarget.value as DeadlineCalendarKey });
        }}
      >
        <option value={DeadlineCalendar.WORKING_DAYS}>
          {translate('admin.workflows.calendarWORKING_DAYS')}
        </option>
        <option value={DeadlineCalendar.CALENDAR_DAYS}>
          {translate('admin.workflows.calendarCALENDAR_DAYS')}
        </option>
      </Select>
    </>
  );
}

/** One stage's settings. Split out because a stage has fourteen of them and the nesting matters. */
function StageFields({
  stage,
  disabled,
  onChange,
}: {
  stage: WorkflowStage;
  disabled: boolean;
  onChange: (stage: WorkflowStage) => void;
}): ReactNode {
  const translate = useTranslate();
  const needsThreshold =
    stage.completionRule === StageCompletionRule.QUORUM ||
    stage.completionRule === StageCompletionRule.PERCENT;

  return (
    <>
      <Field label={translate('admin.workflows.stageName')}>
        <Input
          value={stage.name}
          disabled={disabled}
          maxLength={200}
          onChange={(event) => {
            onChange({ ...stage, name: event.currentTarget.value });
          }}
        />
      </Field>

      <ParticipantList
        participants={stage.participants}
        disabled={disabled}
        onChange={(participants) => {
          onChange({ ...stage, participants: [...participants] });
        }}
      />

      <Field label={translate('admin.workflows.completionRule')}>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={stage.completionRule}
            disabled={disabled}
            className="w-52"
            onChange={(event) => {
              const rule = event.currentTarget.value as StageCompletionRuleKey;
              const wants =
                rule === StageCompletionRule.QUORUM || rule === StageCompletionRule.PERCENT;
              // The threshold is dropped when the rule stops taking one, because the contract refuses
              // a threshold on `ALL` — correctly: it would be a number with no meaning.
              const { threshold: _dropped, ...rest } = stage;
              onChange({
                ...rest,
                completionRule: rule,
                ...(wants && { threshold: stage.threshold ?? 1 }),
              });
            }}
          >
            {Object.values(StageCompletionRule).map((rule) => (
              <option key={rule} value={rule}>
                {translate(COMPLETION_LABELS[rule])}
              </option>
            ))}
          </Select>
          {needsThreshold ? (
            <Input
              type="number"
              aria-label={translate('admin.workflows.threshold')}
              value={String(stage.threshold ?? 1)}
              min={1}
              max={100}
              disabled={disabled}
              className="w-24"
              onChange={(event) => {
                onChange({
                  ...stage,
                  threshold: Number.parseInt(event.currentTarget.value, 10) || 1,
                });
              }}
            />
          ) : null}
        </div>
      </Field>

      <Checkbox
        checked={stage.ordered}
        disabled={disabled}
        label={`${translate('admin.workflows.ordered')} — ${translate('admin.workflows.orderedHint')}`}
        onChange={(event) => {
          onChange({ ...stage, ordered: event.currentTarget.checked });
        }}
      />

      <ConditionFields
        label={translate('admin.workflows.condition')}
        condition={stage.condition}
        disabled={disabled}
        onChange={(condition) => {
          onChange({ ...stage, condition });
        }}
      />

      <Field label={translate('admin.workflows.deadline')}>
        <div className="flex flex-wrap items-center gap-2">
          <Checkbox
            checked={stage.deadline !== null}
            disabled={disabled}
            label={translate('admin.workflows.deadlineDuration')}
            onChange={(event) => {
              onChange({
                ...stage,
                deadline: event.currentTarget.checked
                  ? { duration: 'P3D', calendar: DeadlineCalendar.WORKING_DAYS }
                  : null,
                // Reminders and an overdue behaviour both need a deadline to be measured against, so
                // removing it removes them rather than leaving a body the contract refuses.
                ...(event.currentTarget.checked
                  ? {}
                  : { reminders: [], onOverdue: { action: OverdueAction.NOTIFY_ONLY } }),
              });
            }}
          />
          {stage.deadline === null ? null : (
            <DeadlineControls
              deadline={stage.deadline}
              disabled={disabled}
              onChange={(deadline) => {
                onChange({ ...stage, deadline });
              }}
            />
          )}
        </div>
      </Field>

      {stage.deadline === null ? null : (
        <>
          <Field label={translate('admin.workflows.reminders')}>
            <div className="flex flex-col gap-2">
              {stage.reminders.map((reminder, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Input
                    aria-label={translate('admin.workflows.reminderBefore')}
                    value={reminder.before}
                    placeholder="P1D"
                    disabled={disabled}
                    className="w-28"
                    onChange={(event) => {
                      onChange({
                        ...stage,
                        reminders: stage.reminders.map((current, position) =>
                          position === index ? { before: event.currentTarget.value } : current,
                        ),
                      });
                    }}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={translate('admin.actions.delete')}
                    disabled={disabled}
                    onClick={() => {
                      onChange({
                        ...stage,
                        reminders: stage.reminders.filter((_, position) => position !== index),
                      });
                    }}
                  >
                    <span aria-hidden>✕</span>
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled || stage.reminders.length >= 5}
                onClick={() => {
                  onChange({ ...stage, reminders: [...stage.reminders, { before: 'P1D' }] });
                }}
              >
                {translate('admin.workflows.addReminder')}
              </Button>
            </div>
          </Field>

          <Field label={translate('admin.workflows.onOverdue')}>
            <div className="flex flex-col gap-2">
              <Select
                value={stage.onOverdue.action}
                disabled={disabled}
                onChange={(event) => {
                  onChange({
                    ...stage,
                    onOverdue: overdueFor(event.currentTarget.value as OverdueActionKey),
                  });
                }}
              >
                {Object.values(OverdueAction).map((action) => (
                  <option key={action} value={action}>
                    {translate(OVERDUE_LABELS[action])}
                  </option>
                ))}
              </Select>

              {stage.onOverdue.action === OverdueAction.AUTO_APPROVE ? (
                <Alert tone="warning">{translate('admin.workflows.autoApproveWarning')}</Alert>
              ) : null}

              {stage.onOverdue.action === OverdueAction.ESCALATE ? (
                <>
                  <ParticipantRow
                    participant={stage.onOverdue.to}
                    disabled={disabled}
                    onChange={(to) => {
                      onChange({
                        ...stage,
                        onOverdue: { action: OverdueAction.ESCALATE, to, keepOriginal: true },
                      });
                    }}
                  />
                  <Checkbox
                    checked={stage.onOverdue.keepOriginal}
                    disabled={disabled}
                    label={translate('admin.workflows.keepOriginal')}
                    onChange={(event) => {
                      if (stage.onOverdue.action !== OverdueAction.ESCALATE) {
                        return;
                      }
                      onChange({
                        ...stage,
                        onOverdue: {
                          action: OverdueAction.ESCALATE,
                          to: stage.onOverdue.to,
                          keepOriginal: event.currentTarget.checked,
                        },
                      });
                    }}
                  />
                  <Field label={translate('admin.workflows.maxEscalations')}>
                    <Input
                      type="number"
                      value={String(stage.maxEscalations)}
                      min={0}
                      max={10}
                      disabled={disabled}
                      className="w-24"
                      onChange={(event) => {
                        onChange({
                          ...stage,
                          maxEscalations: Number.parseInt(event.currentTarget.value, 10) || 0,
                        });
                      }}
                    />
                  </Field>
                </>
              ) : null}
            </div>
          </Field>
        </>
      )}

      <Field label={translate('admin.workflows.onReject')}>
        <Select
          value={stage.onReject}
          disabled={disabled}
          onChange={(event) => {
            onChange({ ...stage, onReject: event.currentTarget.value as RejectBehaviourKey });
          }}
        >
          {Object.values(RejectBehaviour).map((behaviour) => (
            <option key={behaviour} value={behaviour}>
              {translate(REJECT_LABELS[behaviour])}
            </option>
          ))}
        </Select>
      </Field>
    </>
  );
}

function ParticipantList({
  participants,
  disabled,
  onChange,
}: {
  participants: readonly Participant[];
  disabled: boolean;
  onChange: (participants: readonly Participant[]) => void;
}): ReactNode {
  const translate = useTranslate();

  return (
    <Field label={translate('admin.workflows.participants')}>
      <div className="flex flex-col gap-2">
        {participants.map((participant, index) => (
          <div key={index} className="flex items-center gap-2">
            <ParticipantRow
              participant={participant}
              disabled={disabled}
              onChange={(next) => {
                onChange(
                  participants.map((current, position) => (position === index ? next : current)),
                );
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={translate('admin.actions.delete')}
              // A stage needs at least one resolver, or it is a stage nobody is asked to decide.
              disabled={disabled || participants.length === 1}
              onClick={() => {
                onChange(participants.filter((_, position) => position !== index));
              }}
            >
              <span aria-hidden>✕</span>
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || participants.length >= 20}
          onClick={() => {
            onChange([
              ...participants,
              { kind: ParticipantKind.MANAGER_OF, of: ManagerOfSubject.AUTHOR },
            ]);
          }}
        >
          {translate('admin.workflows.addParticipant')}
        </Button>
      </div>
    </Field>
  );
}

/**
 * One resolver.
 *
 * A resolver, not a person: participants are resolved when a stage activates, never stored as user
 * ids, so a reorganisation does not break a workflow authored before it. Naming a specific user is
 * possible and carries a warning, because that workflow breaks the day they leave.
 */
function ParticipantRow({
  participant,
  disabled,
  onChange,
}: {
  participant: Participant;
  disabled: boolean;
  onChange: (participant: Participant) => void;
}): ReactNode {
  const translate = useTranslate();

  return (
    <div className="flex flex-1 flex-wrap items-center gap-2">
      <Select
        aria-label={translate('admin.workflows.participants')}
        value={participant.kind}
        disabled={disabled}
        className="min-w-44 flex-1"
        onChange={(event) => {
          onChange(blankParticipant(event.currentTarget.value as ParticipantKindKey));
        }}
      >
        {Object.values(ParticipantKind).map((kind) => (
          <option key={kind} value={kind}>
            {translate(PARTICIPANT_LABELS[kind])}
          </option>
        ))}
      </Select>

      {participant.kind === ParticipantKind.USER ? (
        <>
          <Input
            aria-label={translate('admin.users.one')}
            value={participant.userId}
            disabled={disabled}
            className="w-72"
            onChange={(event) => {
              onChange({ kind: ParticipantKind.USER, userId: event.currentTarget.value });
            }}
          />
          <p className="text-muted-foreground w-full text-xs">
            {translate('admin.workflows.participantUserHint')}
          </p>
        </>
      ) : null}

      {participant.kind === ParticipantKind.ROLE ? (
        <>
          <Input
            aria-label={translate('admin.roles.one')}
            value={participant.roleKey}
            disabled={disabled}
            className="w-52"
            onChange={(event) => {
              onChange({
                kind: ParticipantKind.ROLE,
                roleKey: event.currentTarget.value,
                scope: participant.scope,
              });
            }}
          />
          <Select
            aria-label={translate('admin.workflows.scopeTENANT')}
            value={participant.scope}
            disabled={disabled}
            className="w-56"
            onChange={(event) => {
              onChange({
                kind: ParticipantKind.ROLE,
                roleKey: participant.roleKey,
                scope: event.currentTarget.value as ParticipantScopeKey,
              });
            }}
          >
            {Object.values(ParticipantScope).map((scope) => (
              <option key={scope} value={scope}>
                {translate(SCOPE_LABELS[scope])}
              </option>
            ))}
          </Select>
        </>
      ) : null}

      {participant.kind === ParticipantKind.DEPARTMENT ? (
        <>
          <Input
            aria-label={translate('admin.departments.one')}
            value={participant.departmentId}
            disabled={disabled}
            className="w-72"
            onChange={(event) => {
              onChange({
                kind: ParticipantKind.DEPARTMENT,
                departmentId: event.currentTarget.value,
                managersOnly: participant.managersOnly,
              });
            }}
          />
          <Checkbox
            checked={participant.managersOnly}
            disabled={disabled}
            label={translate('admin.departments.members')}
            onChange={(event) => {
              onChange({
                kind: ParticipantKind.DEPARTMENT,
                departmentId: participant.departmentId,
                managersOnly: event.currentTarget.checked,
              });
            }}
          />
        </>
      ) : null}

      {participant.kind === ParticipantKind.MANAGER_OF ? (
        <Select
          aria-label={translate('admin.workflows.participantMANAGER_OF')}
          value={participant.of}
          disabled={disabled}
          className="w-56"
          onChange={(event) => {
            onChange({
              kind: ParticipantKind.MANAGER_OF,
              of: event.currentTarget.value as ManagerOfSubjectKey,
            });
          }}
        >
          {Object.values(ManagerOfSubject).map((subject) => (
            <option key={subject} value={subject}>
              {translate(MANAGER_LABELS[subject])}
            </option>
          ))}
        </Select>
      ) : null}

      {participant.kind === ParticipantKind.GROUP ? (
        <Input
          aria-label={translate('admin.workflows.participantGROUP')}
          value={participant.groupKey}
          disabled={disabled}
          className="w-52"
          onChange={(event) => {
            onChange({ kind: ParticipantKind.GROUP, groupKey: event.currentTarget.value });
          }}
        />
      ) : null}

      {participant.kind === ParticipantKind.DOCUMENT_FIELD ? (
        <Input
          aria-label={translate('admin.workflows.participantDOCUMENT_FIELD')}
          value={participant.fieldKey}
          disabled={disabled}
          className="w-52"
          onChange={(event) => {
            onChange({ kind: ParticipantKind.DOCUMENT_FIELD, fieldKey: event.currentTarget.value });
          }}
        />
      ) : null}
    </div>
  );
}

/** A stage or applicability condition: a fact, a comparison, a value. */
function ConditionFields({
  label,
  condition,
  disabled,
  onChange,
}: {
  label: string;
  condition: WorkflowStage['condition'];
  disabled: boolean;
  onChange: (condition: WorkflowStage['condition']) => void;
}): ReactNode {
  const translate = useTranslate();

  return (
    <Field label={label}>
      <div className="flex flex-wrap items-center gap-2">
        <Checkbox
          checked={condition !== null}
          disabled={disabled}
          label={label}
          onChange={(event) => {
            onChange(
              event.currentTarget.checked
                ? { field: 'confidentiality.rank', op: '>=', value: 1 }
                : null,
            );
          }}
        />
        {condition === null ? null : (
          <>
            <Input
              aria-label={translate('admin.workflows.condition')}
              value={condition.field}
              disabled={disabled}
              className="w-56"
              onChange={(event) => {
                onChange({ ...condition, field: event.currentTarget.value });
              }}
            />
            <Select
              aria-label={translate('admin.workflows.condition')}
              value={condition.op}
              disabled={disabled}
              className="w-28"
              onChange={(event) => {
                onChange({ ...condition, op: event.currentTarget.value as ConditionOperatorKey });
              }}
            >
              {ALL_CONDITION_OPERATORS.map((operator) => (
                <option key={operator} value={operator}>
                  {operator}
                </option>
              ))}
            </Select>
            <Input
              aria-label={translate('admin.settings.value')}
              value={String(condition.value)}
              disabled={disabled}
              className="w-40"
              onChange={(event) => {
                // Numbers arrive as numbers so a `>=` comparison is numeric rather than lexical: "10"
                // is less than "9" as text, and a condition that silently compared that way would
                // route the wrong documents.
                const raw = event.currentTarget.value;
                const asNumber = Number(raw);
                onChange({
                  ...condition,
                  value: raw !== '' && Number.isFinite(asNumber) ? asNumber : raw,
                });
              }}
            />
          </>
        )}
      </div>
    </Field>
  );
}

function blankParticipant(kind: ParticipantKindKey): Participant {
  switch (kind) {
    case ParticipantKind.USER:
      return { kind, userId: '' };
    case ParticipantKind.ROLE:
      return { kind, roleKey: '', scope: ParticipantScope.TENANT };
    case ParticipantKind.DEPARTMENT:
      return { kind, departmentId: '', managersOnly: false };
    case ParticipantKind.MANAGER_OF:
      return { kind, of: ManagerOfSubject.AUTHOR };
    case ParticipantKind.GROUP:
      return { kind, groupKey: '' };
    case ParticipantKind.DOCUMENT_FIELD:
      return { kind, fieldKey: '' };
    default:
      return { kind: ParticipantKind.OWNER };
  }
}

/** A fresh overdue behaviour for a chosen action, with the contract's required fields present. */
function overdueFor(action: OverdueActionKey): WorkflowStage['onOverdue'] {
  switch (action) {
    case OverdueAction.ESCALATE:
      return {
        action,
        to: { kind: ParticipantKind.MANAGER_OF, of: ManagerOfSubject.ASSIGNEE },
        keepOriginal: true,
      };
    case OverdueAction.AUTO_APPROVE:
      // `nonControlling` is required to be `true`, not defaulted: it is the author's declaration that
      // the stage decides nothing, and a switch left at its default is not a declaration.
      return { action, nonControlling: true };
    case OverdueAction.TERMINATE:
      return { action };
    default:
      return { action: OverdueAction.NOTIFY_ONLY };
  }
}
