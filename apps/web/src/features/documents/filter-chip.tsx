'use client';

import type { ReactNode } from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@munaxa/ui';
import { ChevronDown } from '@munaxa/icons';

import { useTranslate } from '../../app/providers';

export interface FilterChoice {
  readonly value: string;
  readonly label: string;
}

/**
 * One filter, as a chip — Docs v2.
 *
 * "Status · All", "Type · SOP": the field and what it is set to, on the button itself, so the row of
 * chips reads as a sentence describing the list under it. Choosing a value writes it to the URL like
 * every other list filter (`useListNavigation`), so a filtered folder is still a link somebody can
 * send, and the server is what applies it.
 *
 * A menu of radio items rather than a `<select>`: the choice is one-of-many and the menu says so to
 * a screen reader (`menuitemradio`, checked), and the design's chip is a button rather than a field.
 * The reset is an item of its own ("All", "Anyone") rather than a clear button beside the chip, so
 * the way back is where the reader is already looking.
 *
 * A set chip takes the accent surface, so which filters are narrowing the list is visible at a
 * glance and not only by reading every label.
 */
export function FilterChip({
  name,
  value,
  choices,
  resetLabel,
  onChange,
}: {
  /** The field — "Status". */
  readonly name: string;
  /** The current value, or `null` when the filter is not set. */
  readonly value: string | null;
  readonly choices: readonly FilterChoice[];
  /** What "not set" is called for this field — "All", "Anyone". */
  readonly resetLabel: string;
  readonly onChange: (value: string | null) => void;
}): ReactNode {
  const translate = useTranslate();
  const current = choices.find((choice) => choice.value === value) ?? null;
  const set = current !== null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={`focus-visible:ring-ring flex h-[30px] items-center gap-1.5 rounded-lg border px-2.5 text-[12.5px] whitespace-nowrap focus-visible:ring-2 focus-visible:outline-none ${
          set
            ? 'border-primary-200 bg-accent text-accent-foreground'
            : 'border-border bg-card text-muted-foreground hover:text-foreground'
        }`}
      >
        {translate('documents.filter.chip', {
          name,
          value: current?.label ?? resetLabel,
        })}
        <ChevronDown className="size-3 opacity-60" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 min-w-44 overflow-y-auto">
        <DropdownMenuRadioGroup
          value={value ?? ''}
          onValueChange={(next) => {
            onChange(next === '' ? null : next);
          }}
        >
          <DropdownMenuRadioItem value="">{resetLabel}</DropdownMenuRadioItem>
          {choices.map((choice) => (
            <DropdownMenuRadioItem key={choice.value} value={choice.value}>
              {choice.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
