'use client';

import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import { type ReactNode, useState } from 'react';

import { Badge, Button, type ColumnDef, Switch, useMediaQuery, useToast } from '@munaxa/ui';

import { Plus } from '@munaxa/icons';

import type { BulkOperationResult, DocumentSummary, Folder, Library } from '@edms/contracts';
import { DocumentStatus, type DocumentStatusKey, formatFor } from '@edms/domain';
import type { MessageKey } from '@edms/i18n';

import { WorkspacePage, type WorkspaceCrumb } from '../../components/workspace-page';
import { useTranslate } from '../../app/providers';
import type { ListState } from '../../lib/admin/list-state';
import {
  type BulkAction,
  BulkBar,
  type Choice,
  ResourceList,
  useAction,
  useAdminColumns,
  useListNavigation,
} from '../admin-shared';
import { deleteDocument, requestDownload, restoreDocument, setFavorite } from './actions';
import { bulkExport, bulkRestore } from './bulk-actions';
import { BulkMetadataDialog, BulkResultDialog } from './bulk-panel';
import { DocumentGlance } from './document-glance';
import type { DocumentsView } from './documents-view';
import { FolderTree } from './folder-tree';
import { FilterChip, type FilterChoice } from './filter-chip';
import { folderTrail } from './folder-trail';
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
  folderPage,
  documentTypes,
  categories,
  confidentialityLevels,
  users,
  departments,
  filterOptions = NO_FILTER_OPTIONS,
  ownerNames = NO_NAMES,
  canCreate,
  canBulk,
  view,
}: {
  readonly rows: readonly DocumentSummary[];
  readonly total: number;
  readonly state: ListState;
  readonly libraries: readonly Library[];
  readonly folders: readonly Folder[];
  readonly selectedLibraryId: string | null;
  readonly selectedFolderId: string | null;
  readonly selectedFolderName: string;
  /**
   * How much of the library's structure the rail is actually holding — Slice 7.
   *
   * Passed through rather than counted here, because only the server knows the difference between
   * "these are all the folders" and "these are the first hundred of them". `hasMore` is the
   * server's own word for the second, and it describes the *initial page*: it stays true whether or
   * not the selected folder happened to be in it.
   */
  readonly folderPage: {
    /** Folders handed to the tree — the page, plus any recovered chain. */
    readonly shown: number;
    /** Folders the library has, counted by the API rather than by this screen. */
    readonly total: number;
    readonly hasMore: boolean;
  };
  readonly documentTypes: readonly DocumentTypeChoice[];
  readonly categories: readonly Choice[];
  readonly confidentialityLevels: readonly Choice[];
  readonly users: readonly Choice[];
  readonly departments: readonly Choice[];
  /**
   * What the filter chips offer — Docs v2. `null` for a list the caller may not read (the
   * configuration catalogue is behind `configuration:view`), in which case that chip is not drawn
   * rather than drawn empty. `currentUserId` is what "Owner · Me" puts in the URL.
   */
  readonly filterOptions?: {
    readonly types: readonly FilterChoice[] | null;
    readonly confidentiality: readonly FilterChoice[] | null;
    readonly currentUserId: string | null;
  };
  /** Owner ids to names, when the caller may read the directory. Empty otherwise. */
  readonly ownerNames?: Readonly<Record<string, string>>;
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
  /**
   * Which question this page is answering — resolved on the server, from the URL the list was
   * fetched with. See `documents-view.ts`; the header reads it so it cannot describe a scope the
   * API was never asked for.
   */
  readonly view: DocumentsView;
}): ReactNode {
  const translate = useTranslate();
  const router = useRouter();
  const toast = useToast();
  const column = useAdminColumns<DocumentSummary>();
  const { refresh, setFilters } = useListNavigation(state);
  const run = useAction(state);
  const [adding, setAdding] = useState<'UPLOAD' | 'SCAN' | null>(null);
  const [bulkResult, setBulkResult] = useState<BulkOperationResult | null>(null);
  const [bulkEditing, setBulkEditing] = useState<readonly string[] | null>(null);
  /*
   * Two independent answers about rows, and the design shows both at once: which rows are ticked
   * for a bulk action (the header's bar) and which one row is being looked at (the docked panel).
   * The selection is held here rather than inside `ResourceList` so the bar can sit in the page
   * header; `ResourceList` still clears it when the list changes underneath it.
   */
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  const [shownId, setShownId] = useState<string | null>(null);
  const shown = rows.find((row) => row.id === shownId) ?? rows[0] ?? null;

  const includeSubfolders = state.filters.underFolderId !== undefined;

  /**
   * Where this folder sits, and what it holds.
   *
   * The crumb read `Documents › SOP` — the destination, and nothing about the route to it. In a
   * library where SOP sits under Quality, under Manufacturing, that is three levels of context
   * dropped from the one line on the page whose job is to carry them.
   *
   * The library is a crumb of its own rather than the root folder's name, because that is how
   * somebody says it out loud — "the SOP folder in Quality Management" — and because the root
   * folder and the library are the same place under two names. `Folder.libraryName` supplies it, so
   * the crumb comes from the same rows the trail does rather than from a second lookup.
   */
  const selectedFolder = folders.find((entry) => entry.id === selectedFolderId) ?? null;
  const trail = view === 'folder' ? folderTrail(folders, selectedFolderId) : [];
  const rootFolderId = libraries.find((entry) => entry.id === selectedLibraryId)?.rootFolderId;
  const libraryName = trail[0]?.libraryName;

  const crumbs: WorkspaceCrumb[] = [
    { label: translate('nav.documents'), href: '/documents' },
    ...(view === 'filtered'
      ? // `Documents › Favourites`. No library and no folder, because favourites belong to neither
        // — the whole point of this view is that it crosses both.
        [{ label: translate('documents.nav.favorites') }]
      : [
          ...(libraryName === undefined || rootFolderId === undefined
            ? []
            : [
                {
                  label: libraryName,
                  href: `/documents?libraryId=${String(selectedLibraryId)}&folderId=${rootFolderId}` as Route,
                },
              ]),
          // The root is already spoken for by the library crumb above; repeating it would name the
          // same place twice in a row.
          ...trail
            .filter((entry) => !entry.isRoot)
            .map((entry) => ({
              label: entry.name,
              href: `/documents?libraryId=${String(selectedLibraryId)}&folderId=${entry.id}` as Route,
            })),
        ]),
  ];
  // The page you are already on is not a link — `WorkspacePage`'s own rule, applied to whichever
  // crumb ended up last rather than to a fixed position.
  const breadcrumb = crumbs.map((crumb, index) =>
    index === crumbs.length - 1 ? { label: crumb.label } : crumb,
  );

  /**
   * The folder being read, named — Slice 2.
   *
   * The heading said "Documents" on every folder of every library, so the one element a screen
   * reader reaches first, and the one a person's eye lands on, never said where they were. The
   * breadcrumb knew; the heading did not.
   *
   * It is the folder's *own* name and therefore user data, not a translated string — which is why
   * the fallbacks matter. `selectedFolderName` already resolves folder → library → empty on the
   * server, and an empty result falls back to the route's name rather than rendering an empty
   * heading.
   */
  const title =
    view === 'filtered'
      ? translate('documents.nav.favorites')
      : view === 'folder' && selectedFolderName !== ''
        ? selectedFolderName
        : translate('documents.title');

  /**
   * What is here, counted at the scope the list was actually fetched at.
   *
   * Both figures are the server's own — `meta.total` for the documents, `Folder.childCount` for the
   * subfolders — so neither is this screen counting rows it happens to be holding.
   *
   * **The subfolder count is withheld on a filtered view, and that is the defect Slice 2 exists to
   * remove.** Favourites are collected across the tenant, so no folder's subfolder count is true of
   * them; printing the selected folder's beside a tenant-wide document total put two numbers of
   * different scopes in one sentence. The document total stays, because it does describe the rows on
   * screen.
   *
   * A folder missing from the fetched page (the API caps folders at 100) leaves `selectedFolder`
   * null and the generic description stands, because "0 folders" would be a claim where the truth is
   * an absence.
   */
  const description =
    view === 'filtered'
      ? translate('documents.count.documents', { count: total })
      : selectedFolder === null
        ? translate('documents.description')
        : [
            translate('documents.count.documents', { count: total }),
            translate('documents.count.folders', { count: selectedFolder.childCount }),
          ].join(' · ');

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

  /**
   * The bulk actions, gated twice — 16 §5's folder-browser row.
   *
   * Here, on the caller's tenant-wide grant, so an affordance nobody could use is not offered; and at
   * the API, per object, against the caller's reach — which is the one that decides. That is why a
   * bulk restore of forty documents can come back with thirty-eight applied and two refused: this
   * screen cannot know which two, and it does not guess.
   */
  const bulkActions = (selected: readonly DocumentSummary[]): readonly BulkAction[] => {
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
        // Two different reasons for the same disabled button, and saying which is the difference
        // between "you cannot" and "not these".
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
  };

  /**
   * The filter chips — Docs v2. Every one is a real filter the API already answers
   * (`DOCUMENT_FILTER_KEYS`); the design's Department and Updated chips are not drawn, because the
   * document list has no such filter and a chip that highlighted without narrowing would be a
   * control that lies.
   */
  const filterValue = (key: string): string | null => {
    const value = state.filters[key];
    return typeof value === 'string' && value !== '' ? value : null;
  };
  const chips: ReactNode[] = [
    <FilterChip
      key="status"
      name={translate('documents.filter.status')}
      value={filterValue('status')}
      resetLabel={translate('documents.filter.all')}
      choices={LIBRARY_STATUSES.map((status) => ({
        value: status,
        label: translate(`documents.status.${status}` as MessageKey),
      }))}
      onChange={(value) => {
        setFilters({ status: value ?? '' });
      }}
    />,
    ...(filterOptions.types === null
      ? []
      : [
          <FilterChip
            key="type"
            name={translate('documents.filter.type')}
            value={filterValue('documentTypeId')}
            resetLabel={translate('documents.filter.all')}
            choices={filterOptions.types}
            onChange={(value) => {
              setFilters({ documentTypeId: value ?? '' });
            }}
          />,
        ]),
    ...(filterOptions.confidentiality === null
      ? []
      : [
          <FilterChip
            key="confidentiality"
            name={translate('documents.filter.confidentiality')}
            value={filterValue('confidentialityId')}
            resetLabel={translate('documents.filter.all')}
            choices={filterOptions.confidentiality}
            onChange={(value) => {
              setFilters({ confidentialityId: value ?? '' });
            }}
          />,
        ]),
    ...(filterOptions.currentUserId === null
      ? []
      : [
          <FilterChip
            key="owner"
            name={translate('documents.filter.owner')}
            // Only "me" is offered, so any other owner id in the URL (a dashboard tile's link names
            // the caller too) still reads as set.
            value={filterValue('ownerUserId')}
            resetLabel={translate('documents.filter.anyone')}
            choices={[
              { value: filterOptions.currentUserId, label: translate('documents.filter.me') },
            ]}
            onChange={(value) => {
              setFilters({ ownerUserId: value ?? '' });
            }}
          />,
        ]),
  ];

  /**
   * The columns — Docs v2: number, title with its owner beneath, type, status and last change.
   *
   * Confidentiality and size moved to the docked panel, which is where the design puts them and
   * what made room for the panel at all. Everything below the title is still optional in the order
   * a reader gives it up on a narrower screen (Phase 7.1's measured breakpoints), and the number
   * returns to the title's second line whenever its own column is not there, so no width ever loses
   * it.
   *
   * Widths on the narrow columns only. The title takes what is left, and is the one column that
   * should: Phase 7 measured what fixed title widths did to everything beside them.
   */
  const columns: ColumnDef<DocumentSummary>[] = [
    ...(roomForAll
      ? ([
          {
            id: 'documentNumber',
            header: translate('documents.column.number'),
            // Null until approval, and shown as a dash rather than blank so the column reads as
            // "not yet" instead of "missing". Mono and in the brand's text colour: a number is an
            // identifier a reader copies, and the design sets it apart from prose.
            cell: (row) => (
              <span className="text-primary-strong font-mono text-xs">
                {row.documentNumber ?? '—'}
              </span>
            ),
            value: (row) => row.documentNumber,
            width: 148,
          },
        ] as ColumnDef<DocumentSummary>[])
      : []),
    {
      id: 'title',
      header: translate('documents.column.title'),
      cell: (row) => {
        const second = roomForAll
          ? (ownerNames[row.ownerUserId] ?? row.folderName)
          : (row.documentNumber ?? translate('documents.number.none'));
        return (
          <div className="flex min-w-0 items-center gap-2">
            {/* Only when the file has not cleared the malware check: it is the one state of the file
                a reader needs to know before opening the row. The format itself is in the panel. */}
            {row.file !== null && !row.file.reachable && <FormatBadge row={row} />}
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-[13.5px] font-medium">
                {row.title}
                {row.isFavorite && (
                  <span
                    className="text-primary-strong ms-1.5"
                    aria-label={translate('documents.actions.favorite')}
                  >
                    ★
                  </span>
                )}
              </span>
              <span className="text-muted-foreground truncate text-[11.5px]">{second}</span>
            </div>
          </div>
        );
      },
      sortable: true,
      multiline: true,
      value: (row) => row.title,
    },
    ...(roomForSome
      ? ([
          {
            id: 'documentType',
            header: translate('documents.column.type'),
            cell: (row) => (
              <span className="text-muted-foreground text-[12.5px]">{row.documentTypeName}</span>
            ),
            width: 120,
          },
        ] as ColumnDef<DocumentSummary>[])
      : []),
    {
      id: 'status',
      header: translate('documents.column.status'),
      // One status system, shared with search, the record page and the recycle bin — every state its
      // own tone *and* its own mark, because five tones cannot distinguish thirteen states and colour
      // alone would not be readable anyway.
      cell: (row) => <DocumentStatusBadge status={row.status} />,
      sortable: true,
      value: (row) => row.status,
      width: 168,
    },
    // Whether the *row* is deleted or inactive — only worth a column when the list can contain such
    // rows. On the live list every row would say the same thing.
    ...(state.deleted === 'live'
      ? []
      : [{ ...column.state(), header: translate('admin.fields.record') }]),
    ...(roomForAll ? [{ ...column.updated(), width: 116 }] : []),
  ];

  return (
    <div className="flex min-h-full flex-col lg:flex-row">
      {/* The folder rail — full height, flush with the frame (Docs v2). Half the card surface over
          the canvas: a shade lighter than the page in both schemes, which is what the design's rail
          is, where a muted wash would have read as a shade darker. */}
      <div className="border-border bg-card/50 shrink-0 border-b lg:w-[200px] lg:border-e lg:border-b-0">
        <FolderTree
          libraries={libraries}
          folders={folders}
          selectedLibraryId={selectedLibraryId}
          selectedFolderId={selectedFolderId}
          folderPage={folderPage}
          // The same value the heading, the counts and the breadcrumb read. One resolution of
          // "which view is this", consumed four times.
          view={view}
        />
      </div>

      <div className="min-w-0 flex-1">
        <WorkspacePage
          title={title}
          description={description}
          width="full"
          gap={4}
          // Where you are, said once at the top rather than only by which node the tree has
          // highlighted — Phase 7.
          breadcrumb={breadcrumb}
          /**
           * The primary action, and — Docs v2 — the bulk bar beside it.
           *
           * The selection's actions sit in the header where the reader's eye already is for "what
           * can I do here", and only while something is selected: an always-present "0 selected" bar
           * was tried in review and read as clutter.
           */
          actions={
            selectedIds.length === 0 && !(canCreate && selectedFolderId !== null) ? undefined : (
              <>
                {selectedIds.length > 0 && (
                  <BulkBar
                    compact
                    selected={selectedIds}
                    actions={bulkActions(rows.filter((row) => selectedIds.includes(row.id)))}
                    onClear={() => {
                      setSelectedIds([]);
                    }}
                  />
                )}
                {canCreate && selectedFolderId !== null && (
                  <Button
                    type="button"
                    onClick={() => {
                      setAdding('UPLOAD');
                    }}
                  >
                    <Plus className="size-4" aria-hidden />
                    {translate('documents.actions.upload')}
                  </Button>
                )}
              </>
            )
          }
        >
          {/*
            The list and the panel beside it — wrapping, not breaking. The list keeps at least 640px
            and the panel at least 300px; below their sum the panel drops under the list rather than
            either of them being squeezed, which is the design's own rule and the one Phase 7.1's
            measured column collapses depend on.
          */}
          <div className="flex flex-wrap items-start gap-4">
            <div className="flex min-w-0 flex-[1_1_640px] flex-col gap-3">
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
                headerStyle="caps"
                // A click shows the row in the panel; a double click or Enter opens the record, as
                // it always did. The panel's own button is the third way in.
                onRowClick={(row) => {
                  setShownId(row.id);
                }}
                activeRowId={shown?.id ?? null}
                onRowActivate={(row) => {
                  router.push(`/documents/${row.id}` as Route);
                }}
                onDelete={(row, reason) => deleteDocument(row.id, row.version, reason)}
                // Phase 10's rule: a controlled record's removal is an act somebody answers for.
                deleteRequiresReason
                onRestore={(row) => restoreDocument(row.id, row.version)}
                extraActions={(row) => [
                  {
                    id: 'download',
                    label: translate('documents.actions.download'),
                    onSelect: () => {
                      download(row);
                    },
                    // A document whose content has not cleared the scanner exists and cannot be
                    // opened. Saying so on a disabled item is honest; an action that fails is not.
                    disabledReason:
                      row.file?.reachable === true
                        ? null
                        : translate('documents.actions.notReachable'),
                  },
                  {
                    id: 'favorite',
                    label: translate(
                      row.isFavorite
                        ? 'documents.actions.unfavorite'
                        : 'documents.actions.favorite',
                    ),
                    onSelect: () => {
                      run(() => setFavorite(row.id, !row.isFavorite));
                    },
                  },
                ]}
                bulkActions={bulkActions}
                selection={{ ids: selectedIds, onChange: setSelectedIds }}
                filters={
                  <div className="flex flex-wrap items-center gap-2">
                    <div
                      role="group"
                      aria-label={translate('documents.filter.label')}
                      className="flex flex-wrap items-center gap-2"
                    >
                      {chips}
                    </div>
                    {selectedFolderId !== null && (
                      <label className="text-muted-foreground flex items-center gap-2 text-xs">
                        <Switch
                          checked={includeSubfolders}
                          onCheckedChange={(checked) => {
                            // One filter carries the answer and the other is cleared, because the
                            // API distinguishes "in this folder" from "anywhere beneath it". One
                            // navigation, not two — see Phase 3's note on `setFilters`.
                            setFilters({
                              underFolderId: checked ? selectedFolderId : '',
                              folderId: checked ? '' : selectedFolderId,
                            });
                          }}
                        />
                        {translate('documents.list.includeSubfolders')}
                      </label>
                    )}
                    {canCreate && selectedFolderId !== null && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setAdding('SCAN')}
                      >
                        {translate('documents.actions.scan')}
                      </Button>
                    )}
                  </div>
                }
                columns={columns}
              />
            </div>

            <div className="min-w-0 flex-[1_0_300px] lg:max-w-[340px]">
              <DocumentGlance
                row={shown}
                ownerName={shown === null ? null : (ownerNames[shown.ownerUserId] ?? null)}
              />
            </div>
          </div>
        </WorkspacePage>
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
    </div>
  );
}

/** No list the caller may read, so only the Status chip — the one that needs no lookup. */
const NO_FILTER_OPTIONS = { types: null, confidentiality: null, currentUserId: null } as const;
const NO_NAMES: Readonly<Record<string, string>> = {};

/**
 * The statuses a library row can be in, for the Status chip.
 *
 * `DELETED` and `PURGED` are not offered: a deleted document is reached through the list's own
 * "Show" filter and the recycle bin, and a purged one is not in any list at all.
 */
const LIBRARY_STATUSES: readonly DocumentStatusKey[] = Object.values(DocumentStatus).filter(
  (status) => status !== DocumentStatus.DELETED && status !== DocumentStatus.PURGED,
);

/**
 * What kind of file this is — shown now only while the file is still being checked (Docs v2).
 *
 * The format's own label rather than an icon, because a grid of mostly-blank thumbnail cells reads
 * worse than a grid of legible labels.
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
