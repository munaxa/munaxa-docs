'use client';

import { type ReactNode, useState } from 'react';

import { Alert, Select } from '@munaxa/ui';

import type { ApprovalGroup } from '@edms/contracts';

import { useTranslate } from '../../app/providers';
import type { ListState } from '../../lib/admin/list-state';
import {
  AdminScreen,
  type Choice,
  FormDialog,
  MultiPickerField,
  ResourceList,
  SwitchField,
  TextAreaField,
  TextField,
  changedFields,
  flag,
  isEmptyPatch,
  list,
  nullableText,
  text,
  unchanged,
  useAdminColumns,
  useListNavigation,
} from '../admin-shared';
import {
  createApprovalGroup,
  deleteApprovalGroup,
  restoreApprovalGroup,
  updateApprovalGroup,
} from './actions';

export const GROUP_SORT_FIELDS = ['createdAt', 'updatedAt', 'name', 'key'] as const;
export const GROUP_FILTER_KEYS = ['isActive'] as const;

/**
 * Approval groups.
 *
 * A group is a **routing list, not a permission**, and the screen says so above the form rather than
 * leaving it to be inferred. Adding somebody to "safety reviewers" makes them a candidate for a stage
 * that names the group and grants them nothing — and an administrator who believed otherwise would
 * either grant access by accident or refuse to add somebody who needs to be added.
 *
 * A group a published workflow routes to cannot be removed, because a published version is immutable
 * and would be left pointing at nothing. Deactivating it is how routing is stopped, and the count in
 * the row comes from the API asking the stored definitions rather than from a guess.
 */
export function ApprovalGroupsScreen({
  rows,
  total,
  state,
  users,
}: {
  readonly rows: readonly ApprovalGroup[];
  readonly total: number;
  readonly state: ListState;
  readonly users: readonly Choice[];
}): ReactNode {
  const translate = useTranslate();
  const column = useAdminColumns<ApprovalGroup>();
  const { refresh, setFilter } = useListNavigation(state);
  const [editing, setEditing] = useState<ApprovalGroup | null | undefined>(undefined);

  return (
    <AdminScreen
      titleKey="admin.approvalGroups.title"
      descriptionKey="admin.approvalGroups.description"
    >
      <ResourceList<ApprovalGroup>
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
        onDelete={(row) => deleteApprovalGroup(row.id, row.version)}
        onRestore={(row) => restoreApprovalGroup(row.id, row.version)}
        deleteBlocked={(row) =>
          row.usedByWorkflowCount === 0 ? null : translate('admin.approvalGroups.inUse')
        }
        filters={
          <Select
            value={state.filters.isActive ?? ''}
            aria-label={translate('admin.fields.status')}
            className="w-36"
            onChange={(event) => {
              setFilter('isActive', event.currentTarget.value);
            }}
          >
            <option value="">{translate('admin.list.filterAny')}</option>
            <option value="true">{translate('admin.fields.active')}</option>
            <option value="false">{translate('admin.fields.inactive')}</option>
          </Select>
        }
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
            width: 180,
            sortable: true,
            value: (row) => row.key,
          },
          column.count('members', 'admin.approvalGroups.members', (row) => row.members.length),
          column.count(
            'usedByWorkflowCount',
            'admin.workflows.title',
            (row) => row.usedByWorkflowCount,
          ),
          column.state({ inactive: (row) => !row.isActive }),
          column.updated(),
          column.created(),
        ]}
      />

      {editing === undefined ? null : (
        <FormDialog
          open
          title={translate(
            editing === null ? 'admin.actions.createTitle' : 'admin.actions.editTitle',
            { name: translate('admin.approvalGroups.one') },
          )}
          onClose={() => {
            setEditing(undefined);
          }}
          onSaved={refresh}
          onSubmit={(data) => {
            const memberIds = list(data, 'memberIds');
            if (editing === null) {
              return createApprovalGroup({
                key: text(data, 'key'),
                name: text(data, 'name'),
                ...(text(data, 'description') !== '' && {
                  description: text(data, 'description'),
                }),
                memberIds,
              });
            }
            // Membership is replaced as a whole set rather than diffed here: a diff computed in the
            // browser is a second place uniqueness is decided, and two administrators editing one
            // group would each apply their own to a list neither of them saw.
            const patch = changedFields(
              {
                name: editing.name,
                description: editing.description,
                isActive: editing.isActive,
                memberIds: editing.members.map((member) => member.userId),
              },
              {
                name: text(data, 'name'),
                description: nullableText(data, 'description'),
                isActive: flag(data, 'isActive'),
                memberIds,
              },
            );
            return isEmptyPatch(patch)
              ? unchanged()
              : updateApprovalGroup(editing.id, editing.version, patch);
          }}
        >
          <Alert tone="info">{translate('admin.approvalGroups.notAPermission')}</Alert>
          {editing === null ? (
            <TextField
              name="key"
              label={translate('admin.fields.key')}
              hint={translate('admin.fields.keyHint')}
              maxLength={64}
              required
            />
          ) : (
            // A key appears inside stored workflow definitions, so changing one would repoint every
            // stage that names it. Set once, like every other configuration key here.
            <TextField
              name="keyDisplay"
              label={translate('admin.fields.key')}
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
          <MultiPickerField
            name="memberIds"
            label={translate('admin.approvalGroups.members')}
            options={users}
            defaultValue={editing?.members.map((member) => member.userId) ?? []}
          />
          {editing !== null && (
            <SwitchField
              name="isActive"
              label={translate('admin.fields.active')}
              defaultChecked={editing.isActive}
            />
          )}
        </FormDialog>
      )}
    </AdminScreen>
  );
}
