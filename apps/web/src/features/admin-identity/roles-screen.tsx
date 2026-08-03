'use client';

import { type ReactNode, useState } from 'react';

import type { PermissionDescriptor, Role } from '@edms/contracts';
import type { PermissionKey } from '@edms/domain';

import { useTranslate } from '../../app/providers';
import type { ListState } from '../../lib/admin/list-state';
import {
  AdminScreen,
  FormDialog,
  ResourceList,
  TextAreaField,
  TextField,
  changedFields,
  isEmptyPatch,
  list,
  nullableText,
  text,
  unchanged,
  useAdminColumns,
  useListNavigation,
} from '../admin-shared';
import { createRole, deleteRole, restoreRole, updateRole } from './actions';
import { PermissionMatrix } from './permission-matrix';

export const ROLE_SORT_FIELDS = ['createdAt', 'updatedAt', 'name', 'key'] as const;

/**
 * Roles — named bundles of permissions.
 *
 * The one rule worth reading here is what a *built-in* role is. Its key is fixed, because the product
 * refers to the eight seeded roles by key, and it cannot be removed. Its name and its permissions are
 * ordinary tenant data: a tenant whose approvers must also publish edits the role rather than waiting
 * for a release (`docs/architecture/08-permission-model.md` §5).
 */
export function RolesScreen({
  rows,
  total,
  state,
  catalogue,
}: {
  rows: readonly Role[];
  total: number;
  state: ListState;
  catalogue: readonly PermissionDescriptor[];
}): ReactNode {
  const translate = useTranslate();
  const column = useAdminColumns<Role>();
  const { refresh } = useListNavigation(state);
  const [editing, setEditing] = useState<Role | null | undefined>(undefined);

  return (
    <AdminScreen titleKey="admin.roles.title" descriptionKey="admin.roles.description">
      <ResourceList<Role>
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
        onDelete={(row) => deleteRole(row.id, row.version)}
        onRestore={(row) => restoreRole(row.id, row.version)}
        deleteBlocked={(row) => {
          if (row.isSystem) {
            return translate('admin.roles.cannotDeleteSystem');
          }
          return row.memberCount === 0
            ? null
            : translate('admin.roles.inUseByMembers', { count: row.memberCount });
        }}
        columns={[
          {
            id: 'name',
            header: translate('admin.fields.name'),
            sortable: true,
            rowHeader: true,
            value: (row) => row.name,
          },
          {
            id: 'key',
            header: translate('admin.fields.key'),
            width: 200,
            sortable: true,
            value: (row) => row.key,
          },
          {
            id: 'description',
            header: translate('admin.fields.description'),
            defaultHidden: true,
            value: (row) => row.description ?? '',
          },
          column.count(
            'permissionCount',
            'admin.roles.permissions',
            (row) => row.permissions.length,
          ),
          column.count('memberCount', 'admin.roles.memberCount', (row) => row.memberCount),
          column.state({ system: (row) => row.isSystem }),
          column.updated(),
          column.created(),
        ]}
      />

      {editing === undefined ? null : (
        <FormDialog
          open
          title={translate(
            editing === null ? 'admin.actions.createTitle' : 'admin.actions.editTitle',
            { name: translate('admin.roles.one') },
          )}
          description={
            editing !== null && editing.isSystem ? translate('admin.roles.systemHint') : undefined
          }
          onClose={() => {
            setEditing(undefined);
          }}
          onSaved={refresh}
          onSubmit={(data) => {
            const permissions = list(data, 'permission') as PermissionKey[];
            if (editing === null) {
              return createRole({
                key: text(data, 'key'),
                name: text(data, 'name'),
                ...(text(data, 'description') !== '' && {
                  description: text(data, 'description'),
                }),
                permissions,
              });
            }
            const patch = changedFields(
              {
                name: editing.name,
                description: editing.description,
                permissions: [...editing.permissions],
              },
              {
                name: text(data, 'name'),
                description: nullableText(data, 'description'),
                // Compared as a sorted list, because the order a matrix reports is not part of what a
                // role *is*: two saves of the same boxes must not read as a change.
                permissions: [...permissions].sort(),
              },
            );
            return isEmptyPatch(patch)
              ? unchanged()
              : updateRole(editing.id, editing.version, patch);
          }}
        >
          {editing === null ? (
            <TextField
              name="key"
              label={translate('admin.fields.key')}
              hint={translate('admin.fields.keyHint')}
              maxLength={64}
              required
            />
          ) : (
            <TextField
              name="keyDisplay"
              label={translate('admin.fields.key')}
              hint={translate('admin.fields.keyHint')}
              defaultValue={editing.key}
              readOnly
            />
          )}
          <TextField
            name="name"
            label={translate('admin.fields.name')}
            defaultValue={editing?.name}
            maxLength={200}
            required
          />
          <TextAreaField
            name="description"
            label={translate('admin.fields.description')}
            defaultValue={editing?.description ?? ''}
          />
          <PermissionMatrix
            catalogue={catalogue}
            // Sorted so the initial value matches how a submission is compared, and a role opened and
            // saved untouched reports no change.
            defaultValue={[...(editing?.permissions ?? [])].sort()}
          />
        </FormDialog>
      )}
    </AdminScreen>
  );
}
