'use client';

import { type ReactNode, useState } from 'react';

import { Select } from '@munaxa/ui';

import type { Entity } from '@edms/contracts';

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
  nullableText,
  text,
  unchanged,
  useAdminColumns,
  useListNavigation,
} from '../admin-shared';
import { createEntity, deleteEntity, restoreEntity, updateEntity } from './actions';

/**
 * Entities — the legal and operating units branches and departments hang from.
 *
 * The company is chosen once and then shown read-only, because the API has no way to change it and
 * that is deliberate: moving an entity would move every branch, department and library under it into
 * another permission chain, silently. The form says so rather than offering a control that fails.
 */
export function EntitiesScreen({
  rows,
  total,
  state,
  companies,
}: {
  rows: readonly Entity[];
  total: number;
  state: ListState;
  companies: readonly Choice[];
}): ReactNode {
  const translate = useTranslate();
  const column = useAdminColumns<Entity>();
  const { refresh, setFilter } = useListNavigation(state);
  const [editing, setEditing] = useState<Entity | null | undefined>(undefined);

  return (
    <AdminScreen titleKey="admin.entities.title" descriptionKey="admin.entities.description">
      {companies.length === 0 ? <Prerequisite nameKey="admin.companies.one" /> : null}
      <ResourceList<Entity>
        rows={rows}
        total={total}
        state={state}
        getRowId={(row) => row.id}
        getRowName={(row) => row.name}
        isDeleted={(row) => row.deletedAt !== null}
        onCreate={
          companies.length === 0
            ? undefined
            : () => {
                setEditing(null);
              }
        }
        onEdit={setEditing}
        onDelete={(row) => deleteEntity(row.id, row.version)}
        onRestore={(row) => restoreEntity(row.id, row.version)}
        deleteBlocked={(row) => {
          const inside = row.branchCount + row.departmentCount;
          return inside === 0 ? null : translate('admin.list.inUseByChildren', { count: inside });
        }}
        filters={
          <Select
            value={state.filters.companyId ?? ''}
            aria-label={translate('admin.fields.company')}
            className="w-48"
            onChange={(event) => {
              setFilter('companyId', event.currentTarget.value);
            }}
          >
            <option value="">{translate('admin.list.filterAny')}</option>
            {companies.map((company) => (
              <option key={company.value} value={company.value}>
                {company.label}
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
            id: 'legalName',
            header: translate('admin.fields.legalName'),
            defaultHidden: true,
            value: (row) => row.legalName ?? '',
          },
          {
            id: 'companyName',
            header: translate('admin.fields.company'),
            width: 180,
            value: (row) => row.companyName,
          },
          column.count('branchCount', 'admin.fields.branch', (row) => row.branchCount),
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
            { name: translate('admin.entities.one') },
          )}
          onClose={() => {
            setEditing(undefined);
          }}
          onSaved={refresh}
          onSubmit={(data) => {
            if (editing === null) {
              return createEntity({
                companyId: text(data, 'companyId'),
                code: text(data, 'code'),
                name: text(data, 'name'),
                // Absent rather than null on create: the schema takes `legalName` as optional there,
                // and a null would be a value the create shape does not describe.
                ...(text(data, 'legalName') !== '' && { legalName: text(data, 'legalName') }),
              });
            }
            const patch = changedFields(editing, {
              code: text(data, 'code'),
              name: text(data, 'name'),
              legalName: nullableText(data, 'legalName'),
            });
            return isEmptyPatch(patch)
              ? unchanged()
              : updateEntity(editing.id, editing.version, patch);
          }}
        >
          {editing === null ? (
            <PickerField
              name="companyId"
              label={translate('admin.fields.company')}
              options={companies.map((company) => ({
                value: company.value,
                label: company.label,
              }))}
              required
            />
          ) : (
            <TextField
              name="companyName"
              label={translate('admin.fields.company')}
              hint={translate('admin.entities.companyFixed')}
              defaultValue={editing.companyName}
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
          <TextField
            name="legalName"
            label={translate('admin.fields.legalName')}
            defaultValue={editing?.legalName ?? ''}
            maxLength={200}
          />
        </FormDialog>
      )}
    </AdminScreen>
  );
}
