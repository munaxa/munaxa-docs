'use client';

import { useRouter } from 'next/navigation';
import { type ReactNode, useState } from 'react';

import { Alert, Badge, Button, Card, Dropzone, Progress, useToast } from '@munaxa/ui';

import type {
  Document,
  RevisionCompare,
  RevisionHistory,
  RevisionHistoryEntry,
} from '@edms/contracts';
import { SUPPORTED_EXTENSIONS } from '@edms/domain';

import { useSession, useTranslate } from '../../app/providers';
import type { ActionResult } from '../../lib/admin/action-result';
import {
  FormDialog,
  SwitchField,
  TextAreaField,
  TextField,
  flag,
  optionalText,
  text,
} from '../admin-shared';
import {
  type StoredFile,
  type UploadProgress,
  localRejectionFor,
  uploadFile,
} from '../documents/upload';
import {
  cancelCheckOut,
  checkInDocument,
  checkOutDocument,
  compareRevisions,
  forceCheckIn,
  publishDocument,
  requestRevisionDownload,
  restoreRevision,
} from './actions';

/**
 * Revision control on the document screen: who holds the pen, the timeline, and the compare.
 *
 * The action buttons are gated on the server's own facts — the document's status, the live
 * lock, `availableTransitions` — never on a status list this file invents: §5 of
 * `06-document-lifecycle.md` says the UI renders exactly what the API offers, and a button the
 * API would refuse is a button that teaches people the product is broken.
 *
 * The timeline is the document's revision history, newest first, discarded drafts included and
 * labelled — history with unexplained gaps is the opposite of evidence. The compare summarises
 * what the compare API can answer today (content by checksum, metadata by published snapshot)
 * and says plainly that text comparison arrives with the preview pipeline.
 */
