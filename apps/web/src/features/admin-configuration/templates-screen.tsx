'use client';

import { type ReactNode, useState } from 'react';

import type { DocumentTemplate } from '@edms/contracts';

import { useSession, useTranslate } from '../../app/providers';
import type { ListState } from '../../lib/admin/list-state';
import {
  AdminScreen,
  type Choice,
  FormDialog,
  PickerField,
  Prerequisite,
  ResourceList,
  StateBadges,
  SwitchField,
  TextAreaField,
  TextField,
  changedFields,
  flag,
  isEmptyPatch,
  nullableText,
  text,
  unchanged,
  useListNavigation,
} from '../admin-shared';
import {
  createDocumentTemplate,
  deleteDocumentTemplate,
  restoreDocumentTemplate,
  updateDocumentTemplate,
} from './actions';

/**
 * Document templates — the controlled starting point a new document is filed from.
 *
 * **The capability is Phase 16's; only the surface is new.** `DocumentTemplatesController` has
 * carried five routes, a 373-line service, a persistence model with soft delete and restore, and
 * `template:manage` since that phase, and nothing in the product called any of it: `grep` for
 * `document-templates` across `apps/web` returned nothing at all. A whole domain was unreachable —
 * which is the one shape of gap this phase exists to close, and the reason this screen invents
 * nothing. Every field below is a column the API already accepts and already validates.
 *
 * ## Why it sits in Configuration rather than in a feature of its own
 *
 * A template *is* configuration, in the same family as the document type it names. The contract
 * says so in its own words — "no number, no revision, no approval and no lifecycle; it is
 * configuration that *produces* documents" — and the ordering of this section is the dependency
 * order: a template cannot be authored before the type, the confidentiality level and the category
 * it selects from exist. Giving it a top-level workspace would have implied it was a thing a
 * document controller works *on* rather than something they set up once.
 *
 * ## What is deliberately absent
 *
 * **Creating a document from a template.** `POST /document-templates/:id/documents` exists and is
 * gated on `document:create`, not on `template:manage` — using a template is an ordinary create.
 * Putting that button here would put it behind the wrong permission and in front of the wrong
 * person. It belongs on the document library, and it is recorded as a separate backlog item rather
 * than smuggled in beside the administration of the thing.
 *
 * **The template body.** `fileObjectId` and `filename` are real columns and a template of defaults
 * alone is explicitly legitimate, so the screen administers everything *except* attaching content.
 * Uploading one needs the upload pipeline's scan gate, its presign and its progress reporting, and
 * bolting a second upload path onto an admin dialog would be the parallel implementation §5
 * forbids. The columns are shown so an administrator can see whether a template carries a body;
 * setting one is backlogged.
 *
 * **`defaultMetadata`.** A JSON map validated against the type's own fields, at save *and* at use.
 * Editing it properly means rendering the selected type's field definitions — which is
 * `metadata-field-form.tsx`'s job, keyed on a type the dialog has only just been told about. It is
 * preserved untouched through every edit here, because `changedFields` omits what the form does not
 * name, and a patch that dropped it would silently discard a controller's defaults.
 */
