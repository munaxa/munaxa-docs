'use client';

import { type ReactNode, useState } from 'react';

import { Select } from '@munaxa/ui';

import type { Department } from '@edms/contracts';

import { useTranslate } from '../../app/providers';
import type { ListState } from '../../lib/admin/list-state';
import {
  AdminScreen,
  type Choice,
  FormDialog,
  PickerField,
  Prerequisite,
  ResourceList,
  TextField,
  changedFields,
  isEmptyPatch,
  text,
  unchanged,
  useAdminColumns,
  useListNavigation,
} from '../admin-shared';
import {
  createDepartment,
  deleteDepartment,
  moveDepartment,
  restoreDepartment,
  updateDepartment,
} from './actions';

/**
 * Departments — the nesting tree permission is actually granted on.
 *
 * Two things here are unlike the other three scope screens. The list is sorted by `path` by default,
 * because a tree read in name order is not a tree; and moving a department is its own action with its
 * own confirmation, because a move rewrites the ancestry of everything underneath and every
 * permission granted along the old chain stops applying.
 */
export function DepartmentsScreen({
  rows,
  total,
  state,
  entities,
  branches,
  parents,
}: {
  rows: readonly Department[];
  total: number;
  state: ListState;
  entities: readonly Choice[];
  branches: readonly Choice[];
  /** Candidate parents, already narrowed to live departments. */
  parents: readonly Choice[];
}): ReactNode {
  const translate = useTranslate();
  const column = useAdminColumns<Department>();
  const { refresh, setFilter } = useListNavigation(state);
  const [editing, setEditing] = useState<Department | null | undefined>(undefined);
  const [moving, setMoving] = useState<Department | null>(null);

  /**
   * The indent is derived from `depth`, which the API sends, rather than from counting separators in
   * the path here. The separator is load-bearing arithmetic in the domain and re-deriving it in a
   * component is how the two come to disagree.
   */
  const indented = (row: Department): string => `${' '.repeat((row.depth - 1) * 2)}${row.name}`;

  return (
    <AdminScreen titleKey="admin.departments.title" descriptionKey="admin.departments.description">
      {entities.length === 0 ? <Prerequisite nameKey="admin.entities.one" /> : null}
      <ResourceList<Department>
        rows={rows}
        total={total}
        state={state}
        getRowId={(row) => row.id}
        getRowName={(row) => row.name}
        isDeleted={(row) => row.deletedAt !== null}
        onCreate={
          entities.length === 0
            ? undefined
            : () => {
                setEditing(null);
              }
        }
        onEdit={setEditing}
        onDelete={(row) => deleteDepartment(row.id, row.version)}
        onRestore={(row) => restoreDepartment(row.id, row.version)}
        deleteBlocked={(row) => {
          const inside = row.childCount + row.memberCount;
          return inside === 0 ? null : translate('admin.list.inUseByChildren', { count: inside });
        }}
        extraActions={(row) => [
          {
            id: 'move',
            label: translate('admin.actions.move'),
            onSelect: () => {
              setMoving(row);
            },
          },
        ]}
        filters={
          <>
            <Select
              value={state.filters.entityId ?? ''}
              aria-label={translate('admin.fields.entity')}
              className="w-44"
              onChange={(event) => {
                setFilter('entityId', event.currentTarget.value);
              }}
            >
              <option value="">{translate('admin.list.filterAny')}</option>
              {entities.map((entity) => (
                <option key={entity.value} value={entity.value}>
                  {entity.label}
                </option>
              ))}
            </Select>
            <Select
              value={state.filters.branchId ?? ''}
              aria-label={translate('admin.fields.branch')}
              className="w-44"
              onChange={(event) => {
                setFilter('branchId', event.currentTarget.value);
              }}
            >
              <option value="">{translate('admin.list.filterAny')}</option>
              {branches.map((branch) => (
                <option key={branch.value} value={branch.value}>
                  {branch.label}
                </option>
              ))}
            </Select>
          </>
        }
        columns={[
          {
            id: 'name',
            header: translate('admin.fields.name'),
            sortable: true,
            rowHeader: true,
            value: (row) => indented(row),
          },
          {
            id: 'code',
            header: translate('admin.fields.code'),
            width: 120,
            sortable: true,
            value: (row) => row.code,
          },
          {
            id: 'entityName',
            header: translate('admin.fields.entity'),
            width: 160,
            value: (row) => row.entityName,
          },
          {
            id: 'branchName',
            header: translate('admin.fields.branch'),
            width: 160,
            defaultHidden: true,
            value: (row) => row.branchName ?? '',
          },
          column.count('memberCount', 'admin.departments.members', (row) => row.memberCount),
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
            { name: translate('admin.departments.one') },
          )}
          onClose={() => {
            setEditing(undefined);
          }}
          onSaved={refresh}
          onSubmit={(data) => {
            if (editing === null) {
              return createDepartment({
                entityId: text(data, 'entityId'),
                code: text(data, 'code'),
                name: text(data, 'name'),
                parentId: text(data, 'parentId') === '' ? null : text(data, 'parentId'),
                branchId: text(data, 'branchId') === '' ? null : text(data, 'branchId'),
              });
            }
            // `parentId` is deliberately absent from this patch. Changing a parent is a move, and a
            // move has its own action, its own confirmation and its own audit event.
            const patch = changedFields(editing, {
              code: text(data, 'code'),
              name: text(data, 'name'),
              branchId: text(data, 'branchId') === '' ? null : text(data, 'branchId'),
            });
            return isEmptyPatch(patch)
              ? unchanged()
              : updateDepartment(editing.id, editing.version, patch);
          }}
        >
          {editing === null ? (
            <PickerField
              name="entityId"
              label={translate('admin.fields.entity')}
              options={entities.map((entity) => ({ value: entity.value, label: entity.label }))}
              required
            />
          ) : (
            <TextField
              name="entityName"
              label={translate('admin.fields.entity')}
              hint={translate('admin.departments.entityFixed')}
              defaultValue={editing.entityName}
              readOnly
            />
          )}
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
          <PickerField
            name="branchId"
            label={translate('admin.fields.branch')}
            options={branches.map((branch) => ({ value: branch.value, label: branch.label }))}
            defaultValue={editing?.branchId ?? ''}
            clearable
          />
        </FormDialog>
      )}

      {moving === null ? null : (
        <FormDialog
          open
          title={translate('admin.departments.moveTitle', { name: moving.name })}
          description={translate('admin.departments.moveHint')}
          submitLabel={translate('admin.actions.move')}
          onClose={() => {
            setMoving(null);
          }}
          onSaved={refresh}
          onSubmit={(data) => {
            const parentId = text(data, 'parentId');
            return moveDepartment(moving.id, moving.version, {
              parentId: parentId === '' ? null : parentId,
            });
          }}
        >
          <PickerField
            name="parentId"
            label={translate('admin.fields.parent')}
            hint={translate('admin.fields.noParent')}
            // Itself excluded. Its own descendants cannot be excluded here without the subtree, and
            // the API refuses those with a sentence of their own — which is the check that matters,
            // since a stale list in a browser cannot be the thing protecting the tree.
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
