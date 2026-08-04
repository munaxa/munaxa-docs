'use client';

import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import { type ReactNode, useState } from 'react';

import { Select } from '@munaxa/ui';

import type { WorkflowDefinition, WorkflowDefinitionBody } from '@edms/contracts';
import { WorkflowVersionState, type WorkflowVersionStateKey } from '@edms/domain';
import type { MessageKey } from '@edms/i18n';

import { useTranslate } from '../../app/providers';
import type { ListState } from '../../lib/admin/list-state';
import {
  AdminScreen,
  type Choice,
  FormDialog,
  ResourceList,
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
import { createWorkflow, deleteWorkflow, restoreWorkflow, updateWorkflow } from './actions';
import { DefinitionEditor, STARTING_DEFINITION } from './definition-editor';

export const WORKFLOW_SORT_FIELDS = ['createdAt', 'updatedAt', 'name', 'key'] as const;
export const WORKFLOW_FILTER_KEYS = ['isActive', 'state'] as const;

export const VERSION_STATE_LABELS: Readonly<Record<WorkflowVersionStateKey, MessageKey>> = {
  DRAFT: 'admin.workflows.stateDRAFT',
  PUBLISHED: 'admin.workflows.statePUBLISHED',
  DEPRECATED: 'admin.workflows.stateDEPRECATED',
};

/**
 * Approval workflows.
 *
 * The list is definitions; the versions live on the row's own page, because that is where the rule that
 * governs them is enforceable in one place: a published version can never be edited, so "edit this
 * workflow" is a sequence of new-draft, edit-draft, publish rather than a form.
 *
 * Creating a definition creates its first draft with it. A definition with no version is a name with no
 * behaviour — nothing can be attached to it and nothing can run — so the API writes both in one
 * transaction and this form asks for both at once.
 */
export function WorkflowsScreen({
  rows,
  total,
  state,
  documentTypes,
}: {
  rows: readonly WorkflowDefinition[];
  total: number;
  state: ListState;
  documentTypes: readonly Choice[];
}): ReactNode {
  const translate = useTranslate();
  const router = useRouter();
  const column = useAdminColumns<WorkflowDefinition>();
  const { refresh, setFilter } = useListNavigation(state);
  const [editing, setEditing] = useState<WorkflowDefinition | null | undefined>(undefined);
  const [definition, setDefinition] = useState<WorkflowDefinitionBody>(STARTING_DEFINITION);

  const open = (row: WorkflowDefinition): void => {
    router.push(`/admin/workflows/${row.id}` as Route);
  };

  return (
    <AdminScreen titleKey="admin.workflows.title" descriptionKey="admin.workflows.description">
      <ResourceList<WorkflowDefinition>
        rows={rows}
        total={total}
        state={state}
        getRowId={(row) => row.id}
        getRowName={(row) => row.name}
        isDeleted={(row) => row.deletedAt !== null}
        onCreate={() => {
          setDefinition(STARTING_DEFINITION);
          setEditing(null);
        }}
        onEdit={setEditing}
        onRowActivate={open}
        onDelete={(row) => deleteWorkflow(row.id, row.version)}
        onRestore={(row) => restoreWorkflow(row.id, row.version)}
        deleteBlocked={(row) => {
          if (row.publishedVersion !== null) {
            return translate('admin.workflows.inUse');
          }
          return row.documentTypeCount === 0
            ? null
            : translate('admin.list.inUseByTypes', { count: row.documentTypeCount });
        }}
        extraActions={(row) => [
          {
            id: 'versions',
            label: translate('admin.workflows.versions'),
            onSelect: () => {
              open(row);
            },
          },
        ]}
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
              value={state.filters.state ?? ''}
              aria-label={translate('admin.workflows.versions')}
              className="w-40"
              onChange={(event) => {
                setFilter('state', event.currentTarget.value);
              }}
            >
              <option value="">{translate('admin.list.filterAny')}</option>
              {Object.values(WorkflowVersionState).map((candidate) => (
                <option key={candidate} value={candidate}>
                  {translate(VERSION_STATE_LABELS[candidate])}
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
            id: 'key',
            header: translate('admin.fields.key'),
            width: 180,
            sortable: true,
            value: (row) => row.key,
          },
          {
            id: 'publishedVersion',
            header: translate('admin.workflows.statePUBLISHED'),
            width: 130,
            align: 'end',
            value: (row) =>
              row.publishedVersion === null
                ? translate('admin.fields.no')
                : translate('admin.workflows.versionNumber', { number: row.publishedVersion }),
          },
          {
            id: 'latestVersion',
            header: translate('admin.workflows.versions'),
            width: 120,
            align: 'end',
            value: (row) => row.latestVersion,
          },
          column.count(
            'documentTypeCount',
            'admin.documentTypes.title',
            (row) => row.documentTypeCount,
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
            { name: translate('admin.workflows.one') },
          )}
          onClose={() => {
            setEditing(undefined);
          }}
          onSaved={refresh}
          onSubmit={(data) => {
            if (editing === null) {
              return createWorkflow({
                key: text(data, 'key'),
                name: text(data, 'name'),
                ...(text(data, 'description') !== '' && {
                  description: text(data, 'description'),
                }),
                definition,
              });
            }
            // Only the definition's own attributes are editable here. Its behaviour is a version, and a
            // version is edited — or replaced — on the definition's own page.
            const patch = changedFields(editing, {
              name: text(data, 'name'),
              description: nullableText(data, 'description'),
              isActive: flag(data, 'isActive'),
            });
            return isEmptyPatch(patch)
              ? unchanged()
              : updateWorkflow(editing.id, editing.version, patch);
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
          {editing === null ? (
            <DefinitionEditor
              value={definition}
              onChange={setDefinition}
              documentTypes={documentTypes}
            />
          ) : (
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
