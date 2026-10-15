'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { type ReactNode, useEffect, useState } from 'react';

import { Overline, Skeleton, buttonVariants, formatFileSize } from '@munaxa/ui';

import type { AuditEntry, DocumentSummary, DocumentWorkflow } from '@edms/contracts';
import { TaskDecision, WorkflowStageStatus, formatFor } from '@edms/domain';

import { useSession, useTranslate } from '../../app/providers';
import { loadDocumentGlance } from './actions';
import { DocumentStatusBadge } from './status-badge';

type Glance = Awaited<ReturnType<typeof loadDocumentGlance>>;
type Stage = NonNullable<DocumentWorkflow['current']>['stages'][number];

/**
 * The library's docked detail panel — Docs v2.
 *
 * Clicking a row used to open the record. The approved design keeps the reader in the list and
 * shows the clicked document beside it: where it is in approval, what it is, and what last happened
 * to it, with the record one button away. Double-click and Enter on a row still open the record,
 * so nothing that worked before stopped working.
 *
 * **What it reads, and what it deliberately does not.** The record's own fields come from the list
 * row the reader clicked — no request at all. The approval record and the latest activity come from
 * `loadDocumentGlance`, which does **not** call `GET /documents/:id`: that read records the view
 * (recents, and audit-on-read where confidentiality demands it), and glancing down a column is not
 * opening a dozen documents. See the action for the full reasoning.
 *
 * A late answer for a row the reader has already moved past is discarded rather than painted over
 * the row they are now looking at.
 */
export function DocumentGlance({
  row,
  ownerName,
}: {
  readonly row: DocumentSummary | null;
  /** Resolved from the directory when the reader may read it; `null` shows nothing rather than an id. */
  readonly ownerName: string | null;
}): ReactNode {
  const translate = useTranslate();
  const { locale } = useSession();
  const [loaded, setLoaded] = useState<{ readonly id: string; readonly glance: Glance } | null>(
    null,
  );

  const id = row?.id ?? null;
  useEffect(() => {
    if (id === null) {
      return;
    }
    let current = true;
    void loadDocumentGlance(id).then((glance) => {
      if (current) {
        setLoaded({ id, glance });
      }
    });
    return () => {
      current = false;
    };
  }, [id]);

  const date = (value: string): string =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(
      new Date(value),
    );

  if (row === null) {
    return (
      <aside
        aria-label={translate('documents.glance.label')}
        className="border-border bg-card text-muted-foreground rounded-xl border px-4 py-8 text-center text-sm"
      >
        {translate('documents.glance.empty')}
      </aside>
    );
  }

  const glance = loaded?.id === row.id ? loaded.glance : null;
  const instance = glance?.workflow?.current ?? glance?.workflow?.history[0] ?? null;
  const format = row.file === null ? null : formatFor(row.file.mimeType);

  const details: readonly (readonly [string, string | null])[] = [
    [translate('documents.glance.field.type'), row.documentTypeName],
    [translate('documents.glance.field.owner'), ownerName],
    [translate('documents.glance.field.confidentiality'), row.confidentialityName],
    [translate('documents.glance.field.category'), row.categoryName],
    [translate('documents.glance.field.folder'), row.folderName],
    [
      translate('documents.glance.field.file'),
      row.file === null
        ? null
        : `${format?.family ?? translate('documents.column.unknownFormat')} · ${formatFileSize(row.file.sizeBytes)}`,
    ],
    [translate('documents.glance.field.updated'), date(row.updatedAt)],
  ];

  return (
    <aside
      aria-label={translate('documents.glance.label')}
      // Sticky, so the panel stays beside the rows as a long folder scrolls under it.
      className="border-border bg-card flex flex-col overflow-hidden rounded-xl border lg:sticky lg:top-4"
    >
      <div className="border-border flex flex-col gap-2.5 border-b p-4">
        <span className="text-primary-strong font-mono text-xs">
          {row.documentNumber ?? translate('documents.number.none')}
        </span>
        <h2 className="text-[15px] leading-snug font-semibold">{row.title}</h2>
        <div className="flex flex-wrap items-center gap-2">
          <DocumentStatusBadge status={row.status} />
          {instance !== null && (
            <span className="text-muted-foreground text-xs">
              {translate('documents.glance.revision', { revision: instance.revisionLabel })}
            </span>
          )}
        </div>
      </div>

      <section className="border-border flex flex-col gap-2.5 border-b px-4 py-3.5">
        <Overline as="h3">{translate('documents.glance.progress')}</Overline>
        {glance === null ? (
          <Skeleton className="h-16 w-full" />
        ) : glance.workflow === null ? (
          <p className="text-muted-foreground text-sm">
            {translate('documents.glance.unavailable')}
          </p>
        ) : instance === null ? (
          <p className="text-muted-foreground text-sm">
            {translate(
              glance.workflow.requiresApproval
                ? 'documents.glance.notSubmitted'
                : 'documents.glance.noApproval',
            )}
          </p>
        ) : (
          <ol className="flex flex-col gap-2.5">
            {instance.stages.map((stage) => (
              <StageRow key={stage.id} stage={stage} date={date} />
            ))}
          </ol>
        )}
      </section>

      <section className="border-border border-b px-4 py-3.5">
        <Overline as="h3" className="mb-2.5 block">
          {translate('documents.glance.details')}
        </Overline>
        <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3.5 gap-y-2">
          {details
            .filter((entry): entry is readonly [string, string] => entry[1] !== null)
            .map(([term, value]) => (
              <div key={term} className="contents">
                <dt className="text-muted-foreground text-xs whitespace-nowrap">{term}</dt>
                <dd className="text-end text-[13px] break-words">{value}</dd>
              </div>
            ))}
        </dl>
      </section>

      {/* Absent rather than empty when the reader cannot read the history: "no activity" would be a
          claim about the document, when the truth is a claim about the reader's access. */}
      {glance?.activity === null ? null : (
        <section className="flex flex-col gap-2.5 px-4 py-3.5">
          <Overline as="h3">{translate('documents.glance.activity')}</Overline>
          {glance === null ? (
            <Skeleton className="h-12 w-full" />
          ) : glance.activity.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {translate('documents.glance.noActivity')}
            </p>
          ) : (
            <ul className="flex flex-col gap-2.5">
              {glance.activity.map((entry) => (
                <ActivityRow key={entry.id} entry={entry} date={date} />
              ))}
            </ul>
          )}
        </section>
      )}

      <div className="border-border bg-muted/40 mt-auto flex gap-2 border-t px-4 py-3">
        {/* A link, because opening the record is navigation — and because it is the one action here
            that records the view, which is exactly when that should happen. */}
        <Link
          href={`/documents/${row.id}` as Route}
          className={buttonVariants('default', 'sm', 'flex-1')}
        >
          {translate('documents.glance.open')}
        </Link>
      </div>
    </aside>
  );
}

