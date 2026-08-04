'use client';

import { type ReactNode, useState } from 'react';

import type { ConfidentialityLevel } from '@edms/contracts';

import { useTranslate } from '../../app/providers';
import type { ListState } from '../../lib/admin/list-state';
import {
  AdminScreen,
  FormDialog,
  NumberField,
  ResourceList,
  SwitchField,
  TextAreaField,
  TextField,
  changedFields,
  flag,
  integer,
  isEmptyPatch,
  nullableText,
  text,
  unchanged,
  useAdminColumns,
  useListNavigation,
} from '../admin-shared';
import {
  createConfidentialityLevel,
  deleteConfidentialityLevel,
  restoreConfidentialityLevel,
  updateConfidentialityLevel,
} from './actions';

export const CONFIDENTIALITY_SORT_FIELDS = [
  'createdAt',
  'updatedAt',
  'name',
  'code',
  'rank',
] as const;

/**
 * Confidentiality levels.
 *
 * Ordered by rank by default, because rank is the level's identity to the product rather than
 * decoration: conditions compare it, audit-on-read is triggered by it, and "more sensitive than" only
 * has an answer because ranks are unique and totally ordered.
 *
 * Every handling rule here *subtracts*. A level may forbid download to somebody who holds
 * `document:download`; none of them can grant it to somebody who does not
 * (`docs/architecture/08-permission-model.md` §4).
 */
export function ConfidentialityScreen({
  rows,
  total,
  state,
}: {
  rows: readonly ConfidentialityLevel[];
  total: number;
  state: ListState;
}): ReactNode {
  const translate = useTranslate();
  const column = useAdminColumns<ConfidentialityLevel>();
  const { refresh } = useListNavigation(state);
  const [editing, setEditing] = useState<ConfidentialityLevel | null | undefined>(undefined);

  return (
    <AdminScreen
      titleKey="admin.confidentiality.title"
      descriptionKey="admin.confidentiality.description"
    >
      <ResourceList<ConfidentialityLevel>
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
        onDelete={(row) => deleteConfidentialityLevel(row.id, row.version)}
        onRestore={(row) => restoreConfidentialityLevel(row.id, row.version)}
        deleteBlocked={(row) =>
          row.documentTypeCount === 0
            ? null
            : translate('admin.list.inUseByTypes', { count: row.documentTypeCount })
        }
        columns={[
          {
            id: 'rank',
            header: translate('admin.confidentiality.rank'),
            width: 90,
            align: 'end',
            sortable: true,
            value: (row) => row.rank,
          },
          {
            id: 'name',
            header: translate('admin.fields.name'),
            sortable: true,
            rowHeader: true,
            value: (row) => row.name,
          },
          {
            id: 'code',
            header: translate('admin.fields.code'),
            width: 120,
            sortable: true,
            value: (row) => row.code,
          },
          column.yesNo(
            'allowDownload',
            'admin.confidentiality.allowDownload',
            (row) => row.allowDownload,
          ),
          column.yesNo('allowPrint', 'admin.confidentiality.allowPrint', (row) => row.allowPrint),
          column.yesNo('watermark', 'admin.confidentiality.watermark', (row) => row.watermark),
          column.yesNo(
            'requireReason',
            'admin.confidentiality.requireReason',
            (row) => row.requireReason,
          ),
          column.count(
            'documentTypeCount',
            'admin.documentTypes.title',
            (row) => row.documentTypeCount,
          ),
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
            { name: translate('admin.confidentiality.one') },
          )}
          onClose={() => {
            setEditing(undefined);
          }}
          onSaved={refresh}
          onSubmit={(data) => {
            const body = {
              code: text(data, 'code'),
              name: text(data, 'name'),
              rank: integer(data, 'rank') ?? 0,
              allowDownload: flag(data, 'allowDownload'),
              allowPrint: flag(data, 'allowPrint'),
              watermark: flag(data, 'watermark'),
              requireReason: flag(data, 'requireReason'),
            };
            if (editing === null) {
              return createConfidentialityLevel({
                ...body,
                ...(text(data, 'description') !== '' && {
                  description: text(data, 'description'),
                }),
              });
            }
            const patch = changedFields(editing, {
              ...body,
              description: nullableText(data, 'description'),
            });
            return isEmptyPatch(patch)
              ? unchanged()
              : updateConfidentialityLevel(editing.id, editing.version, patch);
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
          <NumberField
            name="rank"
            label={translate('admin.confidentiality.rank')}
            hint={translate('admin.confidentiality.rankHint')}
            defaultValue={editing?.rank ?? 0}
            minimum={0}
            maximum={100}
            required
          />
          <TextAreaField
            name="description"
            label={translate('admin.fields.description')}
            defaultValue={editing?.description ?? ''}
          />
          <SwitchField
            name="allowDownload"
            label={translate('admin.confidentiality.allowDownload')}
            defaultChecked={editing?.allowDownload ?? true}
          />
          <SwitchField
            name="allowPrint"
            label={translate('admin.confidentiality.allowPrint')}
            defaultChecked={editing?.allowPrint ?? true}
          />
          <SwitchField
            name="watermark"
            label={translate('admin.confidentiality.watermark')}
            defaultChecked={editing?.watermark ?? false}
          />
          <SwitchField
            name="requireReason"
            label={translate('admin.confidentiality.requireReason')}
            hint={translate('admin.confidentiality.requireReasonHint')}
            defaultChecked={editing?.requireReason ?? false}
          />
        </FormDialog>
      )}
    </AdminScreen>
  );
}