export function RevisionPanel({
  document,
  history,
  availableTransitions,
  canCheckout,
  canCheckin,
  canForce,
  canPublish,
  canDownload,
}: {
  readonly document: Document;
  /** Null when the caller lacks `document:history:view`; the panel then omits the timeline. */
  readonly history: RevisionHistory | null;
  readonly availableTransitions: readonly string[];
  readonly canCheckout: boolean;
  readonly canCheckin: boolean;
  readonly canForce: boolean;
  readonly canPublish: boolean;
  readonly canDownload: boolean;
}): ReactNode {
  const translate = useTranslate();
  const router = useRouter();
  const toast = useToast();
  const session = useSession();
  const [checkingIn, setCheckingIn] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [forcing, setForcing] = useState(false);
  const [restoring, setRestoring] = useState<RevisionHistoryEntry | null>(null);

  const lock = document.liveLock;
  const holdsLock = lock !== null && lock.lockedBy === session.userId;
  const lockExpired = lock !== null && new Date(lock.expiresAt).getTime() < Date.now();

  const refresh = (): void => {
    router.refresh();
  };

  const run = (work: Promise<ActionResult<unknown>>): void => {
    void work.then((result) => {
      if (result.ok) {
        refresh();
      } else {
        toast.error(result.detail ?? translate(`error.${result.code}`));
      }
    });
  };

  const offerCheckOut =
    canCheckout &&
    (availableTransitions.includes('CHECKED_OUT') || (lock !== null && lockExpired && !holdsLock));
  const offerCheckIn = canCheckin && holdsLock;
  const offerCancel = canCheckout && holdsLock;
  const offerForce = canForce && lock !== null && !holdsLock;
  const offerPublish =
    canPublish && document.status === 'APPROVED' && availableTransitions.includes('PUBLISHED');

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-medium">{translate('revisions.title')}</h2>
        <div className="flex flex-wrap gap-2">
          {offerCheckOut && (
            <Button type="button" onClick={() => run(checkOutDocument(document.id))}>
              {translate('revisions.actions.checkOut')}
            </Button>
          )}
          {offerCheckIn && (
            <Button type="button" onClick={() => setCheckingIn(true)}>
              {translate('revisions.actions.checkIn')}
            </Button>
          )}
          {offerCancel && (
            <Button
              type="button"
              variant="outline"
              onClick={() => run(cancelCheckOut(document.id))}
            >
              {translate('revisions.actions.cancelCheckOut')}
            </Button>
          )}
          {offerForce && (
            <Button type="button" variant="destructive" onClick={() => setForcing(true)}>
              {translate('revisions.actions.forceCheckIn')}
            </Button>
          )}
          {offerPublish && (
            <Button type="button" onClick={() => setPublishing(true)}>
              {translate('revisions.actions.publish')}
            </Button>
          )}
        </div>
      </div>

      {lock !== null && (
        <Alert tone={holdsLock ? 'info' : 'warning'} className="mt-3">
          {translate(
            holdsLock
              ? 'revisions.lock.heldByYou'
              : lockExpired
                ? 'revisions.lock.expired'
                : 'revisions.lock.heldByOther',
            {
              name: lock.lockedByName ?? lock.lockedBy,
              until: new Date(lock.expiresAt).toLocaleString(),
            },
          )}
        </Alert>
      )}

      {history !== null && (
        <RevisionTimeline
          document={document}
          history={history}
          canDownload={canDownload}
          canRestore={canCheckout && document.status === 'PUBLISHED'}
          onRestore={(entry) => setRestoring(entry)}
        />
      )}

      {history !== null && history.revisions.length > 1 && (
        <CompareSection document={document} history={history} />
      )}

      {checkingIn && (
        <CheckInDialog
          document={document}
          onClose={() => setCheckingIn(false)}
          onSaved={() => {
            setCheckingIn(false);
            refresh();
          }}
        />
      )}

      {publishing && (
        <FormDialog
          open
          title={translate('revisions.actions.publish')}
          description={translate('revisions.publish.description')}
          submitLabel={translate('revisions.actions.publish')}
          onClose={() => setPublishing(false)}
          onSubmit={(data) =>
            publishDocument(document.id, {
              ...(optionalText(data, 'effectiveFrom') !== undefined && {
                effectiveFrom: text(data, 'effectiveFrom'),
              }),
              ...(optionalText(data, 'effectiveTo') !== undefined && {
                effectiveTo: text(data, 'effectiveTo'),
              }),
            })
          }
          onSaved={refresh}
        >
          <TextField
            name="effectiveFrom"
            type="date"
            label={translate('revisions.publish.effectiveFrom')}
            hint={translate('revisions.publish.effectiveFromHint')}
          />
          <TextField
            name="effectiveTo"
            type="date"
            label={translate('revisions.publish.effectiveTo')}
          />
        </FormDialog>
      )}

      {forcing && (
        <FormDialog
          open
          title={translate('revisions.actions.forceCheckIn')}
          description={translate('revisions.force.description', {
            name: lock?.lockedByName ?? lock?.lockedBy ?? '',
          })}
          submitLabel={translate('revisions.actions.forceCheckIn')}
          onClose={() => setForcing(false)}
          onSubmit={(data) =>
            forceCheckIn(document.id, {
              note: text(data, 'note'),
              discardDraft: flag(data, 'discardDraft'),
            })
          }
          onSaved={refresh}
        >
          <TextAreaField name="note" label={translate('revisions.force.note')} required />
          <SwitchField
            name="discardDraft"
            label={translate('revisions.force.discardDraft')}
            hint={translate('revisions.force.discardDraftHint')}
          />
        </FormDialog>
      )}

      {restoring !== null && (
        <FormDialog
          open
          title={translate('revisions.actions.restore')}
          description={translate('revisions.restore.description', { label: restoring.label })}
          submitLabel={translate('revisions.actions.restore')}
          onClose={() => setRestoring(null)}
          onSubmit={(data) =>
            restoreRevision(document.id, restoring.id, {
              ...(optionalText(data, 'changeNote') !== undefined && {
                changeNote: text(data, 'changeNote'),
              }),
            })
          }
          onSaved={() => {
            setRestoring(null);
            refresh();
          }}
        >
          <TextAreaField name="changeNote" label={translate('revisions.restore.changeNote')} />
        </FormDialog>
      )}
    </Card>
  );
}

