'use client';

import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import { type ReactNode, useState } from 'react';

import {
  Badge,
  Button,
  type ColumnDef,
  Switch,
  formatFileSize,
  useMediaQuery,
  useToast,
} from '@munaxa/ui';

import { Plus } from '@munaxa/icons';

import type { BulkOperationResult, DocumentSummary, Folder, Library } from '@edms/contracts';
import { formatFor } from '@edms/domain';

import { WorkspacePage } from '../../components/workspace-page';
import { useTranslate } from '../../app/providers';
import type { ListState } from '../../lib/admin/list-state';
import {
  type Choice,
  ResourceList,
  useAction,
  useAdminColumns,
  useListNavigation,
} from '../admin-shared';
import { deleteDocument, requestDownload, restoreDocument, setFavorite } from './actions';
import { bulkExport, bulkRestore } from './bulk-actions';
import { BulkMetadataDialog, BulkResultDialog } from './bulk-panel';
import { FolderTree } from './folder-tree';
import { DocumentStatusBadge } from './status-badge';
import { type DocumentTypeChoice, UploadDialog } from './upload-dialog';

/**
 * The document library.
 *
 * The navigation and the list are one screen because they are one question — "what is in here" —
 * and both halves read from the URL. A folder is not selected state; it is a query parameter, so a
 * filtered view of a folder is a link somebody can send.
 *
 * `ResourceList` does the list, unchanged from Administration: the toolbar, the grid, the row menu,
 * the delete and restore confirmations and the recycle bin are the same behaviour here as they are
 * for a document type, and forking it to add a thumbnail column would have been forking it to add a
 * column. What this screen adds is the parts that are genuinely about documents — the tree, the
 * upload dialogue, the scan intake, and the per-row favourite and download.
 */
