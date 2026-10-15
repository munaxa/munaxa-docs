'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useState } from 'react';

import { Badge, Button, Card, EmptyState } from '@munaxa/ui';

import type { ApprovalInboxItem } from '@edms/contracts';
import { ApprovalTaskState, TaskDecision, type TaskDecisionKey } from '@edms/domain';

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
      <div className="flex max-w-[960px] flex-col gap-4">
        <InboxSwitch decided={decided} />
        <EmptyState
          title={translate(decided ? 'approvals.emptyDecided' : 'approvals.empty')}
          description={translate('approvals.description')}
        />
      </div>
    );
  }

  return (
    <div className="flex max-w-[960px] flex-col gap-4">
      <InboxSwitch decided={decided} />
      <ul className="flex flex-col gap-3">
        {rows.map((row) => (
          <li key={row.id}>
            <Card className="flex flex-col gap-2.5 p-4">
              <div className="flex flex-wrap items-center gap-3">
                <Link
                  href={`/documents/${row.documentId}` as Route}
                  className="text-foreground min-w-[200px] flex-1 truncate text-[15px] font-semibold hover:underline"
                >
                  {row.documentTitle}
                </Link>
                {row.documentNumber !== null && (
                  <Badge tone="muted" className="font-mono tabular-nums">
                    {row.documentNumber}
                  </Badge>
                )}
                <Badge tone="muted">{row.documentTypeName}</Badge>
                {row.overdue && <Badge tone="danger">{translate('approvals.overdue')}</Badge>}
                {/*
                  Phase 11. This row is here because the caller holds a delegation, not because the
                  task is theirs — the task is still the delegator's, and `assigneeId` says so
                  beside this badge. `approvals.onBehalfOf` is the key Phase 4 wrote for exactly
                  this moment and left in both catalogues unused.

                  Rendered from the row rather than by comparing `assigneeId` to the signed-in
                  user, because that comparison is the one that would silently be wrong the day
                  somebody reads another person's inbox.
                */}
                {row.onBehalfOf !== null && (
                  <Badge tone="muted">
                    {translate('approvals.onBehalfOf', {
                      name: row.onBehalfOf.delegatorName ?? row.onBehalfOf.delegatorId,
                    })}
                  </Badge>
                )}
              </div>

              {/* The muted token rather than `opacity-70`: a fade of the foreground is a contrast
                  ratio nobody chose, and on the Docs v2 canvas it measured below the muted text it
                  was imitating. */}
              <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
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
                  <Badge
                    tone={
                      row.decision === TaskDecision.APPROVED
                        ? 'success'
                        : row.decision === TaskDecision.CHANGES_REQUESTED
                          ? 'warning'
                          : 'danger'
                    }
                  >
                    {translate(`approvals.decision${row.decision}`)}
                  </Badge>
                  {row.comment !== null && (
                    <span className="text-muted-foreground">{row.comment}</span>
                  )}
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
                        size="sm"
                        // Rejection is the one decision that ends the document's run, so its label
                        // carries the danger colour — on an outline button, because a red fill
                        // beside Approve would compete with the primary action.
                        className={
                          decision === TaskDecision.REJECTED ? 'text-destructive-strong' : undefined
                        }
                        onClick={() => {
                          setDeciding({ taskId: row.id, decision });
                        }}
                      >
                        {translate(`approvals.${verbFor(decision)}`)}
                      </Button>
                    ))
                  ) : (
                    <span className="text-muted-foreground text-sm">
                      {translate('approvals.notYourTurn')}
                    </span>
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
    </div>
  );
}

/**
 * Awaiting you · Decided — Docs v2's segmented switch.
 *
 * The inbox has answered both questions since Phase 4 (`?state=DECIDED`) and nothing on screen led
 * to the second one; the catalogue even carried both labels, unused. They are two URLs, so this is
 * two links marked with `aria-current` rather than a tab widget: a tab panel switches content in
 * place, and this navigates — back and forward work, and either view is a link somebody can send.
 */
function InboxSwitch({ decided }: { readonly decided: boolean }): ReactNode {
  const translate = useTranslate();
  const item =
    'focus-visible:ring-ring flex h-9 items-center rounded-md px-3.5 text-[13px] font-medium text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:outline-none aria-[current]:bg-card aria-[current]:text-foreground aria-[current]:shadow-xs';
  return (
    <nav
      aria-label={translate('approvals.title')}
      className="bg-secondary flex gap-1 self-start rounded-[10px] p-1"
    >
      <Link href="/approvals" aria-current={decided ? undefined : 'page'} className={item}>
        {translate('approvals.inbox')}
      </Link>
      <Link
        href={`/approvals?state=${ApprovalTaskState.DECIDED}` as Route}
        aria-current={decided ? 'page' : undefined}
        className={item}
      >
        {translate('approvals.decided')}
      </Link>
    </nav>
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
