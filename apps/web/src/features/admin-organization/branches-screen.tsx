'use client';

import { type ReactNode, useState } from 'react';

import { Select } from '@munaxa/ui';

import type { Branch } from '@edms/contracts';

import { useTranslate } from '../../app/providers';
import type { ListState } from '../../lib/admin/list-state';
import {
  AdminScreen,
  type Choice,
  FormDialog,
  PickerField,
  Prerequisite,
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
import { createBranch, deleteBranch, restoreBranch, updateBranch } from './actions';

export const BRANCH_SORT_FIELDS = ['createdAt', 'updatedAt', 'name', 'code'] as const;
export const BRANCH_FILTER_KEYS = ['entityId'] as const;

/**
 * Branches — locations.
 *
 * The description on the screen is the important part of this area, because the name misleads: a
 * branch's code appears in document numbers, but no permission flows through it. Somebody expecting
 * to grant access "to the Amman branch" needs to be told that here, not after granting it.
 */
export function BranchesScreen({
  rows,
  total,
  state,
  entities,
}: {
  rows: readonly Branch[];
  total: number;
  state: ListState;
  entities: readonly Choice[];
}): ReactNode {
  const translate = useTranslate();
  const column = useAdminColumns<Branch>();
  const { refresh, setFilter } = useListNavigation(state);
  const [editing, setEditing] = useState<Branch | null | undefined>(undefined);

  return (
    <AdminScreen titleKey="admin.branches.title" descriptionKey="admin.branches.description">
      {entities.length === 0 ? <Prerequisite nameKey="admin.entities.one" /> : null}
      <ResourceList<Branch>
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
        onDelete={(row) => deleteBranch(row.id, row.version)}
        onRestore={(row) => restoreBranch(row.id, row.version)}
        deleteBlocked={(row) =>
          row.departmentCount === 0
            ? null
            : translate('admin.list.inUseByChildren', { count: row.departmentCount })
        }
        filters={
          <Select
            value={state.filters.entityId ?? ''}
            aria-label={translate('admin.fields.entity')}
            className="w-48"
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
        }
        columns={[
          {
            id: 'code',
            header: translate('admin.fields.code'),
            width: 120,
            sortable: true,
            value: (row) => row.code,
          },
          {
            id: 'name',
            header: translate('admin.fields.name'),
            sortable: true,
            rowHeader: true,
            value: (row) => row.name,
          },
          {
            id: 'entityName',
            header: translate('admin.fields.entity'),
            width: 180,
            value: (row) => row.entityName,
          },
          {
            id: 'address',
            header: translate('admin.fields.address'),
            defaultHidden: true,
            value: (row) => row.address ?? '',
          },
          column.count('departmentCount', 'admin.departments.title', (row) => row.departmentCount),
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
            { name: translate('admin.branches.one') },
          )}
          onClose={() => {
            setEditing(undefined);
          }}
          onSaved={refresh}
          onSubmit={(data) => {
            if (editing === null) {
              return createBranch({
                entityId: text(data, 'entityId'),
                code: text(data, 'code'),
                name: text(data, 'name'),
                ...(text(data, 'address') !== '' && { address: text(data, 'address') }),
              });
            }
            const patch = changedFields(editing, {
              code: text(data, 'code'),
              name: text(data, 'name'),
              address: nullableText(data, 'address'),
            });
            return isEmptyPatch(patch)
              ? unchanged()
              : updateBranch(editing.id, editing.version, patch);
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
              hint={translate('admin.branches.entityFixed')}
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
          <TextAreaField
            name="address"
            label={translate('admin.fields.address')}
            defaultValue={editing?.address ?? ''}
          />
        </FormDialog>
      )}
    </AdminScreen>
  );
}
