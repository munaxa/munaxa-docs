'use client';

import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import { type ReactNode, useState } from 'react';

import { Select } from '@munaxa/ui';

import type { Library } from '@edms/contracts';
import { LIBRARY_OWNER_SCOPES, ScopeType, type ScopeTypeKey } from '@edms/domain';
import type { MessageKey } from '@edms/i18n';

import { useTranslate } from '../../app/providers';
import type { ListState } from '../../lib/admin/list-state';
import {
  AdminScreen,
  type Choice,
  FormDialog,
  PickerField,
  ResourceList,
  SelectField,
  TextAreaField,
  TextField,
  changedFields,
  isEmptyPatch,
  nullableText,
  optionalText,
  text,
  unchanged,
  useAdminColumns,
  useListNavigation,
} from '../admin-shared';
import { createLibrary, deleteLibrary, restoreLibrary, updateLibrary } from './actions';

const OWNER_SCOPE_LABELS: Readonly<Record<string, MessageKey>> = {
  TENANT: 'admin.libraries.ownerScopeTENANT',
  COMPANY: 'admin.libraries.ownerScopeCOMPANY',
  ENTITY: 'admin.libraries.ownerScopeENTITY',
  DEPARTMENT: 'admin.libraries.ownerScopeDEPARTMENT',
};

/**
 * Libraries — where documents will live, and the trees ACLs are granted on.
 *
 * A library belongs to exactly one organisation node, and the list of candidate kinds deliberately has
 * no branch in it: permission does not flow through a location. `TENANT` takes no identifier at all —
 * the tenant is implicit, taken from the token, and naming it in a body is the one thing the isolation
 * guard rejects outright.
 *
 * Opening a row goes to its folder tree, which is where the structure inside a library is edited.
 */
export function LibrariesScreen({
  rows,
  total,
  state,
  owners,
}: {
  rows: readonly Library[];
  total: number;
  state: ListState;
  /** Candidate owner nodes, by kind. `TENANT` is absent: it needs no identifier. */
  owners: Readonly<Record<string, readonly Choice[]>>;
}): ReactNode {
  const translate = useTranslate();
  const router = useRouter();
  const column = useAdminColumns<Library>();
  const { refresh, setFilter } = useListNavigation(state);
  const [editing, setEditing] = useState<Library | null | undefined>(undefined);
  const [scope, setScope] = useState<ScopeTypeKey>(ScopeType.TENANT);

  const openFolders = (row: Library): void => {
    router.push(`/admin/libraries/${row.id}/folders` as Route);
  };

  return (
    <AdminScreen titleKey="admin.libraries.title" descriptionKey="admin.libraries.description">
      <ResourceList<Library>
        rows={rows}
        total={total}
        state={state}
        getRowId={(row) => row.id}
        getRowName={(row) => row.name}
        isDeleted={(row) => row.deletedAt !== null}
        onCreate={() => {
          setScope(ScopeType.TENANT);
          setEditing(null);
        }}
        onEdit={setEditing}
        onRowActivate={openFolders}
        onDelete={(row) => deleteLibrary(row.id, row.version)}
        onRestore={(row) => restoreLibrary(row.id, row.version)}
        extraActions={(row) => [
          {
            id: 'folders',
            label: translate('admin.libraries.openFolders'),
            onSelect: () => {
              openFolders(row);
            },
          },
        ]}
        filters={
          <Select
            value={state.filters.ownerScopeType ?? ''}
            aria-label={translate('admin.libraries.ownerScope')}
            className="w-52"
            onChange={(event) => {
              setFilter('ownerScopeType', event.currentTarget.value);
            }}
          >
            <option value="">{translate('admin.list.filterAny')}</option>
            {LIBRARY_OWNER_SCOPES.map((candidate) => (
              <option key={candidate} value={candidate}>
                {translate(OWNER_SCOPE_LABELS[candidate] ?? 'admin.libraries.ownerScope')}
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
            id: 'ownerScopeName',
            header: translate('admin.libraries.ownerScope'),
            width: 220,
            value: (row) =>
              `${translate(
                OWNER_SCOPE_LABELS[row.ownerScopeType] ?? 'admin.libraries.ownerScope',
              )} · ${row.ownerScopeName}`,
          },
          {
            id: 'description',
            header: translate('admin.fields.description'),
            defaultHidden: true,
            value: (row) => row.description ?? '',
          },
          column.count('folderCount', 'admin.libraries.folderCount', (row) => row.folderCount),
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
            { name: translate('admin.libraries.one') },
          )}
          onClose={() => {
            setEditing(undefined);
          }}
          onSaved={refresh}
          onSubmit={(data) => {
            if (editing === null) {
              const ownerScopeId = text(data, 'ownerScopeId');
              return createLibrary({
                code: text(data, 'code'),
                name: text(data, 'name'),
                ...(optionalText(data, 'description') !== undefined && {
                  description: optionalText(data, 'description'),
                }),
                ownerScopeType: scope,
                // Absent for the tenant, which is implicit and refused if named.
                ...(scope !== ScopeType.TENANT && { ownerScopeId }),
                ...(optionalText(data, 'rootFolderName') !== undefined && {
                  rootFolderName: optionalText(data, 'rootFolderName'),
                }),
              });
            }
            const patch = changedFields(editing, {
              code: text(data, 'code'),
              name: text(data, 'name'),
              description: nullableText(data, 'description'),
            });
            return isEmptyPatch(patch)
              ? unchanged()
              : updateLibrary(editing.id, editing.version, patch);
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
          <TextAreaField
            name="description"
            label={translate('admin.fields.description')}
            defaultValue={editing?.description ?? ''}
          />

          {editing === null ? (
            <>
              {/*
                Controlled, because this answer decides whether the picker below exists at all. The
                `key` on that picker resets its selection when the kind changes: a company id left
                behind after switching to a department would be a perfectly-formed body naming the
                wrong node.
              */}
              <SelectField
                name="ownerScopeTypeChoice"
                label={translate('admin.libraries.ownerScope')}
                hint={translate('admin.libraries.ownerScopeHint')}
                value={scope}
                onValueChange={(next) => {
                  setScope(next as ScopeTypeKey);
                }}
                choices={LIBRARY_OWNER_SCOPES.map((candidate) => ({
                  value: candidate,
                  label: translate(OWNER_SCOPE_LABELS[candidate] ?? 'admin.libraries.ownerScope'),
                }))}
                required
              />
              {scope === ScopeType.TENANT ? null : (
                <PickerField
                  key={scope}
                  name="ownerScopeId"
                  label={translate(OWNER_SCOPE_LABELS[scope] ?? 'admin.libraries.ownerScope')}
                  options={(owners[scope] ?? []).map((owner) => ({
                    value: owner.value,
                    label: owner.label,
                  }))}
                  required
                />
              )}
              <TextField
                name="rootFolderName"
                label={translate('admin.libraries.rootFolderName')}
                maxLength={200}
              />
            </>
          ) : (
            <TextField
              name="ownerScopeDisplay"
              label={translate('admin.libraries.ownerScope')}
              hint={translate('admin.libraries.ownerScopeHint')}
              defaultValue={editing.ownerScopeName}
              readOnly
            />
          )}
        </FormDialog>
      )}
    </AdminScreen>
  );
}
