'use client';

import type { Route } from 'next';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, type ReactNode, useState } from 'react';

import {
  Badge,
  Button,
  Card,
  Input,
  Select,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  useToast,
} from '@munaxa/ui';

import type {
  ExportFormatValue,
  ReportDefinition,
  ReportDescriptor,
  ReportExport,
  ReportPage,
} from '@edms/contracts';
import type { MessageKey } from '@edms/i18n';

import { useTranslate } from '../../app/providers';
import { ReportChart } from './report-chart';
import {
  deleteReportDefinition,
  downloadReportExport,
  requestReportExport,
  saveReportDefinition,
} from './actions';

/**
 * The reports screen — 16 §2's `reports/`, which has been named since Phase 0 and never existed.
 *
 * **The URL is the whole query**, exactly as it is for the audit search, the document list and
 * search: a report is a question somebody asks twice and sends to a colleague, and a report whose
 * parameters lived in component state would be a page nobody could link to. The rows come from the
 * server component that renders this; the only things this component *does* are change the URL,
 * queue an export, take its link, and save a set of parameters.
 *
 * **The report list contains only what the caller may run.** The server resolved that — a report
 * they may not run is absent from `reports`, not disabled in it, which is Phase 13's tile rule
 * applied to a menu: a greyed-out row named "Deleted documents" tells somebody the product keeps
 * one.
 *
 * **The parameter form is built from the descriptor**, not written per report. Ten hand-written
 * forms would be ten places for a filter to be spelled differently from the one the API validates
 * against, and the descriptor is the same catalogue entry the query was built from — so a
 * parameter added to a report appears here with no change to this file.
 *
 * **The table renders whether or not there is a chart.** A chart is a picture of numbers somebody
 * may need to read, copy or check.
 */
