'use client';

import { type ReactNode, useState } from 'react';

import type { Company } from '@edms/contracts';

import { useTranslate } from '../../app/providers';
import type { ListState } from '../../lib/admin/list-state';
import {
  AdminScreen,
  FormDialog,
  ResourceList,
  TextField,
  changedFields,
  isEmptyPatch,
  text,
  unchanged,
  useAdminColumns,
  useListNavigation,
} from '../admin-shared';
import { createCompany, deleteCompany, restoreCompany, updateCompany } from './actions';

/**
 * Companies — the top of the scope tree.
 *
 * Two fields, and the interesting behaviour is what happens when one is removed: a company with
 * entities under it cannot be deleted, and the row says so with the count rather than offering an
 * action that fails. The API refuses it either way; this is what stops an administrator finding out
 * by trying.
 */
export function CompaniesScreen({
  rows,
  total,
  state,
}: {
  rows: readonly Company[];
  total: number;
  state: ListState;
}): ReactNode {
  const translate = useTranslate();
  const column = useAdminColumns<Company>();
  const { refresh } = useListNavigation(state);
  // `undefined` closed, `null` creating, a row editing. Three states, one variable, no way for two
  // of them to be true at once.
  const [editing, setEditing] = useState<Company | null | undefined>(undefined);

  return (
    <AdminScreen titleKey="admin.companies.title" descriptionKey="admin.companies.description">
      <ResourceList<Company>
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
        onDelete={(row) => deleteCompany(row.id, row.version)}
        onRestore={(row) => restoreCompany(row.id, row.version)}
        deleteBlocked={(row) =>
          row.entityCount === 0
            ? null
            : translate('admin.list.inUseByChildren', { count: row.entityCount })
        }
        columns={[
          {
            id: 'code',
            header: translate('admin.fields.code'),
            width: 140,
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
          column.count('entityCount', 'admin.companies.entityCount', (row) => row.entityCount),
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
            { name: translate('admin.companies.one') },
          )}
          onClose={() => {
            setEditing(undefined);
          }}
          onSaved={refresh}
          onSubmit={(data) => {
            const body = { code: text(data, 'code'), name: text(data, 'name') };
            if (editing === null) {
              return createCompany(body);
            }
            const patch = changedFields(editing, body);
            return isEmptyPatch(patch)
              ? unchanged()
              : updateCompany(editing.id, editing.version, patch);
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
        </FormDialog>
      )}
    </AdminScreen>
  );
}
