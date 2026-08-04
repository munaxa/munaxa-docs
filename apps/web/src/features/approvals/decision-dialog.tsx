'use client';

import type { ReactNode } from 'react';

import { TaskDecision, type TaskDecisionKey } from '@edms/domain';

import { useTranslate } from '../../app/providers';
import { FormDialog, TextAreaField, optionalText } from '../admin-shared';
import { decideTask } from './actions';

/**
 * Taking a decision on one task.
 *
 * A dialogue rather than three buttons that act on click, and the reason is the comment: a rejection
 * and a request for changes both *require* one, so a button that decided immediately would have to
 * fail and then ask — which is a refusal presented as a bug.
 *
 * The comment is required for the two decisions that send a document back and optional for
 * approval. That asymmetry is the API's, restated here rather than left to the server, because a
 * form that let somebody write nothing and then reported a refusal is a form that asked twice.
 */
export function DecisionDialog({
  taskId,
  decision,
  onClose,
  onDecided,
}: {
  readonly taskId: string;
  /** Null closes the dialogue. Which decision is being taken decides the title and the rules. */
  readonly decision: TaskDecisionKey | null;
  readonly onClose: () => void;
  readonly onDecided: () => void;
}): ReactNode {
  const translate = useTranslate();

  if (decision === null) {
    return null;
  }

  const needsComment = decision !== TaskDecision.APPROVED;

  return (
    <FormDialog
      open
      title={translate(labelFor(decision))}
      submitLabel={translate(labelFor(decision))}
      onClose={onClose}
      onSaved={onDecided}
      onSubmit={(form) =>
        decideTask(taskId, {
          decision,
          ...(optionalText(form, 'comment') !== undefined && {
            comment: optionalText(form, 'comment'),
          }),
        })
      }
    >
      <TextAreaField
        name="comment"
        label={translate('approvals.comment')}
        hint={translate(needsComment ? 'approvals.commentRequired' : 'approvals.commentOptional')}
        required={needsComment}
        rows={4}
      />
    </FormDialog>
  );
}

export function labelFor(
  decision: TaskDecisionKey,
): 'approvals.approve' | 'approvals.reject' | 'approvals.requestChanges' {
  switch (decision) {
    case TaskDecision.APPROVED:
      return 'approvals.approve';
    case TaskDecision.REJECTED:
      return 'approvals.reject';
    default:
      return 'approvals.requestChanges';
  }
}
