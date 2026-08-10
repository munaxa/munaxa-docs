'use client';

import { type ReactNode, useState } from 'react';

import { Select } from '@munaxa/ui';

import type { DocumentType } from '@edms/contracts';
import { RevisionLabelStyle, type RevisionLabelStyleKey } from '@edms/domain';
import type { MessageKey } from '@edms/i18n';

import { useTranslate } from '../../app/providers';
import type { ListState } from '../../lib/admin/list-state';
import {
  AdminScreen,
  type Choice,
  FormDialog,
  PickerField,
  Prerequisite,
  ResourceList,
  SelectField,
  SwitchField,
  TextAreaField,
  TextField,
  changedFields,
  flag,
  isEmptyPatch,
  nullableText,
  text,
  unchanged,
  useAdminColumns,
  useListNavigation,
} from '../admin-shared';
import {
  createDocumentType,
  deleteDocumentType,
  restoreDocumentType,
  updateDocumentType,
} from './actions';
import { TypeFieldsEditor } from './type-fields-editor';

const REVISION_LABELS: Readonly<Record<RevisionLabelStyleKey, MessageKey>> = {
  NUMERIC: 'admin.documentTypes.revisionNumeric',
  ALPHABETIC: 'admin.documentTypes.revisionAlphabetic',
  MAJOR_MINOR: 'admin.documentTypes.revisionMajorMinor',
};

/**
 * Document types — the policy pack for a document.
 *
 * This is the screen everything else in Classification and Control exists to feed: which fields a
 * document carries, which approval it needs, how its number is built, how long it is kept and how
 * sensitive it is by default. A numbering rule and a default confidentiality level are *required*,
 * which is why both are set up before this one.
 *
 * Editing a type changes documents created afterwards and nothing else. A document keeps the policy it
 * was created under, which is what makes an approved document's rules answerable years later.
 */
