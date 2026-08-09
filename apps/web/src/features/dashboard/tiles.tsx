'use client';

import Link from 'next/link';
import type { Route } from 'next';
import type { ReactNode } from 'react';

import { Card, CardContent, CardHeader, CardTitle, EmptyState, StatCard } from '@munaxa/ui';
import type { Icon } from '@munaxa/icons';

import type { BreakdownTile, CountTile, TileState } from '@edms/contracts';
import type { MessageKey } from '@edms/i18n';

import { useTranslate } from '../../app/providers';

/**
 * The three ways a tile can render, and why there are three rather than two.
 *
 * The API answers `READY`, `FORBIDDEN` or `UNAVAILABLE`, and every one of them needs its own
 * sentence on the screen. Collapsing the last two into "—" would tell somebody who *does* hold the
 * permission that they do not, and somebody who does not that the product is broken. Both send the
 * reader to the wrong person.
 *
 * A `READY` tile with `count: 0` renders the zero. That is a real answer and it is the one the
 * whole screen is for: "nothing is waiting for you" is worth reading.
 */
function tileNote(state: TileState, translate: ReturnType<typeof useTranslate>): string | null {
  if (state === 'FORBIDDEN') {
    return translate('dashboard.tile.forbidden');
  }
  if (state === 'UNAVAILABLE') {
    return translate('dashboard.tile.unavailable');
  }
  return null;
}

/**
 * One counted figure.
 *
 * `href` is what makes the count honest rather than merely true: every number here is a link to the
 * list it summarises, so a reader who doubts it can open the rows behind it. The API guarantees the
 * two agree — both are built from one predicate — and the link is what lets somebody check.
 */
export function CountStat({
  labelKey,
  hintKey,
  tile,
  href,
  tone,
  icon: TileIcon,
}: {
  readonly labelKey: MessageKey;
  readonly hintKey?: MessageKey | undefined;
  readonly tile: CountTile;
  readonly href?: Route | undefined;
  readonly tone?: 'default' | 'warning' | 'danger' | 'muted' | undefined;
  /**
   * The mark for what this figure counts — Phase 7.
   *
   * `StatCard` has had an `icon` slot since the platform shipped it and this product had never
   * passed one, so seven tiles arrived as seven identical rectangles of text and a reader had to
   * read every label to find the one they came for. An icon is what makes a tile recognisable
   * before it is read — and it is also what stops "Overdue" and "Drafts" being distinguishable only
   * by colour, which is the accessibility half of the same argument.
   */
  readonly icon?: Icon | undefined;
}): ReactNode {
  const translate = useTranslate();
  const note = tileNote(tile.state, translate);

  const card = (
    <StatCard
      label={translate(labelKey)}
      // An em dash, never a zero, when there is no answer. A "0" beside "you do not have
      // permission" is the product asserting a figure it just said it would not give.
      value={tile.count === null ? '—' : tile.count.toLocaleString()}
      hint={note ?? (hintKey === undefined ? undefined : translate(hintKey))}
      tone={tile.count === null ? 'muted' : (tone ?? 'default')}
      {...(TileIcon !== undefined && { icon: <TileIcon className="size-4" aria-hidden /> })}
      className="h-full"
    />
  );

  if (href === undefined || tile.count === null) {
    return card;
  }
  return (
    // `transition-shadow` and a lifted shadow on hover, from the platform's own scale — the one
    // affordance that says a tile is a link before the pointer reaches it. Nothing moves, because a
    // grid of seven tiles that all shift on hover is noise rather than feedback.
    <Link
      href={href}
      className="focus-visible:ring-ring rounded-xl transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:outline-none motion-reduce:transition-none"
    >
      {card}
    </Link>
  );
}

/**
 * A `(key, count)` breakdown — documents by status, instances by state, users by state.
 *
 * A definition list rather than a chart. `@munaxa/ui` ships charts and this could have been a
 * donut, but a five-slice donut of enum counts is decoration: the reader wants the numbers, the
 * labels have to be translated anyway, and a chart is the thing that breaks in RTL. Charts belong
 * where a *shape over time* is the message, and nothing on this screen has a time axis — the
 * trends that would earn one are Phase 15's, with the ranges and the export.
 *
 * The keys are rendered through the shared status catalogue rather than a second list of labels
 * here, so a status added to the enum appears with its own word rather than as an identifier.
 */
export function BreakdownCard({
  titleKey,
  hintKey,
  tile,
  labelFor,
}: {
  readonly titleKey: MessageKey;
  readonly hintKey?: MessageKey | undefined;
  readonly tile: BreakdownTile;
  readonly labelFor: (key: string) => string;
}): ReactNode {
  const translate = useTranslate();
  const note = tileNote(tile.state, translate);

  return (
    <Card className="h-full">
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-sm">{translate(titleKey)}</CardTitle>
        {hintKey === undefined ? null : (
          <p className="text-muted-foreground text-xs">{translate(hintKey)}</p>
        )}
      </CardHeader>
      <CardContent className="p-4 pt-0">
        {note !== null ? (
          <p className="text-muted-foreground text-sm">{note}</p>
        ) : tile.entries.length === 0 ? (
          <p className="text-muted-foreground text-sm">0</p>
        ) : (
          // A description list, so a screen reader reads "Draft, 4" as a pair rather than as two
          // unrelated cells — and logical properties throughout, so the figures sit on the correct
          // side under RTL without a second stylesheet (16 §8).
          <dl className="flex flex-col gap-1.5 text-sm">
            {tile.entries.map((entry) => (
              <div key={entry.key} className="flex items-baseline justify-between gap-4">
                <dt className="text-muted-foreground truncate">{labelFor(entry.key)}</dt>
                <dd className="shrink-0 font-medium tabular-nums">
                  {entry.count.toLocaleString()}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

/** A card holding a short list — recents, favourites, activity, delegation. */
export function ListCard({
  titleKey,
  emptyKey,
  hintKey,
  action,
  children,
  isEmpty,
}: {
  readonly titleKey: MessageKey;
  readonly emptyKey: MessageKey;
  readonly hintKey?: MessageKey | undefined;
  readonly action?: ReactNode | undefined;
  readonly children: ReactNode;
  readonly isEmpty: boolean;
}): ReactNode {
  const translate = useTranslate();
  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="flex-row items-start justify-between gap-4 p-4 pb-2">
        <div className="flex min-w-0 flex-col gap-1">
          <CardTitle className="text-sm">{translate(titleKey)}</CardTitle>
          {hintKey === undefined ? null : (
            <p className="text-muted-foreground text-xs">{translate(hintKey)}</p>
          )}
        </div>
        {action === undefined ? null : <div className="shrink-0">{action}</div>}
      </CardHeader>
      <CardContent className="flex-1 p-4 pt-0">
        {/*
          The platform's empty state rather than a muted sentence — Phase 7. `EmptyState` was used
          fourteen times across the product and never here, so five of the dashboard's cards said
          "nothing yet" in body text that read as a value rather than as an absence. The pattern
          gives it the centring and the muted weight that make emptiness legible at a glance, which
          on a screen whose whole job is "what is waiting for me" is the answer somebody is looking
          for as often as the list is.
        */}
        {isEmpty ? <EmptyState title={translate(emptyKey)} className="py-6" /> : children}
      </CardContent>
    </Card>
  );
}
