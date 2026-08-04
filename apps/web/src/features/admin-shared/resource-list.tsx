'use client';

import { type ReactNode, useState } from 'react';

import {
  Badge,
  Button,
  type ColumnDef,
  DataGrid,
  type DataGridLabels,
  type DataGridState,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  Input,
  Pagination,
  Select,
  Toolbar,
  useToast,
} from '@munaxa/ui';

import type { DeletedFilter } from '@edms/contracts';
import type { MessageKey } from '@edms/i18n';

import { useTranslate } from '../../app/providers';
import type { ActionResult } from '../../lib/admin/action-result';
import type { ListState } from '../../lib/admin/list-state';
import { useListNavigation } from './list-url';

/**
 * One administered list: toolbar, grid, row menu, and the two confirmations.
 *
 * Every area of Administration lists records that are searched, sorted, paged, filtered, soft
 * deleted and restored, and every one of them shows a recycle bin. This is that behaviour once.
 *
 * What it deliberately does **not** own is forms. A company's form is two fields and a workflow's
 * is a stage editor; a component that tried to describe both would either constrain the second or
 * become a form framework. Each screen composes its own dialogue and hands the create and edit
 * affordances in as callbacks — so the shared piece is the part that is genuinely the same.
 *
 * `deleteBlocked` is why the row menu is here rather than assembled per screen. A confidentiality
 * level in use by a document type cannot be removed, and the honest way to say so is a disabled
 * item with the reason on it, not an action that fails when used.
 */
export interface ResourceListProps<TRow> {
  readonly rows: readonly TRow[];
  readonly total: number;
  readonly state: ListState;
  readonly columns: readonly ColumnDef<TRow>[];
  readonly getRowId: (row: TRow) => string;
  /** What the confirmations name, and what a screen reader announces for the row. */
  readonly getRowName: (row: TRow) => string;
  readonly isDeleted: (row: TRow) => boolean;
  /**
   * Opens the create form. Absent on a list nothing is added to directly — the permission
   * catalogue, which the product defines and no tenant edits.
   */
  readonly onCreate?: (() => void) | undefined;
  readonly onEdit?: ((row: TRow) => void) | undefined;
  readonly onDelete: (row: TRow) => Promise<ActionResult>;
  readonly onRestore: (row: TRow) => Promise<ActionResult>;
  /** A reason this row cannot be removed, or null when it can. */
  readonly deleteBlocked?: ((row: TRow) => string | null) | undefined;
  /** Actions beyond edit, delete and restore — publish a workflow, set a password, move a folder. */
  readonly extraActions?: ((row: TRow) => readonly RowAction[]) | undefined;
  /** Rendered in the toolbar, before the search box: the resource's own filters. */
  readonly filters?: ReactNode;
  /** Opening a row — the folder tree inside a library, the versions of a workflow. */
  readonly onRowActivate?: ((row: TRow) => void) | undefined;
  readonly searchPlaceholderKey?: MessageKey;
  readonly rowHeight?: number;
}

export interface RowAction {
  readonly id: string;
  readonly label: string;
  readonly onSelect: () => void;
  readonly destructive?: boolean;
  /** Present when the action is unavailable; shown instead of doing nothing on a click. */
  readonly disabledReason?: string | null;
}

const DELETED_FILTERS: readonly DeletedFilter[] = ['live', 'deleted', 'all'];

