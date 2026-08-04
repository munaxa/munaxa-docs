'use client';

import { type ReactNode, useState } from 'react';

import { Select } from '@munaxa/ui';

import type { User } from '@edms/contracts';
import { UserStatus, type UserStatusKey } from '@edms/domain';
import type { MessageKey } from '@edms/i18n';

import { useSession, useTranslate } from '../../app/providers';
import type { ListState } from '../../lib/admin/list-state';
import {
  AdminScreen,
  type Choice,
  FormDialog,
  MultiPickerField,
  ResourceList,
  TextField,
  changedFields,
  isEmptyPatch,
  list,
  text,
  unchanged,
  useAction,
  useAdminColumns,
  useListNavigation,
} from '../admin-shared';
import {
  activateUser,
  createUser,
  deleteUser,
  disableUser,
  restoreUser,
  setUserPassword,
  updateUser,
} from './actions';
import { DepartmentMemberships } from './department-memberships';

export const USER_SORT_FIELDS = [
  'createdAt',
  'updatedAt',
  'displayName',
  'email',
  'lastLoginAt',
] as const;
export const USER_FILTER_KEYS = ['status', 'roleId', 'departmentId'] as const;

const STATUS_LABELS: Readonly<Record<UserStatusKey, MessageKey>> = {
  INVITED: 'admin.users.statusInvited',
  ACTIVE: 'admin.users.statusActive',
  DISABLED: 'admin.users.statusDisabled',
};

/**
 * People, their roles and their departments.
 *
 * Three actions here are not edits and are not offered as fields. Setting a password ends every
 * session the person holds; disabling an account does the same; and neither can be done to your own
 * account — an administrator who locks themselves out has to be unlocked by somebody else, and this
 * is the one place that can be prevented rather than repaired.
 *
 * Roles are granted tenant-wide, which is the only reach Phase 2 offers. That is a stated limit
 * rather than an omission: a role granted on one node needs the ACL resolver to enforce the boundary,
 * and until that exists a scoped grant would be *stored* as scoped and *enforced* as tenant-wide.
 */
