'use client';

import { type ReactNode, useState } from 'react';

import { Badge } from '@munaxa/ui';

import type { Folder, Library } from '@edms/contracts';

import { useTranslate } from '../../app/providers';
import type { ListState } from '../../lib/admin/list-state';
import {
  AdminScreen,
  FormDialog,
  PickerField,
  ResourceList,
  SwitchField,
  TextAreaField,
  TextField,
  changedFields,
  flag,
  isEmptyPatch,
  nullableText,
  optionalText,
  text,
  unchanged,
  useAdminColumns,
  useListNavigation,
} from '../admin-shared';
import { createFolder, deleteFolder, moveFolder, restoreFolder, updateFolder } from './actions';

/**
 * The folder tree inside one library.
 *
 * Three rules make this screen different from the other trees. The root folder was created with the
 * library and cannot be moved, renamed away or removed — it is where the library's own permissions
 * attach. Deleting a folder takes everything inside it, and restoring brings back exactly that
 * subtree rather than everything currently deleted underneath. And turning off inheritance restricts a
 * subtree without hiding it from administrators: administrative permissions are exempt, or somebody
 * could hide a subtree from the people accountable for it
 * (`docs/architecture/08-permission-model.md` §3).
 */
export function FoldersScreen({
  library,
  rows,
  total,
  state,
  folders,
}: {
  library: Library;
  rows: readonly Folder[];
  total: number;
  state: ListState;
  /** Candidate parents — every live folder in this library, root included. */
  folders: readonly { readonly value: string; readonly label: string }[];
}): ReactNode {
  const translate = useTranslate();
  const column = useAdminColumns<Folder>();
  const { refresh } = useListNavigation(state);
  const [editing, setEditing] = useState<Folder | null | undefined>(undefined);
  const [moving, setMoving] = useState<Folder | null>(null);

  return (
    <AdminScreen titleKey="admin.folders.title" descriptionKey="admin.folders.description">
      <p className="text-muted-foreground text-sm">
        {library.name} ({library.code})
      </p>

      <ResourceList<Folder>
        rows={rows}
        total={total}
        state={state}
        rowHeight={52}
        getRowId={(row) => row.id}
        getRowName={(row) => row.name}
        isDeleted={(row) => row.deletedAt !== null}
        onCreate={() => {
          setEditing(null);
        }}
        onEdit={setEditing}
        onDelete={(row) => deleteFolder(row.id, row.version)}
        onRestore={(row) => restoreFolder(row.id, row.version)}
        deleteBlocked={(row) => (row.isRoot ? translate('admin.folders.rootImmutable') : null)}
        extraActions={(row) =>
          row.isRoot
            ? [
                {
                  id: 'move',
                  label: translate('admin.actions.move'),
                  disabledReason: translate('admin.folders.rootImmutable'),
                  onSelect: () => {
                    // Never reached: the item is disabled. Present so the reason is visible.
                  },
                },
              ]
            : [
                {
                  id: 'move',
                  label: translate('admin.actions.move'),
                  onSelect: () => {
                    setMoving(row);
                  },
                },
              ]
        }
        columns={[
          {
            id: 'name',
            header: translate('admin.fields.name'),
            sortable: true,
            rowHeader: true,
            multiline: true,
            value: (row) => `${' '.repeat((row.depth - 1) * 2)}${row.name}`,
            cell: (row) => (
              <span className="flex items-center gap-2">
                <span style={{ paddingInlineStart: `${String((row.depth - 1) * 12)}px` }}>
                  {row.name}
                </span>
                {row.isRoot ? (
                  <Badge tone="muted">{translate('admin.folders.rootBadge')}</Badge>
                ) : null}
                {row.inheritAcl ? null : (
                  <Badge tone="warning">{translate('admin.folders.inheritAcl')}</Badge>
                )}
              </span>
            ),
          },
          {
            id: 'description',
            header: translate('admin.fields.description'),
            defaultHidden: true,
            value: (row) => row.description ?? '',
          },
          column.count('childCount', 'admin.departments.children', (row) => row.childCount),
          column.state(),
          column.updated(),
          column.created(),
        ]}
      />

      {editing === undefined ? null : (
        <FormDialog
          open
          title={translate(
            editing === null ? 'admin.actions.createTitle' : 'admin.actions.editTitle',
            { name: translate('admin.folders.one') },
          )}
          description={
            editing !== null && editing.isRoot
              ? translate('admin.folders.rootImmutable')
              : undefined
          }
          onClose={() => {
            setEditing(undefined);
          }}
          onSaved={refresh}
          onSubmit={(data) => {
            if (editing === null) {
              return createFolder({
                libraryId: library.id,
                // Never null: a library has exactly one root, created with it, and the API refuses a
                // second. The default is that root, so "add a folder" means "add one at the top".
                parentId:
                  text(data, 'parentId') === '' ? library.rootFolderId : text(data, 'parentId'),
                name: text(data, 'name'),
                ...(optionalText(data, 'description') !== undefined && {
                  description: optionalText(data, 'description'),
                }),
                inheritAcl: flag(data, 'inheritAcl'),
              });
            }
            // No `inheritAcl` — Slice 33. Breaking a folder's inheritance is
            // `PUT /scopes/folder/{id}/inheritance` on the permissions screen, gated on
            // `document:permission:manage` rather than on this screen's `folder:manage`, and the
            // folder route no longer accepts the field. Sending it here would be stripped by the
            // schema and answered `200`, which on this flag is the worst of both.
            const patch = changedFields(editing, {
              name: text(data, 'name'),
              description: nullableText(data, 'description'),
            });
            return isEmptyPatch(patch)
              ? unchanged()
              : updateFolder(editing.id, editing.version, patch);
          }}
        >
          <TextField
            name="name"
            label={translate('admin.fields.name')}
            defaultValue={editing?.name}
            maxLength={200}
            required
          />
          {editing === null ? (
            <PickerField
              name="parentId"
              label={translate('admin.fields.parent')}
              options={folders.map((folder) => ({ value: folder.value, label: folder.label }))}
              defaultValue={library.rootFolderId}
              required
            />
          ) : null}
          <TextAreaField
            name="description"
            label={translate('admin.fields.description')}
            defaultValue={editing?.description ?? ''}
          />
          {/*
            Offered when creating and not when editing — Slice 33, and the same shape the parent
            picker above already has. A new folder may be created as a restricted subtree; changing
            an existing one retroactively hides content that is already in it, which is the
            operation ADR-0005 calls "the one most likely to hide content from the people
            accountable for it" and routes through the permissions screen instead. The list still
            badges a folder that does not inherit, so the flag stays visible here — it is only no
            longer settable.
          */}
          {editing === null ? (
            <SwitchField
              name="inheritAcl"
              label={translate('admin.folders.inheritAcl')}
              hint={translate('admin.folders.inheritAclHint')}
              defaultChecked
            />
          ) : null}
        </FormDialog>
      )}

      {moving === null ? null : (
        <FormDialog
          open
          title={translate('admin.departments.moveTitle', { name: moving.name })}
          description={translate('admin.folders.cascadeHint')}
          submitLabel={translate('admin.actions.move')}
          onClose={() => {
            setMoving(null);
          }}
          onSaved={refresh}
          onSubmit={(data) =>
            moveFolder(moving.id, moving.version, { parentId: text(data, 'parentId') })
          }
        >
          <PickerField
            name="parentId"
            label={translate('admin.fields.parent')}
            // Itself excluded. Its descendants are refused by the API with a reason of their own —
            // a stale list in a browser is not what protects the tree from a cycle.
            options={folders
              .filter((folder) => folder.value !== moving.id)
              .map((folder) => ({ value: folder.value, label: folder.label }))}
            defaultValue={moving.parentId ?? library.rootFolderId}
            required
          />
        </FormDialog>
      )}
    </AdminScreen>
  );
}