export function TemplatesScreen({
  rows,
  total,
  state,
  documentTypes,
  confidentialityLevels,
  categories,
  folders,
}: {
  rows: readonly DocumentTemplate[];
  total: number;
  state: ListState;
  documentTypes: readonly Choice[];
  confidentialityLevels: readonly Choice[];
  categories: readonly Choice[];
  folders: readonly Choice[];
}): ReactNode {
  const translate = useTranslate();
  const { locale } = useSession();
  const { refresh } = useListNavigation(state);
  // The same UTC-medium format `useAdminColumns` uses, for the same reason: a list is for scanning,
  // and the exact instant is in the audit trail.
  const formatDate = (value: string): string =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(
      new Date(value),
    );
  const [editing, setEditing] = useState<DocumentTemplate | null | undefined>(undefined);

  // A template must name a type and a confidentiality level, so authoring one before either exists
  // is not a validation failure to discover on submit — it is a prerequisite, which is what this
  // component says and what the sibling screens use for the same situation.
  if (documentTypes.length === 0 || confidentialityLevels.length === 0) {
    return (
      <AdminScreen titleKey="admin.templates.title" descriptionKey="admin.templates.description">
        <Prerequisite
          nameKey={
            documentTypes.length === 0 ? 'admin.documentTypes.one' : 'admin.confidentiality.one'
          }
        />
      </AdminScreen>
    );
  }

  return (
    <AdminScreen titleKey="admin.templates.title" descriptionKey="admin.templates.description">
      <ResourceList<DocumentTemplate>
        rows={rows}
        total={total}
        state={state}
        getRowId={(row) => row.id}
        getRowName={(row) => row.name}
        // The API soft-deletes and restores, and the contract has no `deletedAt` on the wire type
        // because the list does not return deleted rows. Restore is therefore reachable from the
        // API and not from here, which is a real limit and is in the backlog rather than papered
        // over with a badge that would always read the same.
        isDeleted={() => false}
        onCreate={() => {
          setEditing(null);
        }}
        onEdit={setEditing}
        onDelete={(row) => deleteDocumentTemplate(row.id, row.version)}
        onRestore={(row) => restoreDocumentTemplate(row.id, row.version)}
        columns={[
          {
            id: 'name',
            header: translate('admin.fields.name'),
            sortable: true,
            rowHeader: true,
            value: (row) => row.name,
          },
          {
            id: 'documentTypeName',
            header: translate('admin.templates.documentType'),
            width: 180,
            value: (row) => row.documentTypeName,
          },
          {
            id: 'confidentialityName',
            header: translate('admin.templates.confidentiality'),
            width: 160,
            value: (row) => row.confidentialityName,
          },
          {
            id: 'defaultFolderPath',
            header: translate('admin.templates.defaultFolder'),
            defaultHidden: true,
            value: (row) => row.defaultFolderPath ?? '',
          },
          {
            id: 'filename',
            header: translate('admin.templates.body'),
            width: 160,
            defaultHidden: true,
            // The filename when the template carries a body, and the honest word when it does not.
            // A blank cell would read as missing data rather than as a legitimate template.
            value: (row) => row.filename ?? translate('admin.templates.noBody'),
          },
          {
            id: 'description',
            header: translate('admin.fields.description'),
            defaultHidden: true,
            value: (row) => row.description ?? '',
          },
          {
            // Written out rather than taken from `useAdminColumns`, and the reason is a contract
            // fact rather than a preference: that helper is typed on `AdministeredRecord`, which
            // requires `createdBy`, `updatedBy`, `deletedAt` and `deletedBy`. The template wire
            // type carries none of the four. Widening the response to satisfy a column helper
            // would be changing an API shape to suit a screen, which §15 forbids and which would
            // also start returning actor identifiers to a list that has no use for them.
            id: 'state',
            header: translate('admin.fields.status'),
            width: 130,
            alwaysVisible: true,
            cell: (row) => <StateBadges deleted={false} inactive={!row.isActive} />,
            value: (row) => (row.isActive ? '' : translate('admin.list.inactiveBadge')),
          },
          {
            id: 'updatedAt',
            header: translate('admin.fields.updatedAt'),
            width: 140,
            sortable: true,
            value: (row) => formatDate(row.updatedAt),
          },
          {
            id: 'createdAt',
            header: translate('admin.fields.createdAt'),
            width: 140,
            sortable: true,
            defaultHidden: true,
            value: (row) => formatDate(row.createdAt),
          },
        ]}
      />

      {editing === undefined ? null : (
        <FormDialog
          open
          title={translate(
            editing === null ? 'admin.actions.createTitle' : 'admin.actions.editTitle',
            { name: translate('admin.templates.one') },
          )}
          onClose={() => {
            setEditing(undefined);
          }}
          onSaved={refresh}
          onSubmit={(data) => {
            const chosen = {
              name: text(data, 'name'),
              documentTypeId: text(data, 'documentTypeId'),
              confidentialityId: text(data, 'confidentialityId'),
              isActive: flag(data, 'isActive'),
            };
            if (editing === null) {
              return createDocumentTemplate({
                ...chosen,
                ...(text(data, 'description') !== '' && {
                  description: text(data, 'description'),
                }),
                categoryId: text(data, 'categoryId') === '' ? null : text(data, 'categoryId'),
                defaultFolderId:
                  text(data, 'defaultFolderId') === '' ? null : text(data, 'defaultFolderId'),
              });
            }
            // `defaultMetadata`, `fileObjectId` and `filename` are absent from the patch by
            // construction: this form does not name them, so `changedFields` cannot report them
            // changed, and the template keeps whatever it was authored with.
            const patch = changedFields(editing, {
              ...chosen,
              description: nullableText(data, 'description'),
              categoryId: text(data, 'categoryId') === '' ? null : text(data, 'categoryId'),
              defaultFolderId:
                text(data, 'defaultFolderId') === '' ? null : text(data, 'defaultFolderId'),
            });
            return isEmptyPatch(patch)
              ? unchanged()
              : updateDocumentTemplate(editing.id, editing.version, patch);
          }}
        >
          <TextField
            name="name"
            label={translate('admin.fields.name')}
            defaultValue={editing?.name}
            maxLength={200}
            required
          />
          <PickerField
            name="documentTypeId"
            label={translate('admin.templates.documentType')}
            hint={translate('admin.templates.documentTypeHint')}
            options={documentTypes.map((type) => ({ value: type.value, label: type.label }))}
            defaultValue={editing?.documentTypeId ?? ''}
            required
          />
          <PickerField
            name="confidentialityId"
            label={translate('admin.templates.confidentiality')}
            hint={translate('admin.templates.confidentialityHint')}
            options={confidentialityLevels.map((level) => ({
              value: level.value,
              label: level.label,
            }))}
            defaultValue={editing?.confidentialityId ?? ''}
            required
          />
          <PickerField
            name="categoryId"
            label={translate('admin.templates.category')}
            hint={translate('admin.templates.categoryHint')}
            options={categories.map((category) => ({
              value: category.value,
              label: category.label,
            }))}
            defaultValue={editing?.categoryId ?? ''}
            clearable
          />
          <PickerField
            name="defaultFolderId"
            label={translate('admin.templates.defaultFolder')}
            hint={translate('admin.templates.defaultFolderHint')}
            options={folders.map((folder) => ({ value: folder.value, label: folder.label }))}
            defaultValue={editing?.defaultFolderId ?? ''}
            clearable
          />
          <TextAreaField
            name="description"
            label={translate('admin.fields.description')}
            defaultValue={editing?.description ?? ''}
          />
          <SwitchField
            name="isActive"
            label={translate('admin.templates.isActive')}
            hint={translate('admin.templates.isActiveHint')}
            defaultChecked={editing?.isActive ?? true}
          />
        </FormDialog>
      )}
    </AdminScreen>
  );
}