export function ReportsScreen({
  reports,
  selected,
  page,
  definitions,
  exports,
}: {
  readonly reports: readonly ReportDescriptor[];
  readonly selected: ReportDescriptor | null;
  readonly page: ReportPage | null;
  readonly definitions: readonly ReportDefinition[];
  readonly exports: readonly ReportExport[];
}): ReactNode {
  const translate = useTranslate();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const value = (key: string): string => params.get(key) ?? '';

  const parametersFromUrl = (): Record<string, string> => {
    const parameters: Record<string, string> = {};
    for (const parameter of selected?.parameters ?? []) {
      const supplied = value(parameter.name);
      if (supplied !== '') {
        parameters[parameter.name] = supplied;
      }
    }
    return parameters;
  };

  const choose = (key: string): void => {
    // Choosing a different report clears the parameters rather than carrying them: two reports
    // that happen to share a parameter name do not share its meaning, and a filter silently
    // inherited from the last report is a report over rows nobody asked about.
    router.push(`${pathname}?report=${encodeURIComponent(key)}` as Route);
  };

  const apply = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (selected === null) {
      return;
    }
    const form = new FormData(event.currentTarget);
    const next = new URLSearchParams({ report: selected.key });
    for (const parameter of selected.parameters) {
      const entry = form.get(parameter.name);
      if (typeof entry === 'string' && entry.trim() !== '') {
        next.set(parameter.name, entry.trim());
      }
    }
    router.push(`${pathname}?${next.toString()}` as Route);
  };

  const startExport = async (format: ExportFormatValue): Promise<void> => {
    if (selected === null) {
      return;
    }
    setBusy(true);
    // The parameters the screen is *showing*. An export that quietly covered something else would
    // be a file somebody circulates as the answer to a question it was never asked.
    const result = await requestReportExport(selected.key, {
      format,
      parameters: parametersFromUrl(),
    });
    setBusy(false);
    if (result.ok) {
      toast.success(translate('reports.export.queued'));
      router.refresh();
      return;
    }
    toast.error(result.detail ?? translate('reports.export.failed'));
  };

  const take = async (id: string): Promise<void> => {
    const result = await downloadReportExport(id);
    if (result.ok) {
      // A new tab rather than a navigation: the signed URL is a capability for one object, and
      // replacing the page with it would lose the screen somebody is working on.
      window.open(result.value.url, '_blank', 'noopener,noreferrer');
      return;
    }
    toast.error(result.detail ?? translate('reports.export.failed'));
  };

  const save = async (): Promise<void> => {
    if (selected === null) {
      return;
    }
    const name = window.prompt(translate('reports.definitions.namePrompt'));
    if (name === null || name.trim() === '') {
      return;
    }
    const result = await saveReportDefinition({
      key: selected.key,
      name: name.trim(),
      parameters: parametersFromUrl(),
    });
    if (result.ok) {
      toast.success(translate('reports.definitions.saved'));
      router.refresh();
      return;
    }
    toast.error(result.detail ?? translate('reports.definitions.failed'));
  };

  const forget = async (id: string): Promise<void> => {
    const result = await deleteReportDefinition(id);
    if (result.ok) {
      router.refresh();
      return;
    }
    toast.error(result.detail ?? translate('reports.definitions.failed'));
  };

  const open = (definition: ReportDefinition): void => {
    const next = new URLSearchParams({ report: definition.key });
    for (const [name, parameter] of Object.entries(definition.parameters)) {
      next.set(name, parameter);
    }
    router.push(`${pathname}?${next.toString()}` as Route);
  };

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{translate('reports.title')}</h1>
        <p className="text-muted-foreground text-sm">{translate('reports.subtitle')}</p>
      </header>

      <Card className="flex flex-col gap-3 p-4">
        <h2 className="text-sm font-medium">{translate('reports.available')}</h2>
        <div className="flex flex-wrap gap-2">
          {reports.map((report) => (
            <Button
              key={report.key}
              type="button"
              variant={report.key === selected?.key ? 'default' : 'outline'}
              onClick={() => {
                choose(report.key);
              }}
            >
              {labelled(translate, REPORT_LABELS, report.key)}
            </Button>
          ))}
        </div>
        {reports.length === 0 ? (
          <p className="text-muted-foreground text-sm">{translate('reports.noneAvailable')}</p>
        ) : null}
      </Card>

      {definitions.length > 0 ? (
        <Card className="flex flex-col gap-3 p-4">
          <h2 className="text-sm font-medium">{translate('reports.definitions.title')}</h2>
          <ul className="flex flex-col gap-2">
            {definitions.map((definition) => (
              <li key={definition.id} className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  className="text-start text-sm underline"
                  onClick={() => {
                    open(definition);
                  }}
                >
                  {definition.name}
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    void forget(definition.id);
                  }}
                >
                  {translate('reports.definitions.remove')}
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {selected === null ? (
        <Card className="p-6">
          <p className="text-muted-foreground text-sm">{translate('reports.chooseOne')}</p>
        </Card>
      ) : (
        <>
          <Card className="flex flex-col gap-4 p-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-medium">{translate('reports.parameters')}</h2>
              {/*
                Why two people running the same report see different totals, said once on the
                screen rather than left to be discovered. It is the most alarming thing a report
                can do silently.
              */}
              <Badge tone={selected.scoping === 'REACH_SCOPED' ? 'default' : 'muted'}>
                {translate(
                  selected.scoping === 'REACH_SCOPED'
                    ? 'reports.scoping.reach'
                    : 'reports.scoping.tenant',
                )}
              </Badge>
            </div>
            <form className="flex flex-wrap items-end gap-3" onSubmit={apply}>
              {selected.parameters.map((parameter) => (
                <label key={parameter.name} className="flex flex-col gap-1 text-sm">
                  <span>
                    {labelled(translate, PARAMETER_LABELS, parameter.name)}
                    {parameter.required ? ' *' : ''}
                  </span>
                  {parameter.values === null ? (
                    <Input
                      name={parameter.name}
                      type={parameter.kind === 'DATE' ? 'date' : 'text'}
                      defaultValue={value(parameter.name)}
                    />
                  ) : (
                    <Select name={parameter.name} defaultValue={value(parameter.name)}>
                      <option value="">{translate('reports.any')}</option>
                      {parameter.values.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </Select>
                  )}
                </label>
              ))}
              <Button type="submit">{translate('reports.run')}</Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  void save();
                }}
              >
                {translate('reports.definitions.save')}
              </Button>
            </form>
          </Card>

          {page === null ? (
            <Card className="p-6">
              <p className="text-muted-foreground text-sm">{translate('reports.notRunYet')}</p>
            </Card>
          ) : (
            <Card className="flex flex-col gap-4 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm">
                  {translate('reports.rowCount', { count: page.meta.total })}
                </p>
                <div className="flex flex-wrap gap-2">
                  {(['CSV', 'SPREADSHEET_XML', 'PDF'] as const).map((format) => (
                    <Button
                      key={format}
                      type="button"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => {
                        void startExport(format);
                      }}
                    >
                      {translate(FORMAT_LABELS[format])}
                    </Button>
                  ))}
                </div>
              </div>

              <ReportChart descriptor={selected} rows={page.data} />

              {/*
                The platform's `Table` scrolls its own overflow rather than wrapping, which is
                what this needs: a report has as many columns as the catalogue gives it, and a
                table that wrapped would put one row on three lines on the screen somebody is
                reading a hundred rows on.
              */}
              <Table>
                <THead>
                  <TR>
                    {page.columns.map((column) => (
                      <TH key={column.key}>{labelled(translate, COLUMN_LABELS, column.key)}</TH>
                    ))}
                  </TR>
                </THead>
                <TBody>
                  {page.data.map((row, index) => (
                    <TR key={index}>
                      {page.columns.map((column) => (
                        <TD key={column.key}>{cell(row[column.key])}</TD>
                      ))}
                    </TR>
                  ))}
                </TBody>
              </Table>
              {page.data.length === 0 ? (
                <p className="text-muted-foreground text-sm">{translate('reports.empty')}</p>
              ) : null}
            </Card>
          )}
        </>
      )}

      {exports.length > 0 ? (
        <Card className="flex flex-col gap-3 p-4">
          <h2 className="text-sm font-medium">{translate('reports.exports.title')}</h2>
          <ul className="flex flex-col gap-2">
            {exports.map((record) => (
              <li key={record.id} className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-sm">
                  {labelled(translate, REPORT_LABELS, record.reportKey)} · {record.state} ·{' '}
                  {translate('reports.rowCount', { count: record.rowCount })}
                </span>
                <span className="flex items-center gap-2">
                  {/*
                    A truncated export and a lossy PDF are both said out loud, beside the download.
                    A spreadsheet cut off at a round number looks exactly like a complete one, and a
                    PDF full of `?` is worse than none unless somebody is told.
                  */}
                  {record.truncated ? (
                    <Badge tone="warning">{translate('reports.exports.truncated')}</Badge>
                  ) : null}
                  {record.substitutions > 0 ? (
                    <Badge tone="warning">{translate('reports.exports.lossy')}</Badge>
                  ) : null}
                  {record.state === 'COMPLETED' ? (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        void take(record.id);
                      }}
                    >
                      {translate('reports.exports.download')}
                    </Button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

/**
 * A cell, rendered.
 *
 * No formatting beyond what the value is: a document number, an action code and a status are all
 * things somebody filters and exports by, and a phrase in their place would give one value two
 * names — Phase 9's rule for audit codes, restated by Phase 13, and it applies to every column here
 * because a report is the artefact those two rules exist to protect.
 */
function cell(value: unknown): string {
  if (value === null || value === undefined) {
    return '—';
  }
  if (typeof value === 'string') {
    return ISO_INSTANT.test(value) ? value.replace('T', ' ').slice(0, 16) : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  // `ReportPage.data` is `Record<string, unknown>`: the catalogue says what a column holds, the
  // wire type cannot. A column that ever carried an object would render `[object Object]` here, so
  // it is serialised honestly instead — visible, ugly, and obviously not what was intended.
  return JSON.stringify(value);
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * The label lookups, as explicit maps rather than as template-string casts.
 *
 * A report key, a parameter name and a column key all arrive from the API at runtime, so a
 * `\`reports.name.${key}\` as MessageKey` cast would compile for a key that has no catalogue entry
 * and render `reports.name.whatever` to a user. `translate` falls back to the key rather than to a
 * blank precisely so a gap is visible, and these maps make the gap a *build* failure instead: every
 * value below is a real `MessageKey`, checked by the compiler, and a report added to the catalogue
 * without a label here shows its raw key — readable, and obviously unfinished.
 */
function labelled(
  translate: (key: MessageKey) => string,
  map: Readonly<Record<string, MessageKey>>,
  key: string,
): string {
  const message = map[key];
  return message === undefined ? key : translate(message);
}

const REPORT_LABELS: Readonly<Record<string, MessageKey>> = {
  documents: 'reports.name.documents',
  'documents-by-dimension': 'reports.name.documentsByDimension',
  approvals: 'reports.name.approvals',
  workflow: 'reports.name.workflow',
  storage: 'reports.name.storage',
  departments: 'reports.name.departments',
  users: 'reports.name.users',
  'deleted-documents': 'reports.name.deletedDocuments',
  'expired-documents': 'reports.name.expiredDocuments',
  audit: 'reports.name.audit',
};

const PARAMETER_LABELS: Readonly<Record<string, MessageKey>> = {
  from: 'reports.parameter.from',
  to: 'reports.parameter.to',
  libraryId: 'reports.parameter.libraryId',
  folderId: 'reports.parameter.folderId',
  documentTypeId: 'reports.parameter.documentTypeId',
  categoryId: 'reports.parameter.categoryId',
  ownerUserId: 'reports.parameter.ownerUserId',
  status: 'reports.parameter.status',
  state: 'reports.parameter.state',
  dimension: 'reports.parameter.dimension',
  assigneeId: 'reports.parameter.assigneeId',
  overdueOnly: 'reports.parameter.overdueOnly',
  action: 'reports.parameter.action',
  actorId: 'reports.parameter.actorId',
  subjectType: 'reports.parameter.subjectType',
  outcome: 'reports.parameter.outcome',
};

const COLUMN_LABELS: Readonly<Record<string, MessageKey>> = {
  documentNumber: 'reports.column.documentNumber',
  title: 'reports.column.title',
  status: 'reports.column.status',
  documentType: 'reports.column.documentType',
  category: 'reports.column.category',
  confidentiality: 'reports.column.confidentiality',
  library: 'reports.column.library',
  folderPath: 'reports.column.folderPath',
  owner: 'reports.column.owner',
  revisionCount: 'reports.column.revisionCount',
  createdAt: 'reports.column.createdAt',
  updatedAt: 'reports.column.updatedAt',
  label: 'reports.column.label',
  count: 'reports.column.count',
  documentTitle: 'reports.column.documentTitle',
  stage: 'reports.column.stage',
  assignee: 'reports.column.assignee',
  state: 'reports.column.state',
  assignedAt: 'reports.column.assignedAt',
  dueAt: 'reports.column.dueAt',
  decidedAt: 'reports.column.decidedAt',
  hoursToDecide: 'reports.column.hoursToDecide',
  overdue: 'reports.column.overdue',
  period: 'reports.column.period',
  started: 'reports.column.started',
  completed: 'reports.column.completed',
  rejected: 'reports.column.rejected',
  running: 'reports.column.running',
  documents: 'reports.column.documents',
  revisions: 'reports.column.revisions',
  storedBytes: 'reports.column.storedBytes',
  referencedBytes: 'reports.column.referencedBytes',
  department: 'reports.column.department',
  entity: 'reports.column.entity',
  members: 'reports.column.members',
  managers: 'reports.column.managers',
  displayName: 'reports.column.displayName',
  email: 'reports.column.email',
  roles: 'reports.column.roles',
  mfaEnrolled: 'reports.column.mfaEnrolled',
  lastSignInAt: 'reports.column.lastSignInAt',
  deletedAt: 'reports.column.deletedAt',
  deletedBy: 'reports.column.deletedBy',
  deleteReason: 'reports.column.deleteReason',
  cascaded: 'reports.column.cascaded',
  trigger: 'reports.column.trigger',
  disposition: 'reports.column.disposition',
  overdueDays: 'reports.column.overdueDays',
  onLegalHold: 'reports.column.onLegalHold',
  occurredAt: 'reports.column.occurredAt',
  action: 'reports.column.action',
  outcome: 'reports.column.outcome',
  subjectType: 'reports.column.subjectType',
  subjectId: 'reports.column.subjectId',
  actor: 'reports.column.actor',
  reason: 'reports.column.reason',
};

const FORMAT_LABELS: Readonly<Record<ExportFormatValue, MessageKey>> = {
  CSV: 'reports.format.csv',
  SPREADSHEET_XML: 'reports.format.spreadsheet',
  PDF: 'reports.format.pdf',
};
