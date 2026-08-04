'use client';

import { type ReactNode, useState } from 'react';

import { Select } from '@munaxa/ui';

import type { MetadataField } from '@edms/contracts';
import { MetadataDataType, type MetadataDataTypeKey, requiresOptions } from '@edms/domain';

import { useTranslate } from '../../app/providers';
import type { ListState } from '../../lib/admin/list-state';
import {
  AdminScreen,
  FormDialog,
  ResourceList,
  changedFields,
  flag,
  integer,
  isEmptyPatch,
  list,
  nullableText,
  optionalText,
  text,
  unchanged,
  useAdminColumns,
  useListNavigation,
} from '../admin-shared';
import {
  createMetadataField,
  deleteMetadataField,
  restoreMetadataField,
  updateMetadataField,
} from './actions';
import { DATA_TYPE_LABELS, MetadataFieldForm } from './metadata-field-form';

export const FIELD_SORT_FIELDS = ['createdAt', 'updatedAt', 'name', 'key'] as const;
export const FIELD_FILTER_KEYS = ['dataType'] as const;

/**
 * The tenant-defined fields document types are built from.
 *
 * A field here is a *definition*, not an attachment: which types use it, whether it is required on
 * each and what it defaults to are per-type facts, edited on the document type. That separation is why
 * one "Reviewer" field can mean the same thing on six types.
 */
export function FieldsScreen({
  rows,
  total,
  state,
}: {
  rows: readonly MetadataField[];
  total: number;
  state: ListState;
}): ReactNode {
  const translate = useTranslate();
  const column = useAdminColumns<MetadataField>();
  const { refresh, setFilter } = useListNavigation(state);
  const [editing, setEditing] = useState<MetadataField | null | undefined>(undefined);

  return (
    <AdminScreen
      titleKey="admin.metadataFields.title"
      descriptionKey="admin.metadataFields.description"
    >
      <ResourceList<MetadataField>
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
        onDelete={(row) => deleteMetadataField(row.id, row.version)}
        onRestore={(row) => restoreMetadataField(row.id, row.version)}
        deleteBlocked={(row) =>
          row.documentTypeCount === 0
            ? null
            : translate('admin.list.inUseByTypes', { count: row.documentTypeCount })
        }
        filters={
          <Select
            value={state.filters.dataType ?? ''}
            aria-label={translate('admin.metadataFields.dataType')}
            className="w-48"
            onChange={(event) => {
              setFilter('dataType', event.currentTarget.value);
            }}
          >
            <option value="">{translate('admin.list.filterAny')}</option>
            {Object.values(MetadataDataType).map((dataType) => (
              <option key={dataType} value={dataType}>
                {translate(DATA_TYPE_LABELS[dataType])}
              </option>
            ))}
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
          {
            id: 'dataType',
            header: translate('admin.metadataFields.dataType'),
            width: 160,
            value: (row) => translate(DATA_TYPE_LABELS[row.dataType]),
          },
          {
            id: 'options',
            header: translate('admin.metadataFields.options'),
            defaultHidden: true,
            value: (row) => row.options.map((option) => option.label).join(', '),
          },
          column.yesNo(
            'isSearchable',
            'admin.metadataFields.searchable',
            (row) => row.isSearchable,
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
            { name: translate('admin.metadataFields.one') },
          )}
          onClose={() => {
            setEditing(undefined);
          }}
          onSaved={refresh}
          onSubmit={(data) => {
            const dataType = editing?.dataType ?? (text(data, 'dataType') as MetadataDataTypeKey);
            const options = requiresOptions(dataType) ? optionsFrom(data) : [];
            const validation = validationFrom(data, dataType);

            if (editing === null) {
              return createMetadataField({
                key: text(data, 'key'),
                name: text(data, 'name'),
                ...(optionalText(data, 'description') !== undefined && {
                  description: optionalText(data, 'description'),
                }),
                dataType,
                options,
                validation,
                isSearchable: flag(data, 'isSearchable'),
              });
            }
            const patch = changedFields(
              {
                name: editing.name,
                description: editing.description,
                options: editing.options.map((option) => ({ ...option })),
                validation: editing.validation,
                isSearchable: editing.isSearchable,
              },
              {
                name: text(data, 'name'),
                description: nullableText(data, 'description'),
                options,
                validation,
                isSearchable: flag(data, 'isSearchable'),
              },
            );
            return isEmptyPatch(patch)
              ? unchanged()
              : updateMetadataField(editing.id, editing.version, patch);
          }}
        >
          <MetadataFieldForm field={editing} />
        </FormDialog>
      )}
    </AdminScreen>
  );
}

/** Pairs the two parallel option lists back into records, in the order they were shown. */
function optionsFrom(data: FormData): readonly { value: string; label: string }[] {
  const values = list(data, 'optionValue');
  const labels = list(data, 'optionLabel');
  return values.map((value, index) => ({ value, label: labels[index] ?? value }));
}

/**
 * The validation the chosen type can carry, and nothing else.
 *
 * `metadataValidationSchema` is `.strict()`, so sending a `pattern` for a number field is a 422 rather
 * than a silently dropped key — which is the right behaviour, and the reason this narrows by type here
 * instead of collecting every input on the form.
 */
function validationFrom(
  data: FormData,
  dataType: MetadataDataTypeKey,
): Record<string, number | string> {
  if (dataType === MetadataDataType.TEXT || dataType === MetadataDataType.LONG_TEXT) {
    const minLength = integer(data, 'minLength');
    const maxLength = integer(data, 'maxLength');
    const pattern = optionalText(data, 'pattern');
    return {
      ...(minLength !== undefined && { minLength }),
      ...(maxLength !== undefined && { maxLength }),
      ...(pattern !== undefined && { pattern }),
    };
  }
  if (dataType === MetadataDataType.NUMBER) {
    const minimum = integer(data, 'minimum');
    const maximum = integer(data, 'maximum');
    return {
      ...(minimum !== undefined && { minimum }),
      ...(maximum !== undefined && { maximum }),
    };
  }
  return {};
}