export function DocumentTypesScreen({
  rows,
  total,
  state,
  numberingRules,
  confidentialityLevels,
  workflows,
  retentionPolicies,
  fields,
}: {
  rows: readonly DocumentType[];
  total: number;
  state: ListState;
  numberingRules: readonly Choice[];
  confidentialityLevels: readonly Choice[];
  workflows: readonly Choice[];
  retentionPolicies: readonly Choice[];
  fields: readonly Choice[];
}): ReactNode {
  const translate = useTranslate();
  const column = useAdminColumns<DocumentType>();
  const { refresh, setFilter } = useListNavigation(state);
  const [editing, setEditing] = useState<DocumentType | null | undefined>(undefined);

  const ready = numberingRules.length > 0 && confidentialityLevels.length > 0;

  return (
    <AdminScreen
      titleKey="admin.documentTypes.title"
      descriptionKey="admin.documentTypes.description"
    >
      {numberingRules.length === 0 ? <Prerequisite nameKey="admin.numbering.one" /> : null}
      {confidentialityLevels.length === 0 ? (
        <Prerequisite nameKey="admin.confidentiality.one" />
      ) : null}

      <ResourceList<DocumentType>
        rows={rows}
        total={total}
        state={state}
        getRowId={(row) => row.id}
        getRowName={(row) => row.name}
        isDeleted={(row) => row.deletedAt !== null}
        onCreate={
          ready
            ? () => {
                setEditing(null);
              }
            : undefined
        }
        onEdit={setEditing}
        onDelete={(row) => deleteDocumentType(row.id, row.version)}
        onRestore={(row) => restoreDocumentType(row.id, row.version)}
        filters={
          <>
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
            <Select
              value={state.filters.workflowDefinitionId ?? ''}
              aria-label={translate('admin.documentTypes.workflow')}
              className="w-48"
              onChange={(event) => {
                setFilter('workflowDefinitionId', event.currentTarget.value);
              }}
            >
              <option value="">{translate('admin.list.filterAny')}</option>
              {workflows.map((workflow) => (
                <option key={workflow.value} value={workflow.value}>
                  {workflow.label}
                </option>
              ))}
            </Select>
          </>
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
            id: 'numberingRuleName',
            header: translate('admin.documentTypes.numberingRule'),
            width: 170,
            value: (row) => row.numberingRuleName,
          },
          {
            id: 'workflowDefinitionName',
            header: translate('admin.documentTypes.workflow'),
            width: 170,
            value: (row) =>
              row.workflowDefinitionName ?? translate('admin.documentTypes.noWorkflow'),
          },
          {
            id: 'defaultConfidentialityName',
            header: translate('admin.documentTypes.defaultConfidentiality'),
            width: 170,
            value: (row) => row.defaultConfidentialityName,
          },
          {
            id: 'retentionPolicyName',
            header: translate('admin.documentTypes.retentionPolicy'),
            width: 170,
            defaultHidden: true,
            value: (row) =>
              row.retentionPolicyName ?? translate('admin.documentTypes.noRetentionPolicy'),
          },
          {
            id: 'revisionLabelStyle',
            header: translate('admin.documentTypes.revisionLabels'),
            width: 160,
            defaultHidden: true,
            value: (row) => translate(REVISION_LABELS[row.revisionLabelStyle]),
          },
          column.count('fieldCount', 'admin.documentTypes.fields', (row) => row.fields.length),
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
            { name: translate('admin.documentTypes.one') },
          )}
          onClose={() => {
            setEditing(undefined);
          }}
          onSaved={refresh}
          onSubmit={(data) => {
            const body = {
              code: text(data, 'code'),
              name: text(data, 'name'),
              numberingRuleId: text(data, 'numberingRuleId'),
              workflowDefinitionId: nullableText(data, 'workflowDefinitionId'),
              retentionPolicyId: nullableText(data, 'retentionPolicyId'),
              defaultConfidentialityId: text(data, 'defaultConfidentialityId'),
              revisionLabelStyle: text(data, 'revisionLabelStyle') as RevisionLabelStyleKey,
              isActive: flag(data, 'isActive'),
              fields: attachmentsFrom(data),
            };
            if (editing === null) {
              return createDocumentType({
                ...body,
                ...(text(data, 'description') !== '' && {
                  description: text(data, 'description'),
                }),
              });
            }
            const patch = changedFields(
              {
                code: editing.code,
                name: editing.name,
                description: editing.description,
                numberingRuleId: editing.numberingRuleId,
                workflowDefinitionId: editing.workflowDefinitionId,
                retentionPolicyId: editing.retentionPolicyId,
                defaultConfidentialityId: editing.defaultConfidentialityId,
                revisionLabelStyle: editing.revisionLabelStyle,
                isActive: editing.isActive,
                fields: editing.fields.map((attachment) => ({
                  metadataFieldId: attachment.metadataFieldId,
                  isRequired: attachment.isRequired,
                  sortOrder: attachment.sortOrder,
                  defaultValue: attachment.defaultValue,
                })),
              },
              { ...body, description: nullableText(data, 'description') },
            );
            return isEmptyPatch(patch)
              ? unchanged()
              : updateDocumentType(editing.id, editing.version, patch);
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
          <PickerField
            name="numberingRuleId"
            label={translate('admin.documentTypes.numberingRule')}
            options={numberingRules.map((rule) => ({ value: rule.value, label: rule.label }))}
            defaultValue={editing?.numberingRuleId ?? ''}
            required
          />
          <PickerField
            name="defaultConfidentialityId"
            label={translate('admin.documentTypes.defaultConfidentiality')}
            options={confidentialityLevels.map((level) => ({
              value: level.value,
              label: level.label,
            }))}
            defaultValue={editing?.defaultConfidentialityId ?? ''}
            required
          />
          <PickerField
            name="workflowDefinitionId"
            label={translate('admin.documentTypes.workflow')}
            hint={translate('admin.documentTypes.noWorkflow')}
            options={workflows.map((workflow) => ({
              value: workflow.value,
              label: workflow.label,
            }))}
            defaultValue={editing?.workflowDefinitionId ?? ''}
            clearable
          />
          <PickerField
            name="retentionPolicyId"
            label={translate('admin.documentTypes.retentionPolicy')}
            hint={translate('admin.documentTypes.noRetentionPolicy')}
            options={retentionPolicies.map((policy) => ({
              value: policy.value,
              label: policy.label,
            }))}
            defaultValue={editing?.retentionPolicyId ?? ''}
            clearable
          />
          <SelectField
            name="revisionLabelStyle"
            label={translate('admin.documentTypes.revisionLabels')}
            defaultValue={editing?.revisionLabelStyle ?? RevisionLabelStyle.NUMERIC}
            choices={Object.values(RevisionLabelStyle).map((style) => ({
              value: style,
              label: translate(REVISION_LABELS[style]),
            }))}
            required
          />
          <SwitchField
            name="isActive"
            label={translate('admin.fields.active')}
            defaultChecked={editing?.isActive ?? true}
          />
          <TypeFieldsEditor fields={fields} defaultValue={editing?.fields ?? []} />
        </FormDialog>
      )}
    </AdminScreen>
  );
}

/** Rebuilds the attachment list, dropping rows where no field was chosen. */
function attachmentsFrom(data: FormData): readonly {
  metadataFieldId: string;
  isRequired: boolean;
  sortOrder: number;
  defaultValue: string | null;
}[] {
  const ids = data.getAll('typeFieldId').map((value) => (typeof value === 'string' ? value : ''));
  const orders = data.getAll('typeFieldOrder');
  const defaults = data.getAll('typeFieldDefault');
  const required = data.getAll('typeFieldRequired');

  return ids
    .map((metadataFieldId, index) => ({
      metadataFieldId,
      sortOrder: integerAt(orders, index),
      defaultValue: stringAt(defaults, index),
      isRequired: required[index] === 'true',
    }))
    .filter((attachment) => attachment.metadataFieldId !== '');
}

function integerAt(values: readonly FormDataEntryValue[], index: number): number {
  const raw = values[index];
  if (typeof raw !== 'string') {
    return 0;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stringAt(values: readonly FormDataEntryValue[], index: number): string | null {
  const raw = values[index];
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}
