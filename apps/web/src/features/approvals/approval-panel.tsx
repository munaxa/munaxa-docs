'use client';

import { useRouter } from 'next/navigation';
import { type ReactNode, useState } from 'react';

import { Alert, Badge, Button, Card, EmptyState, useToast } from '@munaxa/ui';

import type {
  ApprovalTask,
  DocumentWorkflow,
  WorkflowInstance,
  WorkflowStageSummary,
} from '@edms/contracts';
import { TaskDecision, type TaskDecisionKey, WorkflowPauseReason } from '@edms/domain';
import type { MessageKey } from '@edms/i18n';

import { useSession, useTranslate } from '../../app/providers';
import { FormDialog, TextAreaField, optionalText, text } from '../admin-shared';
import {
  addComment,
  pauseApproval,
  resumeApproval,
  submitForApproval,
  withdrawSubmission,
} from './actions';
import { DecisionDialog } from './decision-dialog';

/**
 * A document's approval, on the document's own page.
 *
 * Three things in one area because they are one question — "who must agree before this becomes
 * official, and where has it got to" — and splitting them across tabs would make the answer
 * something a person has to assemble.
 *
 * **The timeline is the instance rendered forwards.** Stages in order, tasks inside each, and the
 * conversation underneath. It is not a projection maintained separately: a history is a list of
 * these, which is why the API serves both from one shape.
 *
 * **The buttons come from the server.** `availableTransitions` is computed against the lifecycle
 * table, so this renders exactly what the product can do rather than a client's guess at it
 * (`06-document-lifecycle.md` §5). A button that returned a 404 would be worse than an absent one.
 */
export function ApprovalPanel({
  workflow,
  canSubmit,
  canApprove,
  canReject,
  canManage,
}: {
  readonly workflow: DocumentWorkflow;
  readonly canSubmit: boolean;
  readonly canApprove: boolean;
  readonly canReject: boolean;
  readonly canManage: boolean;
}): ReactNode {
  const translate = useTranslate();
  // Who is signed in comes from the session the server resolved and passed down, never from a
  // second fetch: it is what decides whether a task in the timeline shows its buttons.
  const { userId: currentUserId } = useSession();
  const router = useRouter();
  const toast = useToast();
  const [submitting, setSubmitting] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [commenting, setCommenting] = useState(false);
  const [deciding, setDeciding] = useState<{ taskId: string; decision: TaskDecisionKey } | null>(
    null,
  );

  const refresh = (): void => {
    router.refresh();
  };

  if (!workflow.requiresApproval) {
    return (
      <Card>
        <EmptyState
          title={translate('approvals.title')}
          description={translate('approvals.noApprovalNeeded')}
        />
      </Card>
    );
  }

  const current = workflow.current;
  const canWithdraw =
    current !== null &&
    canSubmit &&
    current.stages.every((stage) => stage.tasks.every((task) => task.decision === null));

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">{translate('approvals.title')}</h2>
        {current !== null && (
          <Badge tone={current.status === 'PAUSED' ? 'warning' : 'muted'}>
            {translate(`approvals.instance${current.status}`)}
          </Badge>
        )}
        <span className="flex-1" />

        {current === null && canSubmit && workflow.availableTransitions.includes('SUBMITTED') && (
          <Button
            variant="default"
            onClick={() => {
              setSubmitting(true);
            }}
          >
            {translate('approvals.submit')}
          </Button>
        )}
        {canWithdraw && (
          <Button
            variant="outline"
            onClick={() => {
              setWithdrawing(true);
            }}
          >
            {translate('approvals.withdraw')}
          </Button>
        )}
        {current !== null && canManage && (
          <Button
            variant="outline"
            onClick={() => {
              const run =
                current.status === 'PAUSED'
                  ? resumeApproval(current.id)
                  : pauseApproval(current.id, { reason: WorkflowPauseReason.ADMINISTRATIVE });
              void run.then((result) => {
                if (result.ok) {
                  refresh();
                  return;
                }
                toast.error(result.detail ?? translate(`error.${result.code}`));
              });
            }}
          >
            {translate(current.status === 'PAUSED' ? 'approvals.resume' : 'approvals.paused')}
          </Button>
        )}
      </header>

      {current === null && workflow.history.length === 0 && (
        <Card>
          <EmptyState
            title={translate('approvals.notSubmitted')}
            description={translate('approvals.submitHint')}
          />
        </Card>
      )}

      {current !== null && current.pauseReason !== null && (
        <Alert tone="warning">
          {translate('approvals.pausedReason', {
            reason:
              pauseLabelKey(current.pauseReason) === null
                ? current.pauseReason
                : translate(pauseLabelKey(current.pauseReason)!),
          })}
        </Alert>
      )}

      {current !== null && current.status === 'COMPLETED' && !current.numberAssigned && (
        // Stated rather than left as a blank field. Since Phase 5 this is the workflow's own
        // choice — a definition whose completion does not assign a number — not a product gap.
        <Alert tone="info">{translate('approvals.numberPending')}</Alert>
      )}

      {current !== null && (
        <InstanceTimeline
          instance={current}
          currentUserId={currentUserId}
          canDecide={canApprove}
          canReject={canReject}
          onDecide={(taskId, decision) => {
            setDeciding({ taskId, decision });
          }}
        />
      )}

      {current !== null && (
        <div>
          <Button
            variant="ghost"
            onClick={() => {
              setCommenting(true);
            }}
          >
            {translate('approvals.addComment')}
          </Button>
        </div>
      )}

      {workflow.history.length > 0 && (
        <details className="flex flex-col gap-3">
          <summary className="cursor-pointer text-sm font-medium">
            {translate('approvals.history')}
          </summary>
          <div className="mt-3 flex flex-col gap-4">
            {workflow.history.map((instance) => (
              <InstanceTimeline
                key={instance.id}
                instance={instance}
                currentUserId={currentUserId}
                canDecide={false}
                canReject={false}
                onDecide={() => {}}
              />
            ))}
          </div>
        </details>
      )}

      <FormDialog
        open={submitting}
        title={translate('approvals.submit')}
        description={translate('approvals.submitHint')}
        submitLabel={translate('approvals.submit')}
        onClose={() => {
          setSubmitting(false);
        }}
        onSaved={refresh}
        onSubmit={(form) =>
          submitForApproval(workflow.documentId, {
            ...(optionalText(form, 'comment') !== undefined && {
              comment: optionalText(form, 'comment'),
            }),
          })
        }
      >
        <TextAreaField
          name="comment"
          label={translate('approvals.comment')}
          hint={translate('approvals.submitComment')}
          rows={3}
        />
      </FormDialog>

      <FormDialog
        open={withdrawing}
        title={translate('approvals.withdraw')}
        description={translate('approvals.withdrawHint')}
        submitLabel={translate('approvals.withdraw')}
        onClose={() => {
          setWithdrawing(false);
        }}
        onSaved={refresh}
        onSubmit={(form) =>
          withdrawSubmission(workflow.documentId, {
            ...(optionalText(form, 'reason') !== undefined && {
              reason: optionalText(form, 'reason'),
            }),
          })
        }
      >
        <TextAreaField name="reason" label={translate('approvals.withdrawReason')} rows={3} />
      </FormDialog>

      <FormDialog
        open={commenting}
        title={translate('approvals.addComment')}
        submitLabel={translate('approvals.addComment')}
        onClose={() => {
          setCommenting(false);
        }}
        onSaved={refresh}
        onSubmit={(form) => addComment(current?.id ?? '', { body: text(form, 'body') })}
      >
        <TextAreaField name="body" label={translate('approvals.comment')} required rows={4} />
      </FormDialog>

      <DecisionDialog
        taskId={deciding?.taskId ?? ''}
        decision={deciding?.decision ?? null}
        onClose={() => {
          setDeciding(null);
        }}
        onDecided={() => {
          setDeciding(null);
          refresh();
        }}
      />
    </section>
  );
}

