'use client';

import { type ReactNode, useState } from 'react';

import { Select } from '@munaxa/ui';

import type { RetentionPolicy } from '@edms/contracts';
import {
  Disposition,
  type DispositionKey,
  RetentionTrigger,
  type RetentionTriggerKey,
} from '@edms/domain';
import type { MessageKey } from '@edms/i18n';

import { useTranslate } from '../../app/providers';
import type { ListState } from '../../lib/admin/list-state';
import {
  AdminScreen,
  FormDialog,
  NumberField,
  ResourceList,
  SelectField,
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
  createRetentionPolicy,
  deleteRetentionPolicy,
  restoreRetentionPolicy,
  updateRetentionPolicy,
} from './actions';

export const RETENTION_SORT_FIELDS = ['createdAt', 'updatedAt', 'name', 'code'] as const;
export const RETENTION_FILTER_KEYS = ['trigger', 'disposition'] as const;

const TRIGGER_LABELS: Readonly<Record<RetentionTriggerKey, MessageKey>> = {
  ON_PUBLISH: 'admin.retention.triggerOnPublish',
  ON_SUPERSEDE: 'admin.retention.triggerOnSupersede',
  ON_ARCHIVE: 'admin.retention.triggerOnArchive',
  ON_DELETE: 'admin.retention.triggerOnDelete',
};

const DISPOSITION_LABELS: Readonly<Record<DispositionKey, MessageKey>> = {
  REVIEW: 'admin.retention.dispositionReview',
  ARCHIVE: 'admin.retention.dispositionArchive',
  PURGE: 'admin.retention.dispositionPurge',
  RETAIN_FOREVER: 'admin.retention.dispositionRetainForever',
};

/**
 * Retention policies — how long a record is kept after an event, and what happens then.
 *
 * The period is in whole months because that is how record-keeping regimes are written ("seven years
 * after supersession"), and the one coherence rule the form has to respect is the contract's: a policy
 * that retains forever has no period, and every other disposition must state one. The API refuses
 * "purge, eventually" and so the form's own `min` reflects it.
 */
export function RetentionScreen({
  rows,
  total,
  state,
}: {
  rows: readonly RetentionPolicy[];
  total: number;
  state: ListState;
}): ReactNode {
  const translate = useTranslate();
  const column = useAdminColumns<RetentionPolicy>();
  const { refresh, setFilter } = useListNavigation(state);
  const [editing, setEditing] = useState<RetentionPolicy | null | undefined>(undefined);

  return (
    <AdminScreen titleKey="admin.retention.title" descriptionKey="admin.retention.description">
      <ResourceList<RetentionPolicy>
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
        onDelete={(row) => deleteRetentionPolicy(row.id, row.version)}
        onRestore={(row) => restoreRetentionPolicy(row.id, row.version)}
        deleteBlocked={(row) =>
          row.documentTypeCount === 0
            ? null
            : translate('admin.list.inUseByTypes', { count: row.documentTypeCount })
        }
        filters={
          <>
            <Select
              value={state.filters.trigger ?? ''}
              aria-label={translate('admin.retention.trigger')}
              className="w-44"
              onChange={(event) => {
                setFilter('trigger', event.currentTarget.value);
              }}
            >
              <option value="">{translate('admin.list.filterAny')}</option>
              {Object.values(RetentionTrigger).map((trigger) => (
                <option key={trigger} value={trigger}>
                  {translate(TRIGGER_LABELS[trigger])}
                </option>
              ))}
            </Select>
            <Select
              value={state.filters.disposition ?? ''}
              aria-label={translate('admin.retention.disposition')}
              className="w-44"
              onChange={(event) => {
                setFilter('disposition', event.currentTarget.value);
              }}
            >
              <option value="">{translate('admin.list.filterAny')}</option>
              {Object.values(Disposition).map((disposition) => (
                <option key={disposition} value={disposition}>
                  {translate(DISPOSITION_LABELS[disposition])}
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
            value: (row) => row.name,
          },
          {
            id: 'code',
            header: translate('admin.fields.code'),
            width: 120,
            sortable: true,
            value: (row) => row.code,
          },
          {
            id: 'trigger',
            header: translate('admin.retention.trigger'),
            width: 160,
            value: (row) => translate(TRIGGER_LABELS[row.trigger]),
          },
          {
            id: 'periodMonths',
            header: translate('admin.retention.periodMonths'),
            width: 120,
            align: 'end',
            value: (row) => row.periodMonths,
          },
          {
            id: 'disposition',
            header: translate('admin.retention.disposition'),
            width: 170,
            value: (row) => translate(DISPOSITION_LABELS[row.disposition]),
          },
          column.yesNo(
            'reviewRequired',
            'admin.retention.reviewRequired',
            (row) => row.reviewRequired,
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
            { name: translate('admin.retention.one') },
          )}
          onClose={() => {
            setEditing(undefined);
          }}
          onSaved={refresh}
          onSubmit={(data) => {
            const body = {
              code: text(data, 'code'),
              name: text(data, 'name'),
              trigger: text(data, 'trigger') as RetentionTriggerKey,
              periodMonths: integer(data, 'periodMonths') ?? 0,
              disposition: text(data, 'disposition') as DispositionKey,
              reviewRequired: flag(data, 'reviewRequired'),
            };
            if (editing === null) {
              return createRetentionPolicy({
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
              : updateRetentionPolicy(editing.id, editing.version, patch);
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
          <SelectField
            name="trigger"
            label={translate('admin.retention.trigger')}
            defaultValue={editing?.trigger ?? RetentionTrigger.ON_PUBLISH}
            choices={Object.values(RetentionTrigger).map((trigger) => ({
              value: trigger,
              label: translate(TRIGGER_LABELS[trigger]),
            }))}
            required
          />
          <NumberField
            name="periodMonths"
            label={translate('admin.retention.periodMonths')}
            defaultValue={editing?.periodMonths ?? 0}
            minimum={0}
            maximum={1200}
            required
          />
          <SelectField
            name="disposition"
            label={translate('admin.retention.disposition')}
            defaultValue={editing?.disposition ?? Disposition.REVIEW}
            choices={Object.values(Disposition).map((disposition) => ({
              value: disposition,
              label: translate(DISPOSITION_LABELS[disposition]),
            }))}
            required
          />
          <TextAreaField
            name="description"
            label={translate('admin.fields.description')}
            defaultValue={editing?.description ?? ''}
          />
          <SwitchField
            name="reviewRequired"
            label={translate('admin.retention.reviewRequired')}
            hint={translate('admin.retention.reviewRequiredHint')}
            defaultChecked={editing?.reviewRequired ?? false}
          />
        </FormDialog>
      )}
    </AdminScreen>
  );
}