export function ResourceList<TRow>({
  rows,
  total,
  state,
  columns,
  getRowId,
  getRowName,
  isDeleted,
  onCreate,
  onEdit,
  onDelete,
  onRestore,
  deleteBlocked,
  extraActions,
  filters,
  onRowActivate,
  searchPlaceholderKey = 'admin.list.searchPlaceholder',
  rowHeight,
}: ResourceListProps<TRow>): ReactNode {
  const translate = useTranslate();
  const toast = useToast();
  const { pending, apply, refresh } = useListNavigation(state);

  // Column visibility and dragged widths are the reader's view of the table, not a description of
  // which rows matter. They stay local: putting them in the URL would make every shared link carry
  // one person's column preferences.
  const [view, setView] = useState<Pick<DataGridState, 'hiddenColumns' | 'columnWidths'>>({
    hiddenColumns: [],
    columnWidths: {},
  });
  const [confirming, setConfirming] = useState<{ row: TRow; kind: 'delete' | 'restore' } | null>(
    null,
  );
  const [working, setWorking] = useState(false);

  const gridState: DataGridState = {
    sort: state.sortBy === null ? null : { columnId: state.sortBy, direction: state.sortDirection },
    search: state.search,
    page: state.page,
    pageSize: state.pageSize,
    ...view,
  };

  const pageCount = Math.max(1, Math.ceil(total / state.pageSize));

  async function run(row: TRow, kind: 'delete' | 'restore'): Promise<void> {
    setWorking(true);
    const result = await (kind === 'delete' ? onDelete(row) : onRestore(row));
    setWorking(false);
    if (result.ok) {
      setConfirming(null);
      // The list is server-rendered, so the row's disappearance comes from re-running the request
      // rather than from editing an array here. One source of truth for what the page shows.
      refresh();
      return;
    }
    // The dialogue stays open on failure. A version conflict is fixed by reloading and looking
    // again, and closing the dialogue would hide the sentence that says so.
    toast.error(result.detail ?? translate(`error.${result.code}`));
  }

  const labels: DataGridLabels = {
    search: translate('admin.list.search'),
    searchPlaceholder: translate(searchPlaceholderKey),
    columns: translate('admin.list.columns'),
    selectAll: translate('admin.grid.selectAll'),
    selectRow: (label) => translate('admin.grid.selectRow', { name: label }),
    sortedAscending: translate('admin.grid.sortedAscending'),
    sortedDescending: translate('admin.grid.sortedDescending'),
    notSorted: translate('admin.grid.notSorted'),
    resizeColumn: (label) => translate('admin.grid.resizeColumn', { name: label }),
    rowCount: (count) => translate('admin.grid.rowCount', { count }),
    loading: translate('admin.list.loading'),
    empty: translate('admin.list.empty'),
    actions: translate('admin.actions.rowActions'),
  };

  return (
    <>
      <Toolbar label={translate('admin.list.search')}>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="search"
            defaultValue={state.search}
            aria-label={translate('admin.list.search')}
            placeholder={translate(searchPlaceholderKey)}
            className="w-56"
            // Committed on Enter and on blur rather than per keystroke. Each change is a navigation
            // and a server render; searching on every letter would queue a request per letter and
            // show the answer to a prefix the reader has already moved past.
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                apply({ search: event.currentTarget.value.trim() });
              }
            }}
            onBlur={(event) => {
              if (event.currentTarget.value.trim() !== state.search) {
                apply({ search: event.currentTarget.value.trim() });
              }
            }}
          />
          <Select
            value={state.deleted}
            aria-label={translate('admin.list.show')}
            className="w-40"
            onChange={(event) => {
              apply({ deleted: event.currentTarget.value as DeletedFilter });
            }}
          >
            {DELETED_FILTERS.map((filter) => (
              <option key={filter} value={filter}>
                {translate(DELETED_FILTER_LABELS[filter])}
              </option>
            ))}
          </Select>
          {filters}
        </div>
        {onCreate === undefined ? null : (
          <Button type="button" onClick={onCreate}>
            {translate('admin.actions.create')}
          </Button>
        )}
      </Toolbar>

      <DataGrid<TRow>
        rows={[...rows]}
        columns={[...columns]}
        getRowId={getRowId}
        getRowLabel={getRowName}
        mode="server"
        rowCount={total}
        state={gridState}
        onStateChange={(next) => {
          setView({ hiddenColumns: next.hiddenColumns, columnWidths: next.columnWidths });
          if (
            next.sort?.columnId !== state.sortBy ||
            next.sort?.direction !== state.sortDirection
          ) {
            apply(
              next.sort === null
                ? { sortBy: null }
                : { sortBy: next.sort.columnId, sortDirection: next.sort.direction },
            );
          }
        }}
        // The grid's own search and pagination are off: both are server state here, and the toolbar
        // above and the control below own them so their labels can be translated.
        searchable={false}
        paginated={false}
        columnMenu
        loading={pending}
        labels={labels}
        {...(rowHeight !== undefined && { rowHeight })}
        {...(onRowActivate !== undefined && { onRowActivate })}
        aria-label={translate('admin.title')}
        emptyState={
          <EmptyState
            title={translate(state.search === '' ? 'admin.list.empty' : 'admin.list.emptySearch')}
            description={translate(
              state.search === '' ? 'admin.list.emptyHint' : 'admin.list.emptySearchHint',
            )}
          />
        }
        rowActions={(row) => (
          <RowMenu
            actions={menuFor(row)}
            label={translate('admin.actions.rowActions')}
            disabled={working}
          />
        )}
      />

      <div className="flex items-center justify-between gap-4">
        <p className="text-muted-foreground text-sm">
          {translate('admin.list.count', { count: rows.length, total })}
        </p>
        <Pagination
          page={state.page}
          pageCount={pageCount}
          onPageChange={(page) => {
            apply({ page });
          }}
          labels={{
            nav: translate('admin.grid.pagination'),
            previous: translate('admin.grid.previousPage'),
            next: translate('admin.grid.nextPage'),
            page: translate('admin.grid.page'),
          }}
        />
      </div>

      {confirming === null ? null : (
        <Dialog
          open
          onClose={() => {
            if (!working) {
              setConfirming(null);
            }
          }}
          title={translate(
            confirming.kind === 'delete'
              ? 'admin.actions.confirmDelete'
              : 'admin.actions.confirmRestore',
            { name: getRowName(confirming.row) },
          )}
          description={translate(
            confirming.kind === 'delete'
              ? 'admin.actions.confirmDeleteHint'
              : 'admin.actions.confirmRestoreHint',
          )}
          footer={
            <>
              <Button
                type="button"
                variant="outline"
                disabled={working}
                onClick={() => {
                  setConfirming(null);
                }}
              >
                {translate('admin.actions.cancel')}
              </Button>
              <Button
                type="button"
                variant={confirming.kind === 'delete' ? 'destructive' : 'default'}
                disabled={working}
                onClick={() => {
                  void run(confirming.row, confirming.kind);
                }}
              >
                {translate(
                  confirming.kind === 'delete' ? 'admin.actions.delete' : 'admin.actions.restore',
                )}
              </Button>
            </>
          }
        />
      )}
    </>
  );

  function menuFor(row: TRow): readonly RowAction[] {
    if (isDeleted(row)) {
      return [
        {
          id: 'restore',
          label: translate('admin.actions.restore'),
          onSelect: () => {
            setConfirming({ row, kind: 'restore' });
          },
        },
      ];
    }

    const blocked = deleteBlocked?.(row) ?? null;
    return [
      ...(onEdit === undefined
        ? []
        : [
            {
              id: 'edit',
              label: translate('admin.actions.edit'),
              onSelect: () => {
                onEdit(row);
              },
            },
          ]),
      ...(extraActions?.(row) ?? []),
      {
        id: 'delete',
        label: translate('admin.actions.delete'),
        destructive: true,
        disabledReason: blocked,
        onSelect: () => {
          setConfirming({ row, kind: 'delete' });
        },
      },
    ];
  }
}