/**
 * One approval stage: a marked circle and a line saying where it stands.
 *
 * The mark is a glyph as well as a colour — a tick, a dot, a cross — because four states told apart
 * by tint alone are one state to a reader who cannot see the tint.
 */
function StageRow({
  stage,
  date,
}: {
  readonly stage: Stage;
  readonly date: (value: string) => string;
}): ReactNode {
  const translate = useTranslate();

  const refusal = stage.tasks.find(
    (task) =>
      task.decision === TaskDecision.REJECTED || task.decision === TaskDecision.CHANGES_REQUESTED,
  );
  const approver = [...stage.tasks]
    .reverse()
    .find((task) => task.decision === TaskDecision.APPROVED && task.decidedByName !== null);

  const state: 'done' | 'current' | 'refused' | 'todo' =
    refusal !== undefined
      ? 'refused'
      : stage.status === WorkflowStageStatus.COMPLETED
        ? 'done'
        : stage.status === WorkflowStageStatus.ACTIVE
          ? 'current'
          : 'todo';

  const detail =
    refusal !== undefined
      ? translate(
          refusal.decision === TaskDecision.REJECTED
            ? 'documents.glance.stageRejectedBy'
            : 'documents.glance.stageChangesBy',
          { name: refusal.decidedByName ?? refusal.assigneeName ?? '—' },
        )
      : stage.status === WorkflowStageStatus.COMPLETED
        ? approver !== undefined && stage.completedAt !== null
          ? translate('documents.glance.stageApprovedBy', {
              name: approver.decidedByName ?? '—',
              date: date(stage.completedAt),
            })
          : stage.completedAt !== null
            ? translate('documents.glance.stageDone', { date: date(stage.completedAt) })
            : translate('documents.glance.stageDone', { date: '—' })
        : stage.status === WorkflowStageStatus.ACTIVE
          ? stage.dueAt !== null
            ? translate('documents.glance.stageWaitingDue', { date: date(stage.dueAt) })
            : translate('documents.glance.stageWaiting')
          : stage.status === WorkflowStageStatus.SKIPPED
            ? translate('documents.glance.stageSkipped')
            : stage.status === WorkflowStageStatus.CANCELLED
              ? translate('documents.glance.stageCancelled')
              : translate('documents.glance.stagePending');

  const mark = {
    done: { glyph: '✓', className: 'border-primary bg-primary text-primary-foreground' },
    current: { glyph: '•', className: 'border-warning-strong bg-warning/15 text-warning-strong' },
    refused: {
      glyph: '×',
      className: 'border-destructive-strong bg-destructive/15 text-destructive-strong',
    },
    todo: { glyph: '', className: 'border-border bg-card text-muted-foreground' },
  }[state];

  return (
    <li className="flex items-start gap-2.5">
      <span
        aria-hidden
        className={`flex size-[18px] shrink-0 items-center justify-center rounded-full border text-[10px] font-bold ${mark.className}`}
      >
        {mark.glyph}
      </span>
      <span className="flex min-w-0 flex-col gap-px">
        <span className="text-[13px] font-medium">{stage.name}</span>
        <span className="text-muted-foreground text-xs">{detail}</span>
      </span>
    </li>
  );
}

/**
 * One event. The action code verbatim, in mono, for the reason the record page's timeline gives:
 * it is the audit catalogue's own vocabulary, and the name an auditor matches an export against.
 */
function ActivityRow({
  entry,
  date,
}: {
  readonly entry: AuditEntry;
  readonly date: (value: string) => string;
}): ReactNode {
  return (
    <li className="flex gap-2.5">
      <span aria-hidden className="bg-primary-200 mt-1.5 size-1.5 shrink-0 rounded-full" />
      <span className="flex min-w-0 flex-col gap-px">
        <span className="font-mono text-xs break-all">{entry.action}</span>
        <span className="text-muted-foreground text-[11px]">{date(entry.occurredAt)}</span>
      </span>
    </li>
  );
}
