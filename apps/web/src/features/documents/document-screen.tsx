'use client';

import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import { type ReactNode, useState } from 'react';

import { Alert, Badge, Button, Card, formatFileSize, useToast } from '@munaxa/ui';

import type { Document, Folder } from '@edms/contracts';
import { formatFor } from '@edms/domain';

import { useTranslate } from '../../app/providers';
import type { ActionResult } from '../../lib/admin/action-result';
import {
  type Choice,
  FormDialog,
  PickerField,
  TextAreaField,
  TextField,
  nullableText,
  optionalText,
  text,
} from '../admin-shared';
import {
  archiveDocument,
  assignDocumentNumber,
  moveDocument,
  reinstateDocument,
  requestDownload,
  setFavorite,
  updateDocument,
} from './actions';
import { MetadataFields, type MetadataFieldDefinition, readMetadata } from './metadata-fields';

/**
 * One document: its properties, its business metadata, and what its content is.
 *
 * The screen is organised around the split the whole phase is built on. **Properties** are what the
 * document means — title, classification, category, the tenant's own fields — and they are edited
 * here. **File** is what the bytes are — format, size, digest, scan verdict — and it is shown and
 * never edited, because replacing content is creating a revision, which is Phase 6's.
 *
 * Presenting them as one form would suggest the digest is something somebody can change, and the
 * one property a controlled document must have is that its content cannot be edited in place.
 */