const DELETED_FILTER_LABELS: Readonly<Record<DeletedFilter, MessageKey>> = {
  live: 'admin.list.showLive',
  deleted: 'admin.list.showDeleted',
  all: 'admin.list.showAll',
};

/**
 * The row's actions.
 *
 * A blocked action is rendered and disabled with its reason as the accessible description, rather
 * than omitted. An action that disappears leaves somebody looking for it; one that says why it
 * cannot be used tells them what to change.
 */
function RowMenu({
  actions,
  label,
  disabled,
}: {
  actions: readonly RowAction[];
  label: string;
  disabled: boolean;
}): ReactNode {
  if (actions.length === 0) {
    return null;
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon" aria-label={label} disabled={disabled}>
          <span aria-hidden>⋯</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {actions.map((action) => {
          const unavailable = action.disabledReason !== undefined && action.disabledReason !== null;
          return (
            <DropdownMenuItem
              key={action.id}
              disabled={unavailable}
              {...(action.destructive === true && { destructive: true })}
              {...(unavailable && { title: action.disabledReason ?? undefined })}
              onSelect={() => {
                if (!unavailable) {
                  action.onSelect();
                }
              }}
            >
              {action.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A short badge column for a row's lifecycle state, shared by every list that has one. */
export function StateBadges({
  deleted,
  system,
  inactive,
}: {
  deleted: boolean;
  system?: boolean;
  inactive?: boolean;
}): ReactNode {
  const translate = useTranslate();
  return (
    <span className="flex flex-wrap gap-1">
      {deleted ? <Badge tone="danger">{translate('admin.list.deletedBadge')}</Badge> : null}
      {system === true ? <Badge tone="muted">{translate('admin.list.systemBadge')}</Badge> : null}
      {inactive === true ? (
        <Badge tone="warning">{translate('admin.list.inactiveBadge')}</Badge>
      ) : null}
    </span>
  );
}
