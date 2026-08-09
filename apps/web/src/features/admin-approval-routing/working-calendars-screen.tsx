'use client';

import { type ReactNode, useState } from 'react';

import { Button, Input, Select } from '@munaxa/ui';

import type { WorkingCalendar } from '@edms/contracts';
import type { MessageKey } from '@edms/i18n';

import { useTranslate } from '../../app/providers';
import type { ListState } from '../../lib/admin/list-state';
import {
  AdminScreen,
  CheckboxGroupField,
  type Choice,
  FormDialog,
  PickerField,
  ResourceList,
  SwitchField,
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
  createWorkingCalendar,
  deleteWorkingCalendar,
  restoreWorkingCalendar,
  updateWorkingCalendar,
} from './actions';

/**
 * Working calendars — the week and the holidays a deadline is counted against.
 *
 * `07-workflow-architecture.md` §6 says Administration owns this, and until Phase 4 Administration
 * had no calendar while `WORKING_DAYS` was the default every stage deadline was authored with. So
 * this screen exists rather than a seam: without it every deadline in the product would silently
 * count Saturdays, and nothing would have said so.
 *
 * Two things here are not obvious and are therefore stated on the form.
 *
 * **The weekend is a list of days, not a pair of switches.** A Friday–Saturday weekend is as ordinary
 * as a Saturday–Sunday one, and a four-day week is a real arrangement.
 *
 * **Exactly one calendar is the default.** Marking a second moves the flag rather than adding one,
 * because a tenant with two defaults has none — the arithmetic would depend on which row a query
 * returned first, and the database refuses the pair outright.
 */
