'use client';

import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import { type ReactNode, useState } from 'react';

import {
  Badge,
  Button,
  Card,
  EmptyState,
  Page,
  PageHeader,
  Pagination,
  Select,
  Toolbar,
  useToast,
} from '@munaxa/ui';

import type { NumberReservation, NumberingRule } from '@edms/contracts';
import type { NumberReservationStateKey } from '@edms/domain';

import { useTranslate } from '../../app/providers';
import { FormDialog, NumberField, TextField, integer, optionalText } from '../admin-shared';
import { holdNumberBlock, voidHeldNumber } from './actions';

const STATE_TONES: Record<NumberReservationStateKey, 'muted' | 'warning' | 'danger' | 'success'> = {
  RESERVED: 'warning',
  ASSIGNED: 'success',
  VOIDED: 'muted',
  HELD: 'danger',
};

const STATE_FILTERS: readonly (NumberReservationStateKey | '')[] = [
  '',
  'RESERVED',
  'ASSIGNED',
  'VOIDED',
  'HELD',
];

/**
 * Every value a rule has drawn, whatever became of it.
 *
 * The voided rows are deliberately as visible as the assigned ones: ADR-0004 accepts gaps in a
 * series and forbids filling them, so the screen's job is to *explain* each gap — this value was
 * drawn, this is what became of it — rather than to hide it and leave an auditor counting.
 *
 * A held block is created here (§3) and each held value is voidable here. Nothing else is: a
 * reserved value belongs to its approval, and an assigned one belongs to its document forever.
 */
