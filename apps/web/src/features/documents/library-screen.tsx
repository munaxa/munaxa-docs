'use client';

import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import { type ReactNode, useState } from 'react';

import { Badge, Button, Switch, formatFileSize, useToast } from '@munaxa/ui';

import type { DocumentSummary, Folder, Library } from '@edms/contracts';
import { formatFor } from '@edms/domain';

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
import { FolderTree } from './folder-tree';
import { type DocumentTypeChoice, UploadDialog } from './upload-dialog';

export const DOCUMENT_SORT_FIELDS = ['createdAt', 'updatedAt', 'title', 'status'] as const;
export const DOCUMENT_FILTER_KEYS = [
  'libraryId',
  'folderId',
  'underFolderId',
  'documentTypeId',
  'categoryId',
  'confidentialityId',
  'status',
  'favorite',
] as const;

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
}): ReactNode {
  const translate = useTranslate();
  const router = useRouter();
  const toast = useToast();
  const column = useAdminColumns<DocumentSummary>();
  const { refresh, setFilter } = useListNavigation(state);
  const run = useAction(state);
  const [adding, setAdding] = useState<'UPLOAD' | 'SCAN' | null>(null);

  const includeSubfolders = state.filters.underFolderId !== undefined;

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
          onRowActivate={(row) => {
            router.push(`/documents/${row.id}` as Route);
          }}
          onCreate={canCreate && selectedFolderId !== null ? () => setAdding('UPLOAD') : undefined}
          onDelete={(row) => deleteDocument(row.id, row.version)}
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
              cell: (row) => (
                <div className="flex min-w-0 items-center gap-2">
                  <FormatBadge row={row} />
                  <span className="truncate">{row.title}</span>
                  {row.isFavorite && (
                    <span aria-label={translate('documents.actions.favorite')}>★</span>
                  )}
                </div>
              ),
              sortable: true,
            },
            {
              id: 'documentNumber',
              header: translate('documents.column.number'),
              // Null until approval, and shown as a dash rather than blank so the column reads as
              // "not yet" instead of "missing".
              cell: (row) => row.documentNumber ?? '—',
            },
            {
              id: 'status',
              header: translate('documents.column.status'),
              cell: (row) => <Badge>{translate(`documents.status.${row.status}`)}</Badge>,
              sortable: true,
            },
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
            },
            column.state(),
            column.updated(),
          ]}
        />
      </section>

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
    </div>
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