export function WorkingCalendarsScreen({
  rows,
  total,
  state,
  entities,
}: {
  readonly rows: readonly WorkingCalendar[];
  readonly total: number;
  readonly state: ListState;
  readonly entities: readonly Choice[];
}): ReactNode {
  const translate = useTranslate();
  const column = useAdminColumns<WorkingCalendar>();
  const { refresh, setFilter } = useListNavigation(state);
  const [editing, setEditing] = useState<WorkingCalendar | null | undefined>(undefined);
  const [holidays, setHolidays] = useState<readonly HolidayDraft[]>([]);

  const open = (row: WorkingCalendar | null): void => {
    setHolidays(row?.holidays.map((holiday) => ({ day: holiday.day, name: holiday.name })) ?? []);
    setEditing(row);
  };

  return (
    <AdminScreen titleKey="admin.calendars.title" descriptionKey="admin.calendars.description">
      <ResourceList<WorkingCalendar>
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
        onDelete={(row) => deleteWorkingCalendar(row.id, row.version)}
        onRestore={(row) => restoreWorkingCalendar(row.id, row.version)}
        deleteBlocked={(row) => (row.isDefault ? translate('admin.calendars.lastDefault') : null)}
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
            id: 'code',
            header: translate('admin.fields.code'),
            width: 140,
            sortable: true,
            value: (row) => row.code,
          },
          {
            id: 'entity',
            header: translate('admin.calendars.entity'),
            width: 200,
            value: (row) => row.entityName ?? translate('admin.calendars.wholeOrganisation'),
          },
          {
            id: 'weekend',
            header: translate('admin.calendars.weekend'),
            width: 200,
            value: (row) => row.weekendDays.map((day) => translate(dayKey(day))).join(', '),
          },
          column.count('holidays', 'admin.calendars.holidays', (row) => row.holidays.length),
          column.yesNo('isDefault', 'admin.calendars.isDefault', (row) => row.isDefault),
          column.state({ inactive: (row) => !row.isActive }),
          column.updated(),
        ]}
      />

      {editing === undefined ? null : (
        <FormDialog
          open
          title={translate(
            editing === null ? 'admin.actions.createTitle' : 'admin.actions.editTitle',
            { name: translate('admin.calendars.one') },
          )}
          description={translate('admin.calendars.timeZone', {
            zone: editing?.timeZone ?? rows[0]?.timeZone ?? 'UTC',
          })}
          onClose={() => {
            setEditing(undefined);
          }}
          onSaved={refresh}
          onSubmit={(data) => {
            // The days come back as strings from the checkbox group; the contract wants numbers,
            // and converting here rather than in the schema keeps the schema the same shape the API
            // validates against.
            const weekendDays = list(data, 'weekendDays').map(Number);
            const cleaned = holidays.filter(
              (holiday) => holiday.day !== '' && holiday.name.trim() !== '',
            );
            if (editing === null) {
              return createWorkingCalendar({
                code: text(data, 'code'),
                name: text(data, 'name'),
                entityId: nullableText(data, 'entityId'),
                weekendDays,
                isDefault: flag(data, 'isDefault'),
                holidays: cleaned,
              });
            }
            const patch = changedFields(
              {
                name: editing.name,
                entityId: editing.entityId,
                weekendDays: editing.weekendDays,
                isDefault: editing.isDefault,
                isActive: editing.isActive,
                holidays: editing.holidays.map((holiday) => ({
                  day: holiday.day,
                  name: holiday.name,
                })),
              },
              {
                name: text(data, 'name'),
                entityId: nullableText(data, 'entityId'),
                weekendDays,
                isDefault: flag(data, 'isDefault'),
                isActive: flag(data, 'isActive'),
                holidays: cleaned,
              },
            );
            return isEmptyPatch(patch)
              ? unchanged()
              : updateWorkingCalendar(editing.id, editing.version, patch);
          }}
        >
          {editing === null ? (
            <TextField name="code" label={translate('admin.fields.code')} maxLength={16} required />
          ) : (
            <TextField
              name="codeDisplay"
              label={translate('admin.fields.code')}
              defaultValue={editing.code}
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
          <PickerField
            name="entityId"
            label={translate('admin.calendars.entity')}
            options={entities}
            defaultValue={editing?.entityId ?? ''}
            placeholder={translate('admin.calendars.wholeOrganisation')}
          />
          <CheckboxGroupField
            name="weekendDays"
            label={translate('admin.calendars.weekend')}
            choices={WEEKDAYS.map((day) => ({
              value: String(day),
              label: translate(dayKey(day)),
            }))}
            defaultValue={(editing?.weekendDays ?? [6, 7]).map(String)}
          />
          <SwitchField
            name="isDefault"
            label={translate('admin.calendars.isDefault')}
            hint={translate('admin.calendars.isDefaultHint')}
            defaultChecked={editing?.isDefault ?? false}
          />
          <HolidayEditor value={holidays} onChange={setHolidays} />
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

interface HolidayDraft {
  readonly day: string;
  readonly name: string;
}

/**
 * A year's holidays, edited as a set.
 *
 * Not a sub-form with its own save. A year's public holidays are loaded at once and corrected at
 * once, and a per-holiday endpoint would make "the 2027 list" forty requests that can half-succeed
 * — which is the state an administrator can neither see nor undo.
 */
function HolidayEditor({
  value,
  onChange,
}: {
  readonly value: readonly HolidayDraft[];
  readonly onChange: (next: readonly HolidayDraft[]) => void;
}): ReactNode {
  const translate = useTranslate();

  const update = (index: number, patch: Partial<HolidayDraft>): void => {
    onChange(value.map((holiday, at) => (at === index ? { ...holiday, ...patch } : holiday)));
  };

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium">{translate('admin.calendars.holidays')}</legend>
      {value.map((holiday, index) => (
        // The position is the key. Safe here and only here, because the list is never reordered and
        // never filtered while the form is open — a row's position genuinely is its identity, and a
        // synthesised id would be one more thing to keep in step with the array it describes.
        <div key={`holiday-${String(index)}`} className="flex items-center gap-2">
          <Input
            type="date"
            value={holiday.day}
            aria-label={translate('admin.calendars.holidayDate')}
            onChange={(event) => {
              update(index, { day: event.currentTarget.value });
            }}
          />
          <Input
            value={holiday.name}
            aria-label={translate('admin.calendars.holidayName')}
            className="flex-1"
            onChange={(event) => {
              update(index, { name: event.currentTarget.value });
            }}
          />
          <Button
            variant="ghost"
            type="button"
            onClick={() => {
              onChange(value.filter((_, at) => at !== index));
            }}
          >
            {translate('admin.actions.delete')}
          </Button>
        </div>
      ))}
      <div>
        <Button
          variant="secondary"
          type="button"
          onClick={() => {
            onChange([...value, { day: '', name: '' }]);
          }}
        >
          {translate('admin.calendars.addHoliday')}
        </Button>
      </div>
    </fieldset>
  );
}

/** ISO-8601 weekday numbers: 1 is Monday through 7 is Sunday, which is what the API stores. */
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

function dayKey(day: number): MessageKey {
  return `admin.calendars.day${day}` as MessageKey;
}