export function DocumentScreen({
  document,
  folders,
  categories,
  confidentialityLevels,
  users,
  departments,
  fields,
  canEdit,
  canMove,
  canDownload,
  canAssignNumber,
  canManagePermissions,
  canArchive,
  preview,
  approvals,
  revisions,
  signatures,
  audit,
}: {
  readonly document: Document;
  /** Candidate destinations for a move. Within the document's own library. */
  readonly folders: readonly Folder[];
  readonly categories: readonly Choice[];
  readonly confidentialityLevels: readonly Choice[];
  readonly users: readonly Choice[];
  readonly departments: readonly Choice[];
  /** The document type's fields, which decide what the properties form renders. */
  readonly fields: readonly MetadataFieldDefinition[];
  readonly canEdit: boolean;
  readonly canMove: boolean;
  readonly canDownload: boolean;
  /** `numbering:manage` — manual assignment is a document controller's act, not an edit. */
  readonly canAssignNumber?: boolean;
  /**
   * `document:permission:manage` — Phase 14's link to the permissions screen.
   *
   * A server-provided boolean like every other affordance on this screen, rather than a guess from
   * the status or from a role name: 08 §7's UI row says the server computes this and the client
   * renders from it. Hiding the link is a courtesy either way — the route re-checks, and so does
   * every endpoint behind it.
   */
  readonly canManagePermissions?: boolean;
  /**
   * `document:archive` — Phase 6.1, and the first affordance this permission has ever had.
   *
   * A server-computed boolean like every other on this screen. Hiding the button is a courtesy;
   * `POST /documents/{id}/archive` re-checks the permission and the ACL scope regardless
   * (`08-permission-model.md` §7).
   */
  readonly canArchive?: boolean;
  /**
   * The document's approval, rendered by Workflow's own feature and passed in.
   *
   * A slot rather than an import, so this screen keeps knowing nothing about approvals: the data it
   * would need is fetched on the server beside the document, and a screen that reached for it would
   * be a second place deciding what an approval looks like. Phase 4 added it and nothing else here
   * changed.
   */
  readonly approvals?: ReactNode;
  /**
   * Revision control — the timeline, check-out/check-in and publish — rendered by Revision's
   * own feature and passed in, for the same reason approvals are: this screen keeps knowing
   * nothing about how a revision moves.
   */
  readonly revisions?: ReactNode;
  /**
   * The viewer — Preview's own feature, passed in the way the other two are. Phase 7 added it
   * and, as with Phase 4 and Phase 6, nothing else this screen knows had to change.
   */
  readonly preview?: ReactNode;
  /**
   * Electronic signatures — Signature's own feature, passed in like the other four.
   *
   * A slot for the same reason approvals and revisions are slots: this screen knows nothing about
   * what a §11.50 attestation is, and a screen that reached for the signature list would be a
   * second place deciding what signing looks like. Phase 6.6 added it and nothing else here
   * changed except this line and the one that renders it.
   */
  readonly signatures?: ReactNode;
  /**
   * The document's own audit timeline — Audit's feature, passed in like the other three.
   *
   * A slot rather than a fetch, and a *suspended* one at the page: this screen renders it wherever
   * it arrives, and the trail being slow to read never holds up the record it is about
   * (`16-frontend-architecture.md` §7).
   */
  readonly audit?: ReactNode;
}): ReactNode {
  const translate = useTranslate();
  const router = useRouter();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [moving, setMoving] = useState(false);
  const [numbering, setNumbering] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [reinstating, setReinstating] = useState(false);

  // Manual assignment applies only to an unnumbered document that is not in approval — while it
  // is, the workflow owns numbering and the API refuses (09 §3).
  const offerAssignNumber =
    canAssignNumber === true &&
    document.documentNumber === null &&
    document.status !== 'SUBMITTED' &&
    document.status !== 'UNDER_REVIEW';

  // Archival is offered only from the states the lifecycle can leave — `IMPLEMENTED_TRANSITIONS`
  // allows `PUBLISHED`, `EXPIRED` and `SUPERSEDED`, and offering it on a draft would render a
  // button whose only outcome is a 409. Reinstatement is the mirror, from `ARCHIVED`.
  const offerArchive =
    canArchive === true &&
    (document.status === 'PUBLISHED' ||
      document.status === 'EXPIRED' ||
      document.status === 'SUPERSEDED');
  const offerReinstate = canArchive === true && document.status === 'ARCHIVED';

  // The effective revision is what a reader reads; the latest may be an unapproved draft
  // beneath it, and the two are told apart everywhere they render.
  const effectiveRevision = document.currentRevision ?? document.latestRevision;
  const draftRevision =
    document.currentRevision !== null &&
    document.latestRevision !== null &&
    document.latestRevision.id !== document.currentRevision.id
      ? document.latestRevision
      : null;
  const file = effectiveRevision?.file ?? null;
  const values = Object.fromEntries(document.metadata.map((entry) => [entry.key, entry.value]));

  const refresh = (): void => {
    router.refresh();
  };

  const download = (inline: boolean): void => {
    void requestDownload(document.id, inline).then((result) => {
      if (!result.ok) {
        toast.error(result.detail ?? translate(`error.${result.code}`));
        return;
      }
      window.location.assign(result.value.url);
    });
  };

  const saveProperties = async (data: FormData): Promise<ActionResult<unknown>> =>
    updateDocument(document.id, document.version, {
      title: text(data, 'title'),
      description: nullableText(data, 'description'),
      categoryId: nullableText(data, 'categoryId'),
      ...(optionalText(data, 'confidentialityId') !== undefined && {
        confidentialityId: text(data, 'confidentialityId'),
      }),
      metadata: readMetadata(data, fields),
    });

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm opacity-70">
            {document.libraryName} · {document.folderName}
          </p>
          <h1 className="truncate text-2xl font-semibold">{document.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge>{translate(`documents.status.${document.status}`)}</Badge>
            <Badge tone="muted">{document.documentTypeName}</Badge>
            <Badge tone="muted">{document.confidentialityName}</Badge>
            {document.origin === 'SCAN' && (
              <Badge tone="muted">{translate('documents.origin.SCAN')}</Badge>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void setFavorite(document.id, !document.isFavorite).then(refresh);
            }}
          >
            {translate(
              document.isFavorite ? 'documents.actions.unfavorite' : 'documents.actions.favorite',
            )}
          </Button>
          {canDownload && (
            <Button
              type="button"
              disabled={file === null || !file.reachable}
              onClick={() => {
                download(false);
              }}
            >
              {translate('documents.actions.download')}
            </Button>
          )}
          {canMove && (
            <Button type="button" variant="outline" onClick={() => setMoving(true)}>
              {translate('documents.actions.move')}
            </Button>
          )}
          {offerAssignNumber && (
            <Button type="button" variant="outline" onClick={() => setNumbering(true)}>
              {translate('documents.actions.assignNumber')}
            </Button>
          )}
          {canEdit && (
            <Button type="button" variant="outline" onClick={() => setEditing(true)}>
              {translate('documents.actions.edit')}
            </Button>
          )}
          {canManagePermissions === true && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                router.push(`/documents/${document.id}/permissions` as Route);
              }}
            >
              {translate('documents.actions.permissions')}
            </Button>
          )}
          {offerArchive && (
            <Button type="button" variant="outline" onClick={() => setArchiving(true)}>
              {translate('documents.actions.archive')}
            </Button>
          )}
          {offerReinstate && (
            <Button type="button" variant="outline" onClick={() => setReinstating(true)}>
              {translate('documents.actions.reinstate')}
            </Button>
          )}
        </div>
      </header>

      {file !== null && !file.reachable && (
        // The document exists and its content is deliberately unreachable. Saying which of the two
        // is the case is the difference between a system that looks broken and one that is careful.
        <Alert tone="warning">{translate(`documents.scan.${file.scanStatus}`)}</Alert>
      )}

      {preview}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <h2 className="text-lg font-medium">{translate('documents.section.properties')}</h2>
          <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
            {document.documentNumber === null && document.pendingNumber !== null ? (
              // The reserved number, clearly marked pending: reviewers refer to it, and it is not
              // the document's number until approval assigns it (ADR-0004).
              <div className="min-w-0">
                <dt className="text-sm opacity-70">{translate('documents.field.number')}</dt>
                <dd className="flex items-center gap-2">
                  <span className="truncate">{document.pendingNumber}</span>
                  <Badge tone="warning">{translate('documents.number.pending')}</Badge>
                </dd>
              </div>
            ) : (
              // The version badge sits beside the number, never inside it: QMS-…-0042 reads the
              // same through Original → R1 → R2, and the label is what changes
              // (`09-numbering-architecture.md` §4).
              <div className="min-w-0">
                <dt className="text-sm opacity-70">{translate('documents.field.number')}</dt>
                <dd className="flex items-center gap-2">
                  <span className="truncate">{document.documentNumber ?? '—'}</span>
                  {effectiveRevision !== null && (
                    <Badge tone="success">{effectiveRevision.label}</Badge>
                  )}
                  {draftRevision !== null && (
                    <Badge tone="muted">
                      {translate('documents.revision.draftBadge', { label: draftRevision.label })}
                    </Badge>
                  )}
                </dd>
              </div>
            )}
            <Property label={translate('documents.field.category')} value={document.categoryName} />
            <Property
              label={translate('documents.field.description')}
              value={document.description}
            />
            <Property
              label={translate('documents.field.revision')}
              value={effectiveRevision?.label ?? null}
            />
          </dl>

          {document.metadata.length > 0 && (
            <>
              <h3 className="mt-6 text-sm font-medium opacity-70">
                {translate('documents.section.metadata')}
              </h3>
              <dl className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-2">
                {document.metadata.map((entry) => (
                  <Property
                    key={entry.fieldId}
                    label={entry.name}
                    value={renderValue(entry.value)}
                  />
                ))}
              </dl>
            </>
          )}
        </Card>

        <Card>
          <h2 className="text-lg font-medium">{translate('documents.section.file')}</h2>
          {file === null ? (
            <p className="mt-2 opacity-70">{translate('documents.file.none')}</p>
          ) : (
            <dl className="mt-3 flex flex-col gap-2">
              <Property label={translate('documents.file.name')} value={file.filename} />
              <Property
                label={translate('documents.file.format')}
                value={formatFor(file.mimeType)?.label ?? file.mimeType}
              />
              <Property
                label={translate('documents.file.size')}
                value={formatFileSize(file.sizeBytes)}
              />
              <Property
                label={translate('documents.file.scan')}
                value={translate(`documents.scanStatus.${file.scanStatus}`)}
              />
              {/*
                The digest, in full. It is what makes "the bytes an approver approved are unchanged"
                provable rather than promised, and truncating it would make it decorative.
              */}
              <Property label={translate('documents.file.checksum')} value={file.checksumSha256} />
            </dl>
          )}
        </Card>
      </div>

      {editing && (
        <FormDialog
          open
          title={translate('documents.actions.edit')}
          onClose={() => setEditing(false)}
          onSubmit={saveProperties}
          onSaved={refresh}
        >
          <TextField
            name="title"
            label={translate('documents.field.title')}
            required
            defaultValue={document.title}
          />
          <TextAreaField
            name="description"
            label={translate('documents.field.description')}
            defaultValue={document.description ?? ''}
          />
          <PickerField
            name="categoryId"
            label={translate('documents.field.category')}
            options={categories}
            defaultValue={document.categoryId ?? ''}
            clearable
          />
          <PickerField
            name="confidentialityId"
            label={translate('documents.field.confidentiality')}
            hint={translate('documents.field.confidentialityRaiseOnly')}
            options={confidentialityLevels}
            defaultValue={document.confidentialityId}
          />
          <MetadataFields
            fields={fields}
            values={values}
            userChoices={users}
            departmentChoices={departments}
          />
        </FormDialog>
      )}

      {moving && (
        <FormDialog
          open
          title={translate('documents.actions.move')}
          // A move changes the folder, and the folder is the chain permissions are inherited along.
          // Saying so in the dialogue is the only warning anybody gets.
          description={translate('documents.move.warning')}
          onClose={() => setMoving(false)}
          onSubmit={(data) =>
            moveDocument(document.id, document.version, { folderId: text(data, 'folderId') })
          }
          onSaved={refresh}
        >
          <PickerField
            name="folderId"
            label={translate('documents.field.folder')}
            required
            options={folders.map((folder) => ({
              value: folder.id,
              label: folder.path === folder.id ? folder.name : `${folder.name}`,
            }))}
            defaultValue={document.folderId}
          />
        </FormDialog>
      )}

      {numbering && (
        <FormDialog
          open
          title={translate('documents.actions.assignNumber')}
          // Once written, forever: the dialogue says so before the form does it.
          description={translate('documents.assignNumber.warning')}
          onClose={() => setNumbering(false)}
          onSubmit={(data) =>
            assignDocumentNumber(document.id, { documentNumber: text(data, 'documentNumber') })
          }
          onSaved={refresh}
        >
          <TextField
            name="documentNumber"
            label={translate('documents.field.number')}
            hint={translate('documents.assignNumber.hint')}
            required
          />
        </FormDialog>
      )}

      {archiving && (
        // `FormDialog` is the screen's existing pattern for an action that needs a typed reason —
        // the same component the move and the manual number assignment use, and the same one that
        // renders the pending, error and success states. It closes and refreshes on success;
        // `onSubmit`'s `ActionResult` carries a failure back into the dialogue rather than a toast,
        // so the person keeps what they typed.
        <FormDialog
          open
          title={translate('documents.actions.archive')}
          description={translate('documents.archive.warning')}
          onClose={() => setArchiving(false)}
          onSubmit={(data) => archiveDocument(document.id, document.version, text(data, 'reason'))}
          onSaved={refresh}
        >
          <TextField
            name="reason"
            label={translate('documents.archive.reason')}
            hint={translate('documents.archive.reasonHint')}
            required
          />
        </FormDialog>
      )}

      {reinstating && (
        <FormDialog
          open
          title={translate('documents.actions.reinstate')}
          description={translate('documents.reinstate.warning')}
          onClose={() => setReinstating(false)}
          onSubmit={(data) =>
            reinstateDocument(document.id, document.version, text(data, 'reason'))
          }
          onSaved={refresh}
        >
          <TextField
            name="reason"
            label={translate('documents.archive.reason')}
            hint={translate('documents.reinstate.reasonHint')}
            required
          />
        </FormDialog>
      )}

      {approvals}

      {revisions}

      {signatures}

      {audit}

      <p>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            router.push(
              `/documents?libraryId=${document.libraryId}&folderId=${document.folderId}` as Route,
            );
          }}
        >
          {translate('documents.actions.backToFolder')}
        </Button>
      </p>
    </div>
  );
}

function Property({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string | null;
}): ReactNode {
  return (
    <div className="min-w-0">
      <dt className="text-sm opacity-70">{label}</dt>
      {/* A dash rather than an empty cell: "not set" and "the server did not say" look identical
          otherwise, and only the first is an ordinary state. */}
      <dd className="truncate">{value === null || value === '' ? '—' : value}</dd>
    </div>
  );
}

/** A metadata value as one line. Lists are joined; a boolean is a word, not `true`. */
function renderValue(value: string | number | boolean | readonly string[] | null): string | null {
  if (value === null) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? null : value.join(', ');
  }
  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }
  return String(value);
}