/**
 * One approval attempt, forwards.
 *
 * A skipped stage is shown rather than hidden, with its reason. "This control did not apply to this
 * document" is a fact an auditor wants and a reader is entitled to; a stage that silently vanished
 * would make the route look like a different route.
 */
function InstanceTimeline({
  instance,
  currentUserId,
  canDecide,
  canReject,
  onDecide,
}: {
  readonly instance: WorkflowInstance;
  readonly currentUserId: string | null;
  readonly canDecide: boolean;
  readonly canReject: boolean;
  readonly onDecide: (taskId: string, decision: TaskDecisionKey) => void;
}): ReactNode {
  const translate = useTranslate();

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-3 text-sm opacity-70">
        {/* The *version*, not the definition. "Which rules was this approved under" is the question
            this whole product exists to answer, and it is answered here rather than by a join. */}
        <span>
          {translate('approvals.version', {
            name: instance.definitionName,
            number: instance.workflowVersion,
          })}
        </span>
        <span>
          {translate('approvals.startedBy', {
            date: new Date(instance.startedAt).toLocaleString(),
          })}
        </span>
        {instance.endedAt !== null && (
          <span>
            {translate('approvals.endedAt', {
              date: new Date(instance.endedAt).toLocaleString(),
            })}
          </span>
        )}
        <Badge tone="muted">{instance.revisionLabel}</Badge>
      </div>

      <ol className="flex flex-col gap-3">
        {instance.stages.map((stage) => (
          <li key={stage.id} className="border-s-2 ps-3">
            <StageRow
              stage={stage}
              currentUserId={currentUserId}
              canDecide={canDecide}
              canReject={canReject}
              onDecide={onDecide}
            />
          </li>
        ))}
      </ol>

      {instance.comments.length > 0 && (
        <ul className="flex flex-col gap-2 text-sm">
          {instance.comments.map((comment) => (
            <li key={comment.id} className="flex flex-col">
              <span className="opacity-70">
                {translate('approvals.decidedBy', {
                  name: comment.authorName ?? '',
                  date: new Date(comment.createdAt).toLocaleString(),
                })}
              </span>
              <span>{comment.body}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function StageRow({
  stage,
  currentUserId,
  canDecide,
  canReject,
  onDecide,
}: {
  readonly stage: WorkflowStageSummary;
  readonly currentUserId: string | null;
  readonly canDecide: boolean;
  readonly canReject: boolean;
  readonly onDecide: (taskId: string, decision: TaskDecisionKey) => void;
}): ReactNode {
  const translate = useTranslate();

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{stage.name}</span>
        <Badge tone={toneForStage(stage.status)}>
          {translate(`approvals.stageStatus${stage.status}`)}
        </Badge>
        {stage.tasks.length > 0 && (
          // Computed by the API with the same function the engine completes the stage with, so
          // "2 of 3" on this screen and the rule that ends the stage cannot disagree about what a
          // percentage rounds to.
          <span className="text-sm opacity-70">
            {translate('approvals.approvalsOf', {
              given: stage.approvalsGiven,
              required: stage.approvalsRequired,
            })}
          </span>
        )}
        {stage.dueAt !== null && (
          <span className="text-sm opacity-70">
            {translate('approvals.due', { date: new Date(stage.dueAt).toLocaleDateString() })}
          </span>
        )}
      </div>

      <ul className="flex flex-col gap-1 text-sm">
        {stage.tasks.map((task) => (
          <li key={task.id} className="flex flex-wrap items-center gap-2">
            <span>{task.assigneeName ?? task.assigneeId}</span>
            <Badge tone={toneForTask(task)}>
              {task.decision === null
                ? translate(`approvals.taskState${task.state}`)
                : translate(`approvals.decision${task.decision}`)}
            </Badge>
            {task.decidedAt !== null && (
              <span className="opacity-70">
                {translate('approvals.decidedBy', {
                  name: task.decidedByName ?? '',
                  date: new Date(task.decidedAt).toLocaleString(),
                })}
              </span>
            )}
            {/* Both identities, whenever the person who decided is not the person the task belongs
                to. Delegation is a later phase and the audit already answers "for whom", so the
                screen reads it rather than waiting for it. */}
            {task.onBehalfOfId !== null && (
              <span className="opacity-70">
                {translate('approvals.onBehalfOf', { name: task.onBehalfOfId })}
              </span>
            )}
            {task.autoDecided && <Badge tone="warning">{translate('approvals.autoDecided')}</Badge>}
            {task.comment !== null && <span className="opacity-80">{task.comment}</span>}

            {canDecide && task.assigneeId === currentUserId && task.decision === null && (
              <span className="flex gap-2">
                {task.actionable ? (
                  <>
                    <Button
                      variant="default"
                      onClick={() => {
                        onDecide(task.id, TaskDecision.APPROVED);
                      }}
                    >
                      {translate('approvals.approve')}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        onDecide(task.id, TaskDecision.CHANGES_REQUESTED);
                      }}
                    >
                      {translate('approvals.requestChanges')}
                    </Button>
                    {canReject && (
                      <Button
                        variant="outline"
                        onClick={() => {
                          onDecide(task.id, TaskDecision.REJECTED);
                        }}
                      >
                        {translate('approvals.reject')}
                      </Button>
                    )}
                  </>
                ) : (
                  <span className="opacity-70">{translate('approvals.notYourTurn')}</span>
                )}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The catalogue key for a hold's reason, or null.
 *
 * Narrowed against a table rather than interpolated into a key, because the column is a string on
 * the wire: an unrecognised value would render a key at somebody. Null falls back to the raw value,
 * which is still readable — and is what a reason written by a newer release looks like here.
 */
function pauseLabelKey(reason: string): MessageKey | null {
  const known: Readonly<Record<string, MessageKey>> = {
    LEGAL_HOLD: 'approvals.pauseLEGAL_HOLD',
    TENANT_SUSPENDED: 'approvals.pauseTENANT_SUSPENDED',
    ADMINISTRATIVE: 'approvals.pauseADMINISTRATIVE',
  };
  return known[reason] ?? null;
}

function toneForStage(status: WorkflowStageSummary['status']): 'success' | 'warning' | 'muted' {
  if (status === 'COMPLETED') {
    return 'success';
  }
  return status === 'ACTIVE' ? 'warning' : 'muted';
}

function toneForTask(task: ApprovalTask): 'success' | 'danger' | 'muted' {
  if (task.decision === TaskDecision.APPROVED) {
    return 'success';
  }
  return task.decision === null ? 'muted' : 'danger';
}
