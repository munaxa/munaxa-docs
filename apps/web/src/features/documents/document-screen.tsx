'use client';

import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import { type ReactNode, useState } from 'react';

import {
  Alert,
  Badge,
  Button,
  Card,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  formatFileSize,
  useToast,
} from '@munaxa/ui';
import { EllipsisVertical } from '@munaxa/icons';

import type { Document } from '@edms/contracts';
import { formatFor } from '@edms/domain';

import { WorkspacePage } from '../../components/workspace-page';
import { useTranslate } from '../../app/providers';
import type { ActionResult } from '../../lib/admin/action-result';
import {
  FormDialog,
  PickerField,
  TextAreaField,
  TextField,
  nullableText,
  optionalText,
  text,
} from '../admin-shared';
import { DocumentStatusBadge } from './status-badge';
import {
  archiveDocument,
  assignDocumentNumber,
  loadEditOptions,
  loadMoveOptions,
  moveDocument,
  reinstateDocument,
  requestDownload,
  setFavorite,
  updateDocument,
} from './actions';
import { MetadataFields, type MetadataFieldDefinition, readMetadata } from './metadata-fields';
import type { DocumentEditOptions, DocumentMoveOptions } from './options';

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
  /**
   * The two dialogues that need data, and the data itself — Phase 7.1C.
   *
   * `null` is closed. The options *are* the open state, so the dialogue cannot render before its
   * pickers exist and there is no half-populated form to design a loading state for. The shape is
   * `loadShippedTemplate`'s on the notification templates screen: await the server action, then
   * open; a refusal becomes a message and the dialogue simply does not open.
   */
  const [editing, setEditing] = useState<DocumentEditOptions | null>(null);
  const [moving, setMoving] = useState<DocumentMoveOptions | null>(null);
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

  const saveProperties =
    (fields: readonly MetadataFieldDefinition[]) =>
    async (data: FormData): Promise<ActionResult<unknown>> =>
      updateDocument(document.id, document.version, {
        title: text(data, 'title'),
        description: nullableText(data, 'description'),
        categoryId: nullableText(data, 'categoryId'),
        ...(optionalText(data, 'confidentialityId') !== undefined && {
          confidentialityId: text(data, 'confidentialityId'),
        }),
        metadata: readMetadata(data, fields),
      });

  /**
   * Opens a dialogue once the data behind it has arrived.
   *
   * The failure path matters as much as the success one: these reads carry the caller's own token
   * and enforce their own permissions, so a refusal is a real answer and gets the same toast every
   * other refused action on this screen gets — including `RATE_LIMITED`, whose catalogue sentence
   * says to wait a moment and try again.
   */
  const openWith = <TOptions,>(
    load: () => Promise<ActionResult<TOptions>>,
    show: (options: TOptions) => void,
  ): void => {
    void load().then((result) => {
      if (!result.ok) {
        toast.error(result.detail ?? translate(`error.${result.code}`));
        return;
      }
      show(result.value);
    });
  };

  /**
   * The record's secondary actions — Phase 7.
   *
   * They used to sit beside the primary one: up to eight buttons in a single wrapping row, seven of
   * them `variant="outline"` and one solid, so "download this controlled document" had the same
   * visual weight as "move it to another folder". On a laptop the row wrapped to two lines and the
   * page opened with a wall of buttons above the document's own name.
   *
   * Now the primary action stays out here and the rest collapse into one menu. Nothing is removed
   * and nothing is gated differently — every item is still built from the same `capabilities` the
   * server resolved, and an action the caller may not take is still absent rather than disabled.
   * What changed is that the screen now answers "what do I do with this" with one button instead of
   * eight.
   */
  const secondaryActions: readonly { id: string; label: string; onSelect: () => void }[] = [
    {
      id: 'favorite',
      label: translate(
        document.isFavorite ? 'documents.actions.unfavorite' : 'documents.actions.favorite',
      ),
      onSelect: () => {
        void setFavorite(document.id, !document.isFavorite).then(refresh);
      },
    },
    ...(canMove
      ? [
          {
            id: 'move',
            label: translate('documents.actions.move'),
            onSelect: () => {
              openWith(() => loadMoveOptions(document.libraryId), setMoving);
            },
          },
        ]
      : []),
    ...(offerAssignNumber
      ? [
          {
            id: 'assignNumber',
            label: translate('documents.actions.assignNumber'),
            onSelect: () => setNumbering(true),
          },
        ]
      : []),
    ...(canEdit
      ? [
          {
            id: 'edit',
            label: translate('documents.actions.edit'),
            onSelect: () => {
              openWith(
                () => loadEditOptions(document.documentTypeId, document.confidentialityRank),
                setEditing,
              );
            },
          },
        ]
      : []),
    ...(canManagePermissions === true
      ? [
          {
            id: 'permissions',
            label: translate('documents.actions.permissions'),
            onSelect: () => {
              router.push(`/documents/${document.id}/permissions` as Route);
            },
          },
        ]
      : []),
    ...(offerArchive
      ? [
          {
            id: 'archive',
            label: translate('documents.actions.archive'),
            onSelect: () => setArchiving(true),
          },
        ]
      : []),
    ...(offerReinstate
      ? [
          {
            id: 'reinstate',
            label: translate('documents.actions.reinstate'),
            onSelect: () => setReinstating(true),
          },
        ]
      : []),
  ];

  return (
    <WorkspacePage
      gap={6}
      breadcrumb={[
        { label: translate('documents.title'), href: '/documents' },
        { label: document.libraryName },
        { label: document.folderName },
      ]}
      /**
       * The identity block — brief §7's PRIMARY tier, and the thing this screen did not have.
       *
       * A controlled record is identified by its *number* as much as by its name: "SOP-QA-0042 R3"
       * is what an auditor writes down and what a procedure cites. It was buried in the properties
       * card, four lines below the fold, in the same weight as the category. Now it sits under the
       * title in a monospaced-figures line beside the revision it belongs to, which is how the two
       * are read together (`09-numbering-architecture.md` §4 — the number is stable, the label is
       * what changes).
       */
      title={
        <span className="flex min-w-0 flex-col gap-1.5">
          <span className="truncate">{document.title}</span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-normal">
            <span className="text-muted-foreground tabular-nums">
              {document.documentNumber ??
                document.pendingNumber ??
                translate('documents.number.none')}
            </span>
            {document.documentNumber === null && document.pendingNumber !== null && (
              <Badge tone="warning">{translate('documents.number.pending')}</Badge>
            )}
            {effectiveRevision !== null && (
              /*
                `muted`, not `success` — the same measurement Phase 7 made for the status badge, and
                this one slipped through because no baseline rendered the record page. The platform's
                success tone is **4.18:1** here against the 4.5:1 that 12px text needs. The revision
                label does not need a colour to be read: it sits beside the number it belongs to, in
                the identity block, which is the only place it appears.
              */
              <Badge tone="muted">{effectiveRevision.label}</Badge>
            )}
            {draftRevision !== null && (
              <Badge tone="muted">
                {translate('documents.revision.draftBadge', { label: draftRevision.label })}
              </Badge>
            )}
          </span>
        </span>
      }
      description={
        <span className="flex flex-wrap items-center gap-2">
          <DocumentStatusBadge status={document.status} />
          <Badge tone="muted">{document.documentTypeName}</Badge>
          <Badge tone="muted">{document.confidentialityName}</Badge>
          {document.origin === 'SCAN' && (
            <Badge tone="muted">{translate('documents.origin.SCAN')}</Badge>
          )}
        </span>
      }
      actions={
        <div className="flex shrink-0 items-center gap-2">
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
          {secondaryActions.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label={translate('documents.actions.more')}
                >
                  <EllipsisVertical className="size-4" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {secondaryActions.map((action) => (
                  <DropdownMenuItem key={action.id} onSelect={action.onSelect}>
                    {action.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      }
    >
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
            {/*
              The number, the revision and the pending marker moved to the identity block at the top
              of the page — Phase 7. They are what identifies a controlled record, and restating them
              here as the first of six equal properties was the clearest symptom of a page with no
              primary tier. Everything below is genuinely secondary: it describes the record rather
              than naming it.
            */}
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
                The digest, in full — and since Phase 7.1 actually in full, wrapping across lines in
                a monospaced face rather than being cut off by a `truncate` the original comment did
                not know was there. A hexadecimal digest read in a fixed-width face is one somebody
                can compare against another by eye, which is the only way this value is ever used.
              */}
              <Property
                label={translate('documents.file.checksum')}
                value={file.checksumSha256}
                wrap
              />
            </dl>
          )}
        </Card>
      </div>

      {editing !== null && (
        <FormDialog
          open
          title={translate('documents.actions.edit')}
          onClose={() => setEditing(null)}
          onSubmit={saveProperties(editing.fields)}
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
            options={editing.categories}
            defaultValue={document.categoryId ?? ''}
            clearable
          />
          <PickerField
            name="confidentialityId"
            label={translate('documents.field.confidentiality')}
            hint={translate('documents.field.confidentialityRaiseOnly')}
            options={editing.confidentialityLevels}
            defaultValue={document.confidentialityId}
          />
          <MetadataFields
            fields={editing.fields}
            values={values}
            userChoices={editing.users}
            departmentChoices={editing.departments}
          />
        </FormDialog>
      )}

      {moving !== null && (
        <FormDialog
          open
          title={translate('documents.actions.move')}
          // A move changes the folder, and the folder is the chain permissions are inherited along.
          // Saying so in the dialogue is the only warning anybody gets.
          description={translate('documents.move.warning')}
          onClose={() => setMoving(null)}
          onSubmit={(data) =>
            moveDocument(document.id, document.version, { folderId: text(data, 'folderId') })
          }
          onSaved={refresh}
        >
          <PickerField
            name="folderId"
            label={translate('documents.field.folder')}
            required
            options={moving.folders}
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
    </WorkspacePage>
  );
}

function Property({
  label,
  value,
  wrap,
}: {
  readonly label: string;
  readonly value: string | null;
  /**
   * Let the value break across lines instead of truncating it — Phase 7.1.
   *
   * One property needs it and the reason is worth stating: the content digest. Phase 3 shipped it
   * *in full* on purpose — "it is what makes 'the bytes an approver approved are unchanged' provable
   * rather than promised, and truncating it would make it decorative" — and then rendered it inside
   * a `truncate`, so the screen showed about a third of it. That was a contradiction between the
   * comment and the pixels for four phases.
   *
   * It was also a layout defect. A sixty-four character hexadecimal string has no break opportunity,
   * so it set the automatic minimum size of its grid item, and the whole two-card row inherited a
   * 588px floor. On a 390px phone the record page overflowed by 198px — measured, not inferred.
   * `break-all` fixes both at once: the digest is fully readable, and the card can be as narrow as
   * the viewport.
   */
  readonly wrap?: boolean | undefined;
}): ReactNode {
  return (
    <div className="min-w-0">
      <dt className="text-sm opacity-70">{label}</dt>
      {/* A dash rather than an empty cell: "not set" and "the server did not say" look identical
          otherwise, and only the first is an ordinary state. */}
      <dd className={wrap === true ? 'font-mono text-xs break-all' : 'truncate'}>
        {value === null || value === '' ? '—' : value}
      </dd>
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