export function LibraryScreen({
  rows,
  total,
  state,
  libraries,
  folders,
  selectedLibraryId,
  selectedFolderId,
  selectedFolderName,
  documentTypes,
  categories,
  confidentialityLevels,
  users,
  departments,
  canCreate,
  canBulk,
}: {
  readonly rows: readonly DocumentSummary[];
  readonly total: number;
  readonly state: ListState;
  readonly libraries: readonly Library[];
  readonly folders: readonly Folder[];
  readonly selectedLibraryId: string | null;
  readonly selectedFolderId: string | null;
  readonly selectedFolderName: string;
  readonly documentTypes: readonly DocumentTypeChoice[];
  readonly categories: readonly Choice[];
  readonly confidentialityLevels: readonly Choice[];
  readonly users: readonly Choice[];
  readonly departments: readonly Choice[];
  readonly canCreate: boolean;
  /**
   * What this caller may do in bulk — 16 §5's *"bulk actions gated by `capabilities`"*.
   *
   * Resolved on the server from the caller's own grants and passed down, rather than inferred in
   * the browser from what happens to be on screen. The API decides again, per object, when the
   * request arrives; this is what keeps a button that would certainly be refused from being
   * offered at all.
   */
  readonly canBulk: {
    readonly edit: boolean;
    readonly restore: boolean;
    readonly download: boolean;
  };
}): ReactNode {
  const translate = useTranslate();
  const router = useRouter();
  const toast = useToast();
  const column = useAdminColumns<DocumentSummary>();
  const { refresh, setFilter } = useListNavigation(state);
  const run = useAction(state);
  const [adding, setAdding] = useState<'UPLOAD' | 'SCAN' | null>(null);
  const [bulkResult, setBulkResult] = useState<BulkOperationResult | null>(null);
  const [bulkEditing, setBulkEditing] = useState<readonly string[] | null>(null);

  const includeSubfolders = state.filters.underFolderId !== undefined;

  /**
   * How many columns this viewport can actually carry — Phase 7.1.
   *
   * A baseline at 390px is what found this, and what it found was not cosmetic: the grid shares its
   * width evenly between eight columns, so on a phone every one of them was about forty pixels. The
   * headers overlapped into an unreadable smear and **the row rendered empty** — no title, no
   * number, no status. The one screen an EDMS is most likely to be opened on away from a desk
   * showed nothing about the document it was listing.
   *
   * `DataGrid` has no responsive strategy of its own: no stacked mode, no per-column priority, no
   * proportional widths. That is a platform gap and it is written up as one rather than worked
   * around — this is not a second grid, not a card list beside the table, and not a fork. It is the
   * same `ResourceList` and the same `DataGrid`, handed **fewer columns**, chosen with the
   * platform's own `useMediaQuery`. Nothing is lost: the title cell already carries the number on
   * its second line, and every hidden column is one the reader can bring back from the column menu.
   *
   * The two breakpoints match Tailwind's `sm` and `lg`, which is what the rest of this screen is
   * laid out on, so the column set changes at the same width as the folder aside.
   */
  const roomForAll = useMediaQuery('(min-width: 1024px)');
  const roomForSome = useMediaQuery('(min-width: 640px)');

  const download = (row: DocumentSummary): void => {
    // Requested at the moment of clicking rather than rendered with the row: issuing a link is an
    // audited event, and a page of two hundred rows must not write two hundred of them for links
    // nobody used.
    void requestDownload(row.id, false).then((result) => {
      if (!result.ok) {
        toast.error(result.detail ?? translate(`error.${result.code}`));
        return;
      }
      window.location.assign(result.value.url);
    });
  };

  return (
    <WorkspacePage
      title={translate('documents.title')}
      description={translate('documents.description')}
      // Where you are, said once at the top rather than only by which node the tree has
      // highlighted — Phase 7. The library and the folder are how somebody describes a location out
      // loud ("the SOP folder in Quality"), and until now the screen never wrote it down.
      breadcrumb={[
        { label: translate('nav.documents'), href: '/documents' },
        ...(selectedFolderName === '' ? [] : [{ label: selectedFolderName }]),
      ]}
      /**
       * The primary action, promoted out of the toolbar — Phase 7.6.
       *
       * `ResourceList` renders `onCreate` as the last control in its `Toolbar`, beside the search
       * box, the deleted filter and the column menu. That is the right place for a *list* control
       * and the wrong place for the screen's primary action: the one thing a reader comes here to
       * do sat in a row of things that change what they are looking at, at the same weight as a
       * dropdown.
       *
       * `PageHeader` has carried an `actions` slot since the platform shipped it, and
       * `WorkspacePage` has passed it through since Phase 7 — four screens used it and the library
       * was not one of them. So this is the composition that already existed, applied to the screen
       * with the strongest claim on it, and it is what every reference screenshot shows: the create
       * action at the top of the page, not inside the table's chrome.
       *
       * `onCreate` is correspondingly *not* passed below, because two create buttons is worse than
       * either placement. The permission test is unchanged and still the server's answer.
       */
      actions={
        canCreate && selectedFolderId !== null ? (
          <Button
            type="button"
            onClick={() => {
              setAdding('UPLOAD');
            }}
          >
            <Plus className="size-4" aria-hidden />
            {translate('admin.actions.create')}
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-6 lg:flex-row">
        <aside className="lg:w-72 lg:shrink-0">
          <FolderTree
            libraries={libraries}
            folders={folders}
            selectedLibraryId={selectedLibraryId}
            selectedFolderId={selectedFolderId}
          />
        </aside>

        <section className="min-w-0 flex-1">
          <ResourceList<DocumentSummary>
            rows={rows}
            total={total}
            state={state}
            getRowId={(row) => row.id}
            getRowName={(row) => row.title}
            isDeleted={(row) => row.deletedAt !== null}
            searchPlaceholderKey="documents.list.searchPlaceholder"
            // Two lines in the title cell need the room for two lines. Uniform, because the grid
            // windows on it.
            rowHeight={56}
            onRowActivate={(row) => {
              router.push(`/documents/${row.id}` as Route);
            }}
            // Deliberately absent: the create action lives in the page header now — see the
            // `actions` prop above. `ResourceList` still owns every other toolbar control.
            onDelete={(row, reason) => deleteDocument(row.id, row.version, reason)}
            // Phase 10's rule, and it applies here rather than to every administered list: a
            // controlled record's removal is an act somebody answers for, and the recycle bin shows
            // the sentence beside the row.
            deleteRequiresReason
            onRestore={(row) => restoreDocument(row.id, row.version)}
            extraActions={(row) => [
              {
                id: 'download',
                label: translate('documents.actions.download'),
                onSelect: () => {
                  download(row);
                },
                // A document whose content has not cleared the scanner exists and cannot be opened.
                // Saying so on a disabled item is honest; an action that fails when used is not.
                disabledReason:
                  row.file?.reachable === true ? null : translate('documents.actions.notReachable'),
              },
              {
                id: 'favorite',
                label: translate(
                  row.isFavorite ? 'documents.actions.unfavorite' : 'documents.actions.favorite',
                ),
                onSelect: () => {
                  run(() => setFavorite(row.id, !row.isFavorite));
                },
              },
            ]}
            /**
             * The folder browser's bulk actions, which 16 §5 has promised since Phase 0.
             *
             * Each is gated twice and the two gates are not the same. Here, on the caller's
             * tenant-wide grant, so an affordance nobody could use is not offered; and at the API,
             * per object, against the caller's reach — which is the one that decides. That is why a
             * bulk restore of forty documents can come back with thirty-eight applied and two
             * refused: this screen cannot know which two, and it does not guess.
             */
            bulkActions={(selected) => {
              const ids = selected.map((row) => row.id);
              const deletedOnly = selected.every((row) => row.deletedAt !== null);
              return [
                {
                  id: 'metadata',
                  label: translate('bulk.action.metadata'),
                  disabledReason: canBulk.edit ? null : translate('bulk.disabled.noPermission'),
                  onSelect: () => {
                    setBulkEditing(ids);
                  },
                },
                {
                  id: 'export',
                  label: translate('bulk.action.export'),
                  disabledReason: canBulk.download ? null : translate('bulk.disabled.noPermission'),
                  onSelect: () => {
                    void bulkExport(ids).then((answer) => {
                      if (!answer.ok) {
                        toast.error(answer.detail ?? translate(`error.${answer.code}`));
                        return;
                      }
                      setBulkResult(answer.value);
                    });
                  },
                },
                {
                  id: 'restore',
                  label: translate('bulk.action.restore'),
                  // Two different reasons for the same disabled button, and saying which is the
                  // difference between "you cannot" and "not these".
                  disabledReason: !canBulk.restore
                    ? translate('bulk.disabled.noPermission')
                    : deletedOnly
                      ? null
                      : translate('bulk.disabled.notDeleted'),
                  onSelect: () => {
                    void bulkRestore(ids).then((answer) => {
                      if (!answer.ok) {
                        toast.error(answer.detail ?? translate(`error.${answer.code}`));
                        return;
                      }
                      setBulkResult(answer.value);
                      refresh();
                    });
                  },
                },
              ];
            }}
            filters={
              <div className="flex flex-wrap items-center gap-3">
                {selectedFolderId !== null && (
                  <label className="flex items-center gap-2 text-sm">
                    <Switch
                      checked={includeSubfolders}
                      onCheckedChange={(checked) => {
                        // Two different filters rather than a flag on one: the API distinguishes
                        // "in this folder" from "anywhere beneath it", and the second is a path
                        // prefix scan the first does not need.
                        // One filter carries the answer and the other is cleared, because the API
                        // distinguishes "in this folder" from "anywhere beneath it" — the second is
                        // a path-prefix scan the first does not need.
                        setFilter('underFolderId', checked ? selectedFolderId : '');
                        setFilter('folderId', checked ? '' : selectedFolderId);
                      }}
                    />
                    {translate('documents.list.includeSubfolders')}
                  </label>
                )}
                {canCreate && selectedFolderId !== null && (
                  <Button type="button" variant="outline" onClick={() => setAdding('SCAN')}>
                    {translate('documents.actions.scan')}
                  </Button>
                )}
              </div>
            }
            columns={[
              {
                id: 'title',
                header: translate('documents.column.title'),
                /**
                 * Two lines, and the second one is the point — Phase 7.
                 *
                 * The title and the document number were two columns of equal weight, so a folder of
                 * two hundred rows read as a wall of same-sized text. What a reader actually scans for
                 * is the *title*; the number is how they cite it once they have found it. So the title
                 * carries the row's weight and the number sits under it, smaller and muted, where it
                 * is still readable and still copyable but no longer competing.
                 *
                 * The number column stays in the grid (hidden by default is the column menu's
                 * business, not this cell's) because it is sortable and because an auditor sorting by
                 * number is a real thing somebody does.
                 */
                cell: (row) => (
                  <div className="flex min-w-0 items-center gap-2">
                    <FormatBadge row={row} />
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">{row.title}</span>
                      <span className="text-muted-foreground truncate text-xs tabular-nums">
                        {row.documentNumber ?? translate('documents.number.none')}
                      </span>
                    </div>
                    {row.isFavorite && (
                      <span aria-label={translate('documents.actions.favorite')}>★</span>
                    )}
                  </div>
                ),
                sortable: true,
                /*
                 * The platform's own answer to "a name above a secondary identifier". `multiline`
                 * keeps the uniform row height windowing depends on; the `rowHeight` below is the
                 * half of that contract this screen has to keep.
                 *
                 * **No width, and that was measured rather than assumed.** Both `width: 320` and
                 * `width: 240` were tried in a real browser: the grid gives fixed columns their width
                 * first and shares what is left, so either one turned Type, Confidentiality and Size
                 * into single-letter ellipses with colliding headers. `minWidth` is not honoured by
                 * the current distribution. Even sharing reads best at this width, and the platform's
                 * lack of a proportional column strategy is written up as a gap in the Phase 7 report
                 * rather than worked around here.
                 */
                multiline: true,
                value: (row) => row.title,
              },
              // Everything below the title is optional, in the order a reader gives it up. The
              // number goes first because the title cell already carries it; size and the record's
              // own state go next; type and confidentiality survive to tablet because they are how
              // somebody scans a folder for the right *kind* of document.
              ...(roomForAll
                ? ([
                    {
                      id: 'documentNumber',
                      header: translate('documents.column.number'),
                      // Null until approval, and shown as a dash rather than blank so the column reads as
                      // "not yet" instead of "missing".
                      cell: (row) => row.documentNumber ?? '—',
                      sortable: true,
                      value: (row) => row.documentNumber,
                    },
                  ] as ColumnDef<DocumentSummary>[])
                : []),
              {
                id: 'status',
                header: translate('documents.column.status'),
                // One status system, shared with search, the record page and the recycle bin — every
                // state its own tone *and* its own mark, because five tones cannot distinguish
                // thirteen states and colour alone would not be readable anyway.
                cell: (row) => <DocumentStatusBadge status={row.status} />,
                sortable: true,
                value: (row) => row.status,
              },
              ...(roomForSome
                ? ([
                    {
                      id: 'documentType',
                      header: translate('documents.column.type'),
                      cell: (row) => row.documentTypeName,
                    },
                    {
                      id: 'confidentiality',
                      header: translate('documents.column.confidentiality'),
                      cell: (row) => row.confidentialityName,
                    },
                    {
                      id: 'size',
                      header: translate('documents.column.size'),
                      cell: (row) => (row.file === null ? '—' : formatFileSize(row.file.sizeBytes)),
                      // End-aligned: a size is a figure, and figures read down a column when their last
                      // digits line up.
                      align: 'end',
                      value: (row) => row.file?.sizeBytes ?? null,
                    },
                  ] as ColumnDef<DocumentSummary>[])
                : []),
              ...(roomForAll
                ? ([
                    /*
                     * Two columns headed "Status" is what the browser showed once the lifecycle badge grew
                     * a mark — and it was there before Phase 7, unread because both were the same grey.
                     * They answer different questions: the one above is the document's *lifecycle* state,
                     * this one is whether the **row** is deleted, inactive or system-owned. The shared
                     * column keeps its own header everywhere else in Administration, where there is no
                     * second status to confuse it with; here it is renamed in place.
                     */
                    { ...column.state(), header: translate('admin.fields.record') },
                    // The date joins the tablet set rather than the phone one. At 390px, with a
                    // selection checkbox and a row menu already taking their share, "Last changed"
                    // cost the title about half its width — and a list where the title reads "Qu…"
                    // is a list that has stopped naming documents. Measured, not guessed.
                    column.updated(),
                  ] as ColumnDef<DocumentSummary>[])
                : []),
            ]}
          />
        </section>
      </div>

      {adding !== null && selectedFolderId !== null && (
        <UploadDialog
          open
          origin={adding}
          folderId={selectedFolderId}
          folderName={selectedFolderName}
          documentTypes={documentTypes}
          categories={categories}
          confidentialityLevels={confidentialityLevels}
          users={users}
          departments={departments}
          onClose={() => setAdding(null)}
          onSaved={refresh}
        />
      )}

      {bulkEditing === null ? null : (
        <BulkMetadataDialog
          ids={bulkEditing}
          categories={categories}
          onClose={() => {
            setBulkEditing(null);
          }}
          onDone={(result) => {
            setBulkEditing(null);
            setBulkResult(result);
            refresh();
          }}
        />
      )}

      {bulkResult === null ? null : (
        <BulkResultDialog
          result={bulkResult}
          onClose={() => {
            setBulkResult(null);
          }}
        />
      )}
    </WorkspacePage>
  );
}

/**
 * What kind of file this is, at a glance.
 *
 * The format's own label rather than an icon, because Phase 3 draws a thumbnail only for PNG and a
 * grid of mostly-blank thumbnail cells reads worse than a grid of legible labels. Phase 7 brings
 * renderers for the rest, and this is the row that will carry them.
 */
function FormatBadge({ row }: { readonly row: DocumentSummary }): ReactNode {
  const translate = useTranslate();
  if (row.file === null) {
    return null;
  }
  const format = formatFor(row.file.mimeType);
  return (
    <Badge tone={row.file.reachable ? 'muted' : 'warning'}>
      {format?.family ?? translate('documents.column.unknownFormat')}
    </Badge>
  );
}
