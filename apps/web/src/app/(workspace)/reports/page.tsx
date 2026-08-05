import type { ReactNode } from 'react';

import type { ReportDefinition, ReportDescriptor, ReportExport, ReportPage } from '@edms/contracts';
import { Permission } from '@edms/domain';

import { AdminForbidden } from '../../../features/admin-shared';
import { ReportsScreen } from '../../../features/reports/reports-screen';
import { adminAccess, adminGet } from '../../../lib/admin/api';

type RawSearchParams = Readonly<Record<string, string | readonly string[] | undefined>>;

/**
 * The reports screen — 16 §2's `reports/`, named in the Phase 0 design and empty until now.
 *
 * Gated on `report:view`, which is the *floor* rather than the whole gate: every report requires
 * more, and the API resolves the rest per report against the ACL resolver. This page does not
 * re-derive any of it — it asks `GET /reports` for the list the caller may actually run, and a
 * report they may not is **absent** from the answer rather than disabled in it. That is Phase 13's
 * tile rule applied to a menu, and it is why this file has one permission check and not ten.
 *
 * **An empty URL runs nothing**, exactly as the audit search does. "Every document in the tenant,
 * newest first" is not an answer to any question somebody came here with, and running it by default
 * would make the most expensive query in the product the one that fires on a stray click.
 *
 * A server component, because reads are (16 §4). The access token stays in its `httpOnly` cookie;
 * the three writes on this screen — queue an export, take its link, save a definition — are server
 * actions beside it.
 */
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}): Promise<ReactNode> {
  const access = await adminAccess(Permission.REPORT_VIEW);
  if (!access.granted) {
    return <AdminForbidden />;
  }

  const params = await searchParams;
  const single = (key: string): string | undefined => {
    const value = params[key];
    const resolved = typeof value === 'string' ? value : value?.[0];
    return typeof resolved === 'string' && resolved.trim() !== '' ? resolved.trim() : undefined;
  };

  const [available, definitions, exports] = await Promise.all([
    adminGet<{ data: ReportDescriptor[] }>('/reports'),
    adminGet<{ data: ReportDefinition[] }>('/reports/definitions?page=1&pageSize=20'),
    adminGet<{ data: ReportExport[] }>('/reports/exports?page=1&pageSize=10'),
  ]);

  const requested = single('report');
  const selected = available.data.find((report) => report.key === requested) ?? null;

  // Every required parameter must be present before the report is run. Running it without one
  // would produce a `422` the screen would have to render as an error, when the honest state is
  // "you have not finished asking yet" — which is what the form renders instead.
  const ready =
    selected !== null &&
    selected.parameters.every(
      (parameter) => !parameter.required || single(parameter.name) !== undefined,
    );

  const page = ready ? await run(selected, single) : null;

  return (
    <ReportsScreen
      reports={available.data}
      selected={selected}
      page={page}
      definitions={definitions.data}
      exports={exports.data}
    />
  );
}

/**
 * One page of the selected report.
 *
 * Only parameters the descriptor declares are forwarded. The API refuses an unknown one — which is
 * the right behaviour there, because a misspelled filter produces a report over more rows than
 * somebody asked about — and forwarding the whole query string would turn a stale link carrying a
 * parameter from a different report into a `422` rather than into a report.
 *
 * A failure is `null` rather than an exception: a report whose parameters no longer parse is a
 * screen that should still render its form.
 */
async function run(
  report: ReportDescriptor,
  single: (key: string) => string | undefined,
): Promise<ReportPage | null> {
  const query = new URLSearchParams({ page: '1', pageSize: '100' });
  for (const parameter of report.parameters) {
    const value = single(parameter.name);
    if (value === undefined) {
      continue;
    }
    // The date inputs are calendar days; the API's range is instants. A day given as `to` means the
    // end of that day, not its first millisecond — otherwise a filter for today returns nothing.
    // The same conversion the audit screen makes, for the same reason.
    query.set(
      parameter.name,
      parameter.kind === 'DATE'
        ? new Date(
            `${value}T${parameter.name === 'to' ? '23:59:59.999' : '00:00:00.000'}Z`,
          ).toISOString()
        : value,
    );
  }
  try {
    return await adminGet<ReportPage>(`/reports/${report.key}?${query.toString()}`);
  } catch {
    return null;
  }
}