function RevisionTimeline({
  document,
  history,
  canDownload,
  canRestore,
  onRestore,
}: {
  readonly document: Document;
  readonly history: RevisionHistory;
  readonly canDownload: boolean;
  readonly canRestore: boolean;
  readonly onRestore: (entry: RevisionHistoryEntry) => void;
}): ReactNode {
  const translate = useTranslate();
  const toast = useToast();

  const download = (entry: RevisionHistoryEntry): void => {
    void requestRevisionDownload(document.id, entry.id).then((result) => {
      if (!result.ok) {
        toast.error(result.detail ?? translate(`error.${result.code}`));
        return;
      }
      window.location.assign(result.value.url);
    });
  };

  // Newest first: the question the timeline answers most often is "what changed lately".
  const entries = [...history.revisions].reverse();

  return (
    <ol className="mt-4 flex flex-col gap-3">
      {entries.map((entry) => (
        <li key={entry.id} className="border-s-2 ps-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{entry.label}</span>
            <Badge tone={toneFor(entry.status)}>
              {translate(`revisions.status.${entry.status}`)}
            </Badge>
            {entry.restoredFromLabel !== null && (
              <Badge tone="muted">
                {translate('revisions.restoredFrom', { label: entry.restoredFromLabel })}
              </Badge>
            )}
          </div>
          {entry.changeNote !== null && <p className="mt-1 text-sm">{entry.changeNote}</p>}
          <p className="mt-1 text-sm opacity-70">
            {translate('revisions.createdLine', {
              name: entry.createdByName ?? '—',
              date: new Date(entry.createdAt).toLocaleString(),
            })}
            {entry.publishedAt !== null &&
              ` · ${translate('revisions.publishedLine', {
                date: new Date(entry.publishedAt).toLocaleDateString(),
              })}`}
            {entry.effectiveFrom !== null &&
              ` · ${translate('revisions.effectiveLine', {
                from: entry.effectiveFrom,
                to: entry.effectiveTo ?? '—',
              })}`}
          </p>
          <div className="mt-1 flex flex-wrap gap-2">
            {canDownload && entry.file.reachable && (
              <Button type="button" variant="ghost" onClick={() => download(entry)}>
                {translate('documents.actions.download')}
              </Button>
            )}
            {canRestore && entry.status !== 'PUBLISHED' && (
              <Button type="button" variant="ghost" onClick={() => onRestore(entry)}>
                {translate('revisions.actions.restore')}
              </Button>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

/**
 * The compare, as far as the API can honestly answer it today: content by checksum, metadata by
 * published snapshot, and a plain sentence that text comparison arrives with Phase 7's
 * artefacts rather than a spinner that never resolves.
 */
function CompareSection({
  document,
  history,
}: {
  readonly document: Document;
  readonly history: RevisionHistory;
}): ReactNode {
  const translate = useTranslate();
  const toast = useToast();
  const ordinals = history.revisions.map((entry) => entry.ordinal);
  const [from, setFrom] = useState(String(ordinals[0] ?? 0));
  const [to, setTo] = useState(String(ordinals[ordinals.length - 1] ?? 0));
  const [result, setResult] = useState<RevisionCompare | null>(null);

  const choices = history.revisions.map((entry) => ({
    value: String(entry.ordinal),
    label: entry.label,
  }));

  const compare = (): void => {
    compareRevisions(document.id, Number(from), Number(to))
      .then(setResult)
      .catch(() => {
        toast.error(translate('revisions.compare.failed'));
      });
  };

  return (
    <div className="mt-6 border-t pt-4">
      <h3 className="text-sm font-medium opacity-70">{translate('revisions.compare.title')}</h3>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-sm">
          {translate('revisions.compare.from')}
          <select
            className="mt-1 rounded border bg-transparent p-1"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          >
            {choices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-sm">
          {translate('revisions.compare.to')}
          <select
            className="mt-1 rounded border bg-transparent p-1"
            value={to}
            onChange={(event) => setTo(event.target.value)}
          >
            {choices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
        <Button type="button" variant="outline" onClick={compare}>
          {translate('revisions.compare.run')}
        </Button>
      </div>

      {result !== null && (
        <div className="mt-3 flex flex-col gap-2 text-sm">
          <p>
            {result.content.identical
              ? translate('revisions.compare.identical')
              : translate('revisions.compare.changed', {
                  delta: String(result.content.sizeDelta),
                })}
            {result.content.filenameChanged &&
              ` · ${translate('revisions.compare.filenameChanged')}`}
            {result.content.mimeChanged && ` · ${translate('revisions.compare.mimeChanged')}`}
          </p>
          {result.metadata.available ? (
            result.metadata.changes.length === 0 ? (
              <p className="opacity-70">{translate('revisions.compare.metadataUnchanged')}</p>
            ) : (
              <ul className="list-inside list-disc">
                {result.metadata.changes.map((change) => (
                  <li key={change.key}>
                    {change.name}: {change.from ?? '—'} → {change.to ?? '—'}
                  </li>
                ))}
              </ul>
            )
          ) : (
            <p className="opacity-70">{translate('revisions.compare.metadataUnavailable')}</p>
          )}
          <p className="opacity-70">{translate('revisions.compare.textUnavailable')}</p>
        </div>
      )}
    </div>
  );
}

/**
 * Check-in: one file through the same upload handshake as creation — the bytes go straight to
 * storage, the antivirus gate decides, and only a reference crosses the server action.
 */
function CheckInDialog({
  document,
  onClose,
  onSaved,
}: {
  readonly document: Document;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}): ReactNode {
  const translate = useTranslate();
  const [stored, setStored] = useState<StoredFile | null>(null);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const accept = (files: File[]): void => {
    const file = files[0];
    if (file === undefined) {
      return;
    }
    const rejection = localRejectionFor(file);
    if (rejection !== null) {
      setProblem(translate(`documents.upload.rejected.${rejection}`));
      return;
    }
    setProblem(null);
    setStored(null);
    void uploadFile(file, setProgress).then((outcome) => {
      if ('reason' in outcome) {
        setProblem(outcome.reason);
        setProgress(null);
      } else {
        setStored(outcome);
        setProgress(null);
      }
    });
  };

  const submit = async (data: FormData): Promise<ActionResult<unknown>> => {
    if (stored === null) {
      return Promise.resolve({
        ok: false,
        code: 'VALIDATION_FAILED',
        detail: translate('revisions.checkIn.fileMissing'),
      });
    }
    return checkInDocument(document.id, {
      fileObjectId: stored.fileObjectId,
      filename: stored.filename,
      changeNote: text(data, 'changeNote'),
      keepCheckedOut: flag(data, 'keepCheckedOut'),
    });
  };

  return (
    <FormDialog
      open
      title={translate('revisions.actions.checkIn')}
      description={translate('revisions.checkIn.description')}
      submitLabel={translate('revisions.actions.checkIn')}
      onClose={onClose}
      onSubmit={submit}
      onSaved={onSaved}
    >
      <Dropzone
        accept={SUPPORTED_EXTENSIONS.join(',')}
        onFiles={accept}
        labels={{
          prompt: translate('revisions.checkIn.prompt'),
          browse: translate('documents.upload.browse'),
        }}
      />
      {progress !== null && <Progress value={Math.round(progress.fraction * 100)} />}
      {problem !== null && <Alert tone="danger">{problem}</Alert>}
      {stored !== null && (
        <Alert
          tone={
            stored.scanStatus === 'CLEAN' || stored.scanStatus === 'PENDING' ? 'info' : 'warning'
          }
        >
          {translate('revisions.checkIn.stored', { name: stored.filename })}
        </Alert>
      )}
      <TextAreaField name="changeNote" label={translate('revisions.checkIn.changeNote')} required />
      <SwitchField
        name="keepCheckedOut"
        label={translate('revisions.checkIn.keepCheckedOut')}
        hint={translate('revisions.checkIn.keepCheckedOutHint')}
      />
    </FormDialog>
  );
}

function toneFor(
  status: RevisionHistoryEntry['status'],
): 'muted' | 'warning' | 'success' | 'danger' {
  switch (status) {
    case 'PUBLISHED':
      return 'success';
    case 'IN_APPROVAL':
      return 'warning';
    case 'SUPERSEDED':
      return 'muted';
    case 'DISCARDED':
      return 'danger';
    case 'DRAFT':
      return 'muted';
  }
}