export function NumberingReservationsScreen({
  rule,
  rows,
  total,
  page,
  state,
}: {
  readonly rule: NumberingRule;
  readonly rows: readonly NumberReservation[];
  readonly total: number;
  readonly page: number;
  readonly state: NumberReservationStateKey | '';
}): ReactNode {
  const translate = useTranslate();
  const router = useRouter();
  const toast = useToast();
  const [holding, setHolding] = useState(false);
  const [voiding, setVoiding] = useState<NumberReservation | null>(null);

  const navigate = (nextPage: number, nextState: string): void => {
    const query = new URLSearchParams();
    if (nextPage > 1) {
      query.set('page', String(nextPage));
    }
    if (nextState !== '') {
      query.set('state', nextState);
    }
    const suffix = query.size === 0 ? '' : `?${query.toString()}`;
    router.push(`/admin/numbering/${rule.id}/reservations${suffix}` as Route);
  };

  return (
    /*
      `Page` + `PageHeader` — Phase 7.3, and the last hand-written page header in the product.

      It reproduced `PageHeader`'s markup by hand: a wrapping flex row, a `text-2xl font-semibold`
      title, a dimmed description under it and an action pinned to the end. Every administration
      screen beside it gets that from `AdminScreen`, which is `PageHeader` with the title and
      description read from message keys. This one could not use `AdminScreen` because its title is
      *interpolated* — it names the rule — so it composes the same two primitives directly rather
      than hand-drawing what they already draw.
    */
    <Page gap={4}>
      <PageHeader
        title={translate('admin.numbering.reservations.title', { rule: rule.name })}
        description={translate('admin.numbering.reservations.description')}
        actions={
          <Button type="button" onClick={() => setHolding(true)}>
            {translate('admin.numbering.reservations.holdBlock')}
          </Button>
        }
      />

      <Toolbar label={translate('admin.numbering.reservations.stateFilter')}>
        <Select
          value={state}
          aria-label={translate('admin.numbering.reservations.stateFilter')}
          className="w-44"
          onChange={(event) => {
            navigate(1, event.currentTarget.value);
          }}
        >
          {STATE_FILTERS.map((option) => (
            <option key={option} value={option}>
              {option === ''
                ? translate('admin.numbering.reservations.allStates')
                : translate(`admin.numbering.reservations.state.${option}`)}
            </option>
          ))}
        </Select>
      </Toolbar>

      {rows.length === 0 ? (
        <EmptyState
          title={translate('admin.numbering.reservations.empty')}
          description={translate('admin.numbering.reservations.emptyDescription')}
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.id}>
              <Card className="flex flex-wrap items-center gap-3">
                <span className="min-w-0 flex-1 truncate font-medium">{row.formatted}</span>
                <Badge tone={STATE_TONES[row.state]}>
                  {translate(`admin.numbering.reservations.state.${row.state}`)}
                </Badge>
                <Badge tone="muted">
                  {translate(`admin.numbering.reservations.origin.${row.origin}`)}
                </Badge>
                <span className="text-sm opacity-70">
                  {new Date(row.reservedAt).toLocaleDateString()}
                </span>
                {row.voidReason !== null && (
                  <span className="text-sm opacity-70">{row.voidReason}</span>
                )}
                {row.note !== null && <span className="text-sm opacity-70">{row.note}</span>}
                {row.state === 'HELD' && (
                  <Button type="button" variant="outline" onClick={() => setVoiding(row)}>
                    {translate('admin.numbering.reservations.void')}
                  </Button>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}

      <Pagination
        page={page}
        pageCount={Math.max(1, Math.ceil(total / 25))}
        onPageChange={(next) => {
          navigate(next, state);
        }}
        labels={{
          nav: translate('admin.grid.pagination'),
          previous: translate('admin.grid.previousPage'),
          next: translate('admin.grid.nextPage'),
          page: translate('admin.grid.page'),
        }}
      />

      {holding && (
        <FormDialog
          open
          title={translate('admin.numbering.reservations.holdBlock')}
          description={translate('admin.numbering.reservations.holdBlockDescription')}
          onClose={() => setHolding(false)}
          onSubmit={(data) =>
            holdNumberBlock(rule.id, {
              count: integer(data, 'count'),
              note: optionalText(data, 'note'),
              context: {
                ...(optionalText(data, 'entityCode') !== undefined && {
                  entityCode: optionalText(data, 'entityCode'),
                }),
                ...(optionalText(data, 'departmentCode') !== undefined && {
                  departmentCode: optionalText(data, 'departmentCode'),
                }),
                ...(optionalText(data, 'documentTypeCode') !== undefined && {
                  documentTypeCode: optionalText(data, 'documentTypeCode'),
                }),
              },
            }).then((result) => {
              if (result.ok) {
                toast.success(
                  translate('admin.numbering.reservations.held', {
                    count: result.value.values.length,
                  }),
                );
              }
              return result;
            })
          }
          onSaved={() => {
            router.refresh();
          }}
        >
          <NumberField
            name="count"
            label={translate('admin.numbering.reservations.count')}
            required
            minimum={1}
            maximum={100}
            defaultValue={1}
          />
          {/* The codes name which series the block comes from — the same series a document with
              these codes would draw from. Only what the rule renders matters; the rest is ignored
              by the scope key. */}
          <TextField
            name="entityCode"
            label={translate('admin.numbering.reservations.entityCode')}
          />
          <TextField
            name="departmentCode"
            label={translate('admin.numbering.reservations.departmentCode')}
          />
          <TextField
            name="documentTypeCode"
            label={translate('admin.numbering.reservations.documentTypeCode')}
          />
          <TextField name="note" label={translate('admin.numbering.reservations.note')} />
        </FormDialog>
      )}

      {voiding !== null && (
        <FormDialog
          open
          title={translate('admin.numbering.reservations.void')}
          description={translate('admin.numbering.reservations.voidWarning', {
            value: voiding.formatted,
          })}
          onClose={() => setVoiding(null)}
          onSubmit={(data) =>
            voidHeldNumber(rule.id, voiding.id, { reason: optionalText(data, 'reason') ?? '' })
          }
          onSaved={() => {
            router.refresh();
          }}
        >
          <TextField
            name="reason"
            label={translate('admin.numbering.reservations.voidReason')}
            required
          />
        </FormDialog>
      )}
    </Page>
  );
}
