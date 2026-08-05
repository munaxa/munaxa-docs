'use client';

import type { ReactNode } from 'react';

import { BarChart, LineChart } from '@munaxa/ui/charts';

import type { ReportDescriptor } from '@edms/contracts';

import { useSession, useTranslate } from '../../app/providers';

/**
 * The two reports with an axis worth drawing — and charts are in scope here where they were not in
 * Phase 13.
 *
 * Its report declined them and said why: *"nothing on this screen has a time axis; the trends that
 * would earn one are Phase 15's"*. That is exactly right, and it is true of eight of this phase's
 * ten reports as well. Only two are drawn:
 *
 * - `documents-by-dimension` is categorical — a bar per department, type, category, owner or
 *   status. Horizontal, because the labels are department and person names and a vertical bar chart
 *   turns them 45° or truncates them.
 * - `workflow` is a genuine time series — approvals started, completed and rejected per month —
 *   and it is the one thing in this product that has ever had a period to compare against.
 *
 * A chart on a list of documents would be a decoration, and the catalogue's `chart: null` is what
 * says so. This component renders nothing at all for those, rather than an empty axis.
 *
 * ## RTL, which Phase 13 warned is the thing a chart breaks
 *
 * 16 §8 requires RTL verified per screen, and Phase 13's note that *"a chart is the thing that
 * breaks in RTL"* is a warning rather than a prohibition. Two things are done about it here.
 *
 * **The category axis is reversed in Arabic.** A horizontal bar chart reads from the axis outward,
 * and in an RTL document the axis is on the right — so the *order* has to invert too, or the
 * largest bar sits where a reader's eye leaves rather than where it arrives. ECharts does not
 * infer this from the document direction, because the chart is a canvas and knows nothing about
 * the page.
 *
 * **The legend and the tooltip come from the catalogue's own column keys**, which are Latin
 * identifiers, and they are labelled through the translator rather than rendered raw — so an
 * Arabic reader sees Arabic series names beside Arabic categories, and the numerals are formatted
 * by the locale.
 *
 * ## And the chart is never the only representation
 *
 * The table renders beside it, always. 16 §8's "status is never colour alone" generalises: a chart
 * is a picture of numbers somebody may need to read, copy or check, and `@munaxa/ui`'s `Chart`
 * already emits an accessible data table of its own inputs for exactly that reason.
 */
export function ReportChart({
  descriptor,
  rows,
}: {
  readonly descriptor: ReportDescriptor;
  readonly rows: readonly Readonly<Record<string, unknown>>[];
}): ReactNode {
  const translate = useTranslate();
  const { locale } = useSession();
  const rtl = locale === 'ar';

  if (descriptor.chart === null || rows.length === 0) {
    return null;
  }

  if (descriptor.chart === 'CATEGORY') {
    const ordered = rtl ? [...rows].reverse() : rows;
    return (
      <BarChart
        aria-label={translate('reports.chart.breakdown')}
        height={Math.max(220, ordered.length * 28)}
        horizontal
        categories={ordered.map((row) => text(row['label']))}
        series={[
          {
            name: translate('reports.column.count'),
            data: ordered.map((row) => numberOf(row['count'])),
          },
        ]}
      />
    );
  }

  // The time axis, oldest first — and *not* reversed for RTL. A period axis is chronological
  // rather than typographic: Arabic readers read the same calendar left to right, and reversing it
  // would put last month to the right of this one.
  const periods = rows.map((row) => text(row['period']));
  return (
    <LineChart
      aria-label={translate('reports.chart.trend')}
      height={280}
      categories={periods}
      legend
      series={[
        {
          name: translate('reports.column.started'),
          data: rows.map((r) => numberOf(r['started'])),
        },
        {
          name: translate('reports.column.completed'),
          data: rows.map((r) => numberOf(r['completed'])),
        },
        {
          name: translate('reports.column.rejected'),
          data: rows.map((r) => numberOf(r['rejected'])),
        },
      ]}
    />
  );
}

/**
 * A category label, narrowed rather than stringified.
 *
 * `ReportPage.data` is `Record<string, unknown>` — the catalogue says what the columns are, the wire
 * type cannot — so a bare `String(value)` would render `[object Object]` on the axis if a column
 * ever carried one. Narrowing to the two primitives an axis label can be makes that a blank instead.
 */
function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

/** A cell that is not a number draws as a gap rather than as zero — they are different facts. */
function numberOf(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}
