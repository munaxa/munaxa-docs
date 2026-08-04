'use client';

import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import { type ReactNode, useState } from 'react';

import type { NumberSegment, NumberingRule } from '@edms/contracts';
import { NumberSegmentKind, SequenceResetScope, type SequenceResetScopeKey } from '@edms/domain';
import type { MessageKey } from '@edms/i18n';

import { useTranslate } from '../../app/providers';
import type { ListState } from '../../lib/admin/list-state';
import {
  AdminScreen,
  CheckboxGroupField,
  FormDialog,
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
  createNumberingRule,
  deleteNumberingRule,
  restoreNumberingRule,
  updateNumberingRule,
} from './actions';
import { NumberingBuilder, type Separator } from './numbering-builder';

export const NUMBERING_SORT_FIELDS = ['createdAt', 'updatedAt', 'name', 'key'] as const;

const RESET_LABELS: Readonly<Record<SequenceResetScopeKey, MessageKey>> = {
  NEVER: 'admin.numbering.resetNEVER',
  YEARLY: 'admin.numbering.resetYEARLY',
  MONTHLY: 'admin.numbering.resetMONTHLY',
  PER_COMPANY: 'admin.numbering.resetPER_COMPANY',
  PER_ENTITY: 'admin.numbering.resetPER_ENTITY',
  PER_BRANCH: 'admin.numbering.resetPER_BRANCH',
  PER_DEPARTMENT: 'admin.numbering.resetPER_DEPARTMENT',
  PER_DOCUMENT_TYPE: 'admin.numbering.resetPER_DOCUMENT_TYPE',
  PER_CATEGORY: 'admin.numbering.resetPER_CATEGORY',
};

/** A sensible first rule: a type code, the year, and a four-digit counter. */
const STARTING_SEGMENTS: readonly NumberSegment[] = [
  { kind: NumberSegmentKind.DOCUMENT_TYPE_CODE, optional: false },
  { kind: NumberSegmentKind.YEAR, digits: 4 },
  { kind: NumberSegmentKind.SEQUENCE, padding: 4 },
];

/**
 * Numbering rules — how a document number is built.
 *
 * A number is issued once, never changed and never reused, so the parts of a rule that decide its
 * written form are the parts that cannot move once a series is live. The padding is the sharpest case:
 * widening it mid-series would give one number two textual forms (`0042` and `00042`), which is the
 * same defect as reusing one. The API refuses it, and the row says so before somebody tries.
 *
 * The segments and the sample are the whole screen; both live in the builder beside them.
 */
export function NumberingScreen({
  rows,
  total,
  state,
}: {
  rows: readonly NumberingRule[];
  total: number;
  state: ListState;
}): ReactNode {
  const translate = useTranslate();
  const router = useRouter();
  const column = useAdminColumns<NumberingRule>();
  const { refresh } = useListNavigation(state);
  const [editing, setEditing] = useState<NumberingRule | null | undefined>(undefined);
  // The segments are the one part of this form that is not a field, so the screen owns them and hands
  // them to the builder. Keeping them typed here rather than serialised into a hidden input is what
  // lets the discriminated union survive the round trip through the form.
  const [segments, setSegments] = useState<readonly NumberSegment[]>(STARTING_SEGMENTS);
  const [separator, setSeparator] = useState<Separator>('-');

  const open = (rule: NumberingRule | null): void => {
    setSegments(rule === null ? STARTING_SEGMENTS : rule.segments);
    setSeparator(rule === null ? '-' : rule.separator);
    setEditing(rule);
  };

  return (
    <AdminScreen titleKey="admin.numbering.title" descriptionKey="admin.numbering.description">
      <ResourceList<NumberingRule>
        rows={rows}
        total={total}
        state={state}
        getRowId={(row) => row.id}
        getRowName={(row) => row.name}
        isDeleted={(row) => row.deletedAt !== null}
        onCreate={() => {
          open(null);
        }}
        onEdit={open}
        onDelete={(row) => deleteNumberingRule(row.id, row.version)}
        onRestore={(row) => restoreNumberingRule(row.id, row.version)}
        deleteBlocked={(row) =>
          row.documentTypeCount === 0
            ? null
            : translate('admin.list.inUseByTypes', { count: row.documentTypeCount })
        }
        extraActions={(row) => [
          {
            id: 'reservations',
            label: translate('admin.numbering.reservations.action'),
            onSelect: () => {
              router.push(`/admin/numbering/${row.id}/reservations` as Route);
            },
          },
        ]}
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
            width: 170,
            sortable: true,
            value: (row) => row.key,
          },
          {
            id: 'sample',
            header: translate('admin.numbering.sample'),
            width: 200,
            // Rendered from the row's own `sample`, which the API produced with the real formatter.
            value: (row) => row.sample,
          },
          {
            id: 'resetScope',
            header: translate('admin.numbering.resetScope'),
            value: (row) =>
              row.resetScope.map((scope) => translate(RESET_LABELS[scope])).join(', '),
          },
          column.yesNo(
            'strictGapless',
            'admin.numbering.strictGapless',
            (row) => row.strictGapless,
          ),
          column.count('sequenceCount', 'admin.numbering.segments', (row) => row.sequenceCount),
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
            { name: translate('admin.numbering.one') },
          )}
          description={
            editing !== null && editing.sequenceCount > 0
              ? translate('admin.numbering.paddingLocked')
              : undefined
          }
          onClose={() => {
            setEditing(undefined);
          }}
          onSaved={refresh}
          onSubmit={(data) => {
            const resetScope = list(data, 'resetScope') as SequenceResetScopeKey[];
            const body = {
              name: text(data, 'name'),
              separator,
              segments,
              resetScope,
              reserveOnSubmit: flag(data, 'reserveOnSubmit'),
              strictGapless: flag(data, 'strictGapless'),
            };
            if (editing === null) {
              return createNumberingRule({
                key: text(data, 'key'),
                ...body,
                ...(text(data, 'description') !== '' && {
                  description: text(data, 'description'),
                }),
              });
            }
            const patch = changedFields(
              {
                name: editing.name,
                description: editing.description,
                separator: editing.separator,
                segments: [...editing.segments],
                resetScope: [...editing.resetScope],
                reserveOnSubmit: editing.reserveOnSubmit,
                strictGapless: editing.strictGapless,
              },
              { ...body, description: nullableText(data, 'description') },
            );
            return isEmptyPatch(patch)
              ? unchanged()
              : updateNumberingRule(editing.id, editing.version, patch);
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

          <NumberingBuilder
            segments={segments}
            separator={separator}
            onSegmentsChange={setSegments}
            onSeparatorChange={setSeparator}
          />

          <CheckboxGroupField
            name="resetScope"
            label={translate('admin.numbering.resetScope')}
            hint={translate('admin.numbering.resetScopeHint')}
            defaultValue={editing?.resetScope ?? [SequenceResetScope.YEARLY]}
            choices={Object.values(SequenceResetScope).map((scope) => ({
              value: scope,
              label: translate(RESET_LABELS[scope]),
            }))}
          />
          <SwitchField
            name="reserveOnSubmit"
            label={translate('admin.numbering.reserveOnSubmit')}
            hint={translate('admin.numbering.reserveOnSubmitHint')}
            defaultChecked={editing?.reserveOnSubmit ?? true}
          />
          <SwitchField
            name="strictGapless"
            label={translate('admin.numbering.strictGapless')}
            hint={translate('admin.numbering.strictGaplessHint')}
            defaultChecked={editing?.strictGapless ?? false}
          />
        </FormDialog>
      )}
    </AdminScreen>
  );
}
