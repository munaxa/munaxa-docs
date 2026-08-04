'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useState } from 'react';

import { Badge, Button, Card, EmptyState } from '@munaxa/ui';

import type { ApprovalInboxItem } from '@edms/contracts';
import { TaskDecision, type TaskDecisionKey } from '@edms/domain';

import { useTranslate } from '../../app/providers';
import { DecisionDialog } from './decision-dialog';

/**
 * What needs this person's decision.
 *
 * The dashboard task list `07-workflow-architecture.md` implies and the phase asks for. Ordered by
 * deadline with the undated last, which is the API's ordering rather than this screen's — "overdue"
 * is computed server-side so that two people in two timezones cannot disagree about it.
 *
 * A decision can be taken from here without opening the document, and that is deliberate for the
 * ordinary case: an approver who has already read the document and is working through a backlog
 * should not have to navigate to agree. The title is a link for the case where they have not.
 *
 * `actionable` is respected rather than recomputed. A later step of an ordered stage is a task this
 * person genuinely has, and it is shown — with its buttons disabled and the reason stated — because
 * hiding it would make "where is my task" unanswerable.
 */
export function ApprovalInboxScreen({
  rows,
  decided,
}: {
  readonly rows: readonly ApprovalInboxItem[];
  /** True when this list is the person's history rather than their queue. */
  readonly decided: boolean;
}): ReactNode {
  const translate = useTranslate();
  const router = useRouter();
  const [deciding, setDeciding] = useState<{ taskId: string; decision: TaskDecisionKey } | null>(
    null,
  );

  if (rows.length === 0) {
    return (
      <EmptyState
        title={translate(decided ? 'approvals.emptyDecided' : 'approvals.empty')}
        description={translate('approvals.description')}
      />
    );
  }

  return (
    <>
      <ul className="flex flex-col gap-2">
        {rows.map((row) => (
          <li key={row.id}>
            <Card className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-3">
                <Link
                  href={`/documents/${row.documentId}` as Route}
                  className="min-w-0 flex-1 truncate font-medium"
                >
                  {row.documentTitle}
                </Link>
                {row.documentNumber !== null && <Badge tone="muted">{row.documentNumber}</Badge>}
                <Badge tone="muted">{row.documentTypeName}</Badge>
                {row.overdue && <Badge tone="danger">{translate('approvals.overdue')}</Badge>}
              </div>

              <div className="flex flex-wrap items-center gap-3 text-sm opacity-70">
                <span>
                  {translate('approvals.stage')}: {row.stageName}
                </span>
                <span>
                  {row.dueAt === null
                    ? translate('approvals.noDeadline')
                    : translate('approvals.due', {
                        date: new Date(row.dueAt).toLocaleDateString(),
                      })}
                </span>
                {/* Why this person, and not somebody else. The engine records the resolver that
                    produced them, and it is the only answer to "why am I being asked". */}
                <span>{translate('approvals.resolvedBy', { reason: row.resolvedBy })}</span>
              </div>

              {row.decision !== null && (
                <div className="flex items-center gap-2 text-sm">
                  <Badge tone={row.decision === TaskDecision.APPROVED ? 'success' : 'danger'}>
                    {translate(`approvals.decision${row.decision}`)}
                  </Badge>
                  {row.comment !== null && <span className="opacity-80">{row.comment}</span>}
                </div>
              )}

              {!decided && row.decision === null && (
                <div className="flex flex-wrap items-center gap-2">
                  {row.actionable ? (
                    (
                      [
                        TaskDecision.APPROVED,
                        TaskDecision.CHANGES_REQUESTED,
                        TaskDecision.REJECTED,
                      ] as const
                    ).map((decision) => (
                      <Button
                        key={decision}
                        variant={decision === TaskDecision.APPROVED ? 'default' : 'outline'}
                        onClick={() => {
                          setDeciding({ taskId: row.id, decision });
                        }}
                      >
                        {translate(`approvals.${verbFor(decision)}`)}
                      </Button>
                    ))
                  ) : (
                    <span className="text-sm opacity-70">{translate('approvals.notYourTurn')}</span>
                  )}
                </div>
              )}
            </Card>
          </li>
        ))}
      </ul>

      <DecisionDialog
        taskId={deciding?.taskId ?? ''}
        decision={deciding?.decision ?? null}
        onClose={() => {
          setDeciding(null);
        }}
        onDecided={() => {
          setDeciding(null);
          // Refreshed rather than patched in place, so what the list shows always came from the
          // server — a decision can complete a stage, which changes rows this screen does not own.
          router.refresh();
        }}
      />
    </>
  );
}

function verbFor(decision: TaskDecisionKey): 'approve' | 'reject' | 'requestChanges' {
  switch (decision) {
    case TaskDecision.APPROVED:
      return 'approve';
    case TaskDecision.REJECTED:
      return 'reject';
    default:
      return 'requestChanges';
  }
}