export function UsersScreen({
  rows,
  total,
  state,
  roles,
  departments,
}: {
  rows: readonly User[];
  total: number;
  state: ListState;
  roles: readonly Choice[];
  departments: readonly Choice[];
}): ReactNode {
  const translate = useTranslate();
  const { userId } = useSession();
  const column = useAdminColumns<User>();
  const { refresh, setFilter } = useListNavigation(state);
  const perform = useAction(state);
  const [editing, setEditing] = useState<User | null | undefined>(undefined);
  const [passwordFor, setPasswordFor] = useState<User | null>(null);

  const isSelf = (row: User): boolean => userId !== null && row.id === userId;

  return (
    <AdminScreen titleKey="admin.users.title" descriptionKey="admin.users.description">
      <ResourceList<User>
        rows={rows}
        total={total}
        state={state}
        searchPlaceholderKey="admin.users.email"
        getRowId={(row) => row.id}
        getRowName={(row) => row.displayName}
        isDeleted={(row) => row.deletedAt !== null}
        onCreate={() => {
          setEditing(null);
        }}
        onEdit={setEditing}
        onDelete={(row) => deleteUser(row.id, row.version)}
        onRestore={(row) => restoreUser(row.id, row.version)}
        deleteBlocked={(row) => (isSelf(row) ? translate('admin.users.cannotDeleteSelf') : null)}
        extraActions={(row) => [
          {
            id: 'password',
            label: translate('admin.users.setPassword'),
            onSelect: () => {
              setPasswordFor(row);
            },
          },
          row.status === UserStatus.DISABLED
            ? {
                id: 'activate',
                label: translate('admin.users.activate'),
                onSelect: () => {
                  perform(() => activateUser(row.id, row.version));
                },
              }
            : {
                id: 'disable',
                label: translate('admin.users.disable'),
                disabledReason: isSelf(row) ? translate('admin.users.cannotDisableSelf') : null,
                onSelect: () => {
                  perform(() => disableUser(row.id, row.version));
                },
              },
        ]}
        filters={
          <>
            <Select
              value={state.filters.status ?? ''}
              aria-label={translate('admin.fields.status')}
              className="w-40"
              onChange={(event) => {
                setFilter('status', event.currentTarget.value);
              }}
            >
              <option value="">{translate('admin.list.filterAny')}</option>
              {Object.values(UserStatus).map((status) => (
                <option key={status} value={status}>
                  {translate(STATUS_LABELS[status])}
                </option>
              ))}
            </Select>
            <Select
              value={state.filters.roleId ?? ''}
              aria-label={translate('admin.users.roles')}
              className="w-44"
              onChange={(event) => {
                setFilter('roleId', event.currentTarget.value);
              }}
            >
              <option value="">{translate('admin.list.filterAny')}</option>
              {roles.map((role) => (
                <option key={role.value} value={role.value}>
                  {role.label}
                </option>
              ))}
            </Select>
            <Select
              value={state.filters.departmentId ?? ''}
              aria-label={translate('admin.users.departments')}
              className="w-44"
              onChange={(event) => {
                setFilter('departmentId', event.currentTarget.value);
              }}
            >
              <option value="">{translate('admin.list.filterAny')}</option>
              {departments.map((department) => (
                <option key={department.value} value={department.value}>
                  {department.label}
                </option>
              ))}
            </Select>
          </>
        }
        columns={[
          {
            id: 'displayName',
            header: translate('admin.users.displayName'),
            sortable: true,
            rowHeader: true,
            value: (row) => row.displayName,
          },
          {
            id: 'email',
            header: translate('admin.users.email'),
            sortable: true,
            value: (row) => row.email,
          },
          {
            id: 'status',
            header: translate('admin.fields.status'),
            width: 120,
            value: (row) => translate(STATUS_LABELS[row.status]),
          },
          {
            id: 'roles',
            header: translate('admin.users.roles'),
            value: (row) => row.roles.map((role) => role.name).join(', '),
          },
          {
            id: 'departments',
            header: translate('admin.users.departments'),
            defaultHidden: true,
            value: (row) =>
              row.departments
                .map((membership) =>
                  membership.isPrimary ? `${membership.name} ★` : membership.name,
                )
                .join(', '),
          },
          column.date(
            'lastLoginAt',
            'admin.users.lastLogin',
            (row) => row.lastLoginAt,
            'admin.users.neverSignedIn',
          ),
          column.yesNo('mfaEnrolled', 'admin.users.mfa', (row) => row.mfaEnrolled),
          {
            id: 'hasPassword',
            header: translate('admin.users.passwordSet'),
            width: 130,
            defaultHidden: true,
            value: (row) =>
              translate(row.hasPassword ? 'admin.fields.yes' : 'admin.users.noPassword'),
          },
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
            { name: translate('admin.users.one') },
          )}
          onClose={() => {
            setEditing(undefined);
          }}
          onSaved={refresh}
          onSubmit={(data) => {
            const body = {
              email: text(data, 'email'),
              displayName: text(data, 'displayName'),
              roleIds: list(data, 'roleId'),
              departments: membershipsFrom(data),
            };
            if (editing === null) {
              return createUser(body);
            }
            const patch = changedFields(
              {
                email: editing.email,
                displayName: editing.displayName,
                roleIds: editing.roles.map((role) => role.id),
                departments: editing.departments.map((membership) => ({
                  departmentId: membership.departmentId,
                  isPrimary: membership.isPrimary,
                })),
              },
              body,
            );
            return isEmptyPatch(patch)
              ? unchanged()
              : updateUser(editing.id, editing.version, patch);
          }}
        >
          <TextField
            name="email"
            type="email"
            label={translate('admin.users.email')}
            defaultValue={editing?.email}
            maxLength={320}
            required
          />
          <TextField
            name="displayName"
            label={translate('admin.users.displayName')}
            defaultValue={editing?.displayName}
            maxLength={200}
            required
          />
          <MultiPickerField
            name="roleId"
            label={translate('admin.users.roles')}
            options={roles.map((role) => ({ value: role.value, label: role.label }))}
            defaultValue={editing?.roles.map((role) => role.id) ?? []}
          />
          <DepartmentMemberships
            departments={departments}
            defaultValue={
              editing?.departments.map((membership) => ({
                departmentId: membership.departmentId,
                isPrimary: membership.isPrimary,
              })) ?? []
            }
          />
        </FormDialog>
      )}

      {passwordFor === null ? null : (
        <FormDialog
          open
          title={translate('admin.users.setPassword')}
          description={translate('admin.users.setPasswordHint')}
          onClose={() => {
            setPasswordFor(null);
          }}
          onSaved={refresh}
          onSubmit={(data) => setUserPassword(passwordFor.id, { password: text(data, 'password') })}
        >
          <TextField
            name="password"
            type="password"
            label={translate('auth.passwordLabel')}
            required
          />
        </FormDialog>
      )}
    </AdminScreen>
  );
}

/**
 * Rebuilds the membership list from the submitted fields.
 *
 * The primary flag is derived from the single `primaryDepartmentId` rather than sent per membership,
 * so "exactly one is primary" is true by construction. The database enforces it too with a partial
 * unique index; this is what keeps the form from ever asking it to.
 */
function membershipsFrom(
  data: FormData,
): readonly { readonly departmentId: string; readonly isPrimary: boolean }[] {
  const primary = text(data, 'primaryDepartmentId');
  return list(data, 'departmentId').map((departmentId) => ({
    departmentId,
    isPrimary: departmentId === primary,
  }));
}
