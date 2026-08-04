'use client';

import { type ReactNode, useState } from 'react';

import type { Category } from '@edms/contracts';

import { useTranslate } from '../../app/providers';
import type { ListState } from '../../lib/admin/list-state';
import {
  AdminScreen,
  type Choice,
  FormDialog,
  PickerField,
  ResourceList,
  TextAreaField,
  TextField,
  changedFields,
  isEmptyPatch,
  nullableText,
  text,
  unchanged,
  useAdminColumns,
  useListNavigation,
} from '../admin-shared';
import {
  createCategory,
  deleteCategory,
  moveCategory,
  restoreCategory,
  updateCategory,
} from './actions';

export const CATEGORY_SORT_FIELDS = ['createdAt', 'updatedAt', 'name', 'code', 'path'] as const;

/**
 * Categories — business classification, independent of where a document is filed.
 *
 * The independence is the point of the screen's description: a document lives in exactly one folder
 * and can be classified without reference to it, so "Policies" is a category rather than a folder
 * somebody has to file into. Categories nest, so the same path arithmetic and the same separate move
 * action apply as for departments.
 */
export function CategoriesScreen({
  rows,
  total,
  state,
  parents,
}: {
  rows: readonly Category[];
  total: number;
  state: ListState;
  parents: readonly Choice[];
}): ReactNode {
  const translate = useTranslate();
  const column = useAdminColumns<Category>();
  const { refresh } = useListNavigation(state);
  const [editing, setEditing] = useState<Category | null | undefined>(undefined);
  const [moving, setMoving] = useState<Category | null>(null);

  return (
    <AdminScreen titleKey="admin.categories.title" descriptionKey="admin.categories.description">
      <ResourceList<Category>
        rows={rows}
        total={total}
        state={state}
        getRowId={(row) => row.id}
        getRowName={(row) => row.name}
        isDeleted={(row) => row.deletedAt !== null}
        onCreate={() => {
          setEditing(null);
        }}
        onEdit={setEditing}
        onDelete={(row) => deleteCategory(row.id, row.version)}
        onRestore={(row) => restoreCategory(row.id, row.version)}
        deleteBlocked={(row) =>
          row.childCount === 0
            ? null
            : translate('admin.list.inUseByChildren', { count: row.childCount })
        }
        extraActions={(row) => [
          {
            id: 'move',
            label: translate('admin.actions.move'),
            onSelect: () => {
              setMoving(row);
            },
          },
        ]}
        columns={[
          {
            id: 'name',
            header: translate('admin.fields.name'),
            sortable: true,
            rowHeader: true,
            value: (row) => `${' '.repeat((row.depth - 1) * 2)}${row.name}`,
          },
          {
            id: 'code',
            header: translate('admin.fields.code'),
            width: 140,
            sortable: true,
            value: (row) => row.code,
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
            { name: translate('admin.categories.one') },
          )}
          onClose={() => {
            setEditing(undefined);
          }}
          onSaved={refresh}
          onSubmit={(data) => {
            if (editing === null) {
              return createCategory({
                code: text(data, 'code'),
                name: text(data, 'name'),
                parentId: text(data, 'parentId') === '' ? null : text(data, 'parentId'),
                ...(text(data, 'description') !== '' && {
                  description: text(data, 'description'),
                }),
              });
            }
            // `parentId` stays out of the patch: re-parenting is the move action.
            const patch = changedFields(editing, {
              code: text(data, 'code'),
              name: text(data, 'name'),
              description: nullableText(data, 'description'),
            });
            return isEmptyPatch(patch)
              ? unchanged()
              : updateCategory(editing.id, editing.version, patch);
          }}
        >
          <TextField
            name="code"
            label={translate('admin.fields.code')}
            hint={translate('admin.fields.codeHint')}
            defaultValue={editing?.code}
            maxLength={16}
            required
          />
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
              hint={translate('admin.fields.noParent')}
              options={parents.map((parent) => ({ value: parent.value, label: parent.label }))}
              clearable
            />
          ) : null}
          <TextAreaField
            name="description"
            label={translate('admin.fields.description')}
            defaultValue={editing?.description ?? ''}
          />
        </FormDialog>
      )}

      {moving === null ? null : (
        <FormDialog
          open
          title={translate('admin.departments.moveTitle', { name: moving.name })}
          submitLabel={translate('admin.actions.move')}
          onClose={() => {
            setMoving(null);
          }}
          onSaved={refresh}
          onSubmit={(data) => {
            const parentId = text(data, 'parentId');
            return moveCategory(moving.id, moving.version, {
              parentId: parentId === '' ? null : parentId,
            });
          }}
        >
          <PickerField
            name="parentId"
            label={translate('admin.fields.parent')}
            hint={translate('admin.fields.noParent')}
            options={parents
              .filter((parent) => parent.value !== moving.id)
              .map((parent) => ({ value: parent.value, label: parent.label }))}
            defaultValue={moving.parentId ?? ''}
            clearable
          />
        </FormDialog>
      )}
    </AdminScreen>
  );
}
