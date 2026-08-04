'use client';

import { type ReactNode, useState } from 'react';

import { Field, MultiSelect, Radio } from '@munaxa/ui';

import { useTranslate } from '../../app/providers';
import type { Choice } from '../admin-shared';

/**
 * The departments a person belongs to, one of which is primary.
 *
 * Controlled rather than two independent fields, because the two are not independent: the primary
 * department has to be one of the chosen ones. Offering "primary" as a separate picker over every
 * department in the tenant would let somebody nominate a department the person is not in — a
 * combination the form would accept and the routing rules could not act on.
 *
 * Posts `departmentId` once per membership and `primaryDepartmentId` once, so the submit handler
 * rebuilds the list without needing to reach into this component's state.
 */
export function DepartmentMemberships({
  departments,
  defaultValue,
}: {
  departments: readonly Choice[];
  readonly defaultValue: readonly { readonly departmentId: string; readonly isPrimary: boolean }[];
}): ReactNode {
  const translate = useTranslate();
  const [chosen, setChosen] = useState<string[]>(
    defaultValue.map((membership) => membership.departmentId),
  );
  const [primary, setPrimary] = useState<string>(
    defaultValue.find((membership) => membership.isPrimary)?.departmentId ?? '',
  );

  const labelFor = (id: string): string =>
    departments.find((department) => department.value === id)?.label ?? id;

  return (
    <>
      <Field label={translate('admin.users.departments')}>
        <>
          <MultiSelect
            options={departments.map((department) => ({
              value: department.value,
              label: department.label,
            }))}
            value={chosen}
            onChange={(next) => {
              setChosen(next);
              // A primary that is no longer a membership stops being the primary. Keeping it would
              // post a combination the contract's own index refuses.
              if (primary !== '' && !next.includes(primary)) {
                setPrimary('');
              }
            }}
            labels={{
              searchPlaceholder: translate('admin.list.search'),
              empty: translate('admin.list.empty'),
            }}
          />
          {chosen.map((id) => (
            <input key={id} type="hidden" name="departmentId" value={id} />
          ))}
        </>
      </Field>

      {chosen.length === 0 ? null : (
        <Field
          label={translate('admin.users.primaryDepartment')}
          hint={translate('admin.users.primaryDepartmentHint')}
        >
          <div className="flex flex-col gap-2">
            {chosen.map((id) => (
              <Radio
                key={id}
                name="primaryDepartmentId"
                value={id}
                checked={primary === id}
                onChange={() => {
                  setPrimary(id);
                }}
                label={labelFor(id)}
              />
            ))}
          </div>
        </Field>
      )}
    </>
  );
}
