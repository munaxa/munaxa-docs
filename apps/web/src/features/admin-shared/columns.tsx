'use client';

import type { ColumnDef } from '@munaxa/ui';

import type { AdministeredRecord } from '@edms/contracts';
import type { MessageKey } from '@edms/i18n';

import { useTranslate } from '../../app/providers';
import { useSession } from '../../app/providers';
import { StateBadges } from './resource-list';

/**
 * The columns every administered list has, built once.
 *
 * A hook rather than a module of pure functions because a column heading is a translated string, and
 * the locale comes from context. Each builder returns a `ColumnDef`, so a screen's column list stays
 * a readable description of that screen rather than a wall of repeated definitions.
 */
export function useAdminColumns<TRow extends AdministeredRecord>(): {
  readonly state: (options?: {
    readonly system?: (row: TRow) => boolean;
    readonly inactive?: (row: TRow) => boolean;
  }) => ColumnDef<TRow>;
  readonly created: () => ColumnDef<TRow>;
  readonly updated: () => ColumnDef<TRow>;
  readonly count: (id: string, labelKey: MessageKey, of: (row: TRow) => number) => ColumnDef<TRow>;
  readonly yesNo: (id: string, labelKey: MessageKey, of: (row: TRow) => boolean) => ColumnDef<TRow>;
  readonly date: (
    id: string,
    labelKey: MessageKey,
    of: (row: TRow) => string | null,
    emptyKey: MessageKey,
  ) => ColumnDef<TRow>;
} {
  const translate = useTranslate();
  const { locale } = useSession();

  /**
   * A stamp, as a date.
   *
   * Date-only, and formatted in UTC. Both halves of that are deliberate: the row is rendered inside a
   * client component whose first paint comes from the server, and a time formatted in the *machine's*
   * zone differs between the two — which is a hydration mismatch on every row of every list. A
   * calendar date in a fixed zone is the same string on both sides. The exact instant of any change
   * is in the audit trail, which is where somebody asking "when precisely" is going.
   */
  const formatDate = (value: string): string =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(
      new Date(value),
    );

  return {
    state: (options) => ({
      id: 'state',
      header: translate('admin.fields.status'),
      width: 130,
      alwaysVisible: true,
      cell: (row) => (
        <StateBadges
          deleted={row.deletedAt !== null}
          {...(options?.system !== undefined && { system: options.system(row) })}
          {...(options?.inactive !== undefined && { inactive: options.inactive(row) })}
        />
      ),
      // Sorted and searched by the words the badges show, not by the timestamp behind them.
      value: (row) =>
        [
          row.deletedAt === null ? '' : translate('admin.list.deletedBadge'),
          options?.system?.(row) === true ? translate('admin.list.systemBadge') : '',
          options?.inactive?.(row) === true ? translate('admin.list.inactiveBadge') : '',
        ]
          .filter((word) => word !== '')
          .join(' '),
    }),

    created: () => ({
      id: 'createdAt',
      header: translate('admin.fields.createdAt'),
      width: 140,
      sortable: true,
      defaultHidden: true,
      value: (row) => formatDate(row.createdAt),
    }),

    updated: () => ({
      id: 'updatedAt',
      header: translate('admin.fields.updatedAt'),
      width: 140,
      sortable: true,
      value: (row) => formatDate(row.updatedAt),
    }),

    count: (id, labelKey, of) => ({
      id,
      header: translate(labelKey),
      width: 110,
      align: 'end',
      value: (row) => of(row),
    }),

    yesNo: (id, labelKey, of) => ({
      id,
      header: translate(labelKey),
      width: 110,
      value: (row) => translate(of(row) ? 'admin.fields.yes' : 'admin.fields.no'),
    }),

    date: (id, labelKey, of, emptyKey) => ({
      id,
      header: translate(labelKey),
      width: 140,
      sortable: true,
      value: (row) => {
        const value = of(row);
        return value === null ? translate(emptyKey) : formatDate(value);
      },
    }),
  };
}
