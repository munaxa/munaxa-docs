import { Permission, type PermissionKey } from '@edms/domain';

/**
 * The reports this product has, as data.
 *
 * ---
 *
 * ## The two rules, stated once so a report added later inherits them rather than re-deriving them
 *
 * Every phase before this one narrowed. Phase 8 pushed a predicate into the search query; Phase 13
 * refused to answer a count for anybody but the caller and made a tenant-wide tile *absent rather
 * than zero*; Phase 14 made a document absent from a list **and from its total**. A report inverts
 * that by construction — it is the first thing in the product designed to aggregate across
 * everything — so the two rules below are what stop it becoming the door around all three.
 *
 * **1. A report never widens the audience of the surface it summarises.** `permissions` is a
 * conjunction, not a choice: every entry in it must be held, resolved through `ACL_RESOLVER`
 * against the tenant node, before a row is read. `report:view` is on every row because it is the
 * permission for "may ask an aggregate question about this tenant" and 08 §6 grants it; it is
 * never *alone* on a report whose rows an earlier phase put behind a second gate. So the deleted
 * report also requires `document:restore` (ADR-0010 §2's own gate on the recycle bin), the expired
 * report also requires `retention:manage`, the audit report also requires `audit:view`, the users
 * report also requires `user:manage` and the departments report also requires `org:manage` — the
 * last two being exactly what Phase 13 gated the equivalent tiles on. A report that reached a row
 * its own screen refuses would be a second door, and the door would be the quiet one.
 *
 * **2. A report's rows are scoped by the caller's reach wherever its subject has reach.** That is
 * `REACH_SCOPED` below, and it is not a property this module implements: the source ports are
 * implemented by the module that owns the table, over the *same* predicate its list is built from —
 * `PrismaDocumentRepository.whereFor` and the `visibilityFilter` regions Phase 14 put inside it. A
 * reporting module with its own SQL would have to re-derive the walk, and the day the two disagreed
 * the report would be the one somebody printed.
 *
 * `TENANT_WIDE` is the honest name for the rest, and it is a smaller set than it looks. Storage,
 * users and departments have no per-row reach to apply — a blob is not in a folder anybody was
 * granted, an account is not filed under a library — so their gate is the whole of their
 * discrimination, and it is the gate 08 §6 already assigns. The audit report is `TENANT_WIDE` for a
 * decision rather than for a shortcut: 08 §10 records that the audit *search* is deliberately not
 * ACL-filtered, because it crosses every subject and `audit:view` is the filter. A report over the
 * trail is that same thing wearing a different name, so it is answered **through the audit module's
 * own reader** rather than by a second query beside it, and `report:view` cannot reach it.
 *
 * ---
 *
 * ## Why the catalogue is fixed data rather than rows in a table
 *
 * `REPORT_DEFINITION_REPOSITORY` exists and Phase 15 binds it — to a *saved* definition, which is a
 * name and a set of parameters over one of the keys below. What it deliberately does not hold is
 * the query. A definition carrying SQL, or a column list, or a table name, is the moment
 * `02 §3`'s constraint at the head of `application/ports.ts` stops being enforceable: "reports read
 * from read models, never from another module's tables … that constraint is what keeps a reporting
 * query from quietly becoming the reason a schema cannot change". A tenant that could author a
 * query would be a tenant that could pin a column, and no migration would ever again be a decision
 * this repository alone could take.
 *
 * So the *shape* of every report is here, in code, reviewed with the module whose table answers it;
 * what a person saves is which report and which parameters.
 */

/** How a report's rows are narrowed to the caller, beyond the gate that let them ask at all. */
export const ReportScoping = {
  /**
   * Filtered row by row by the caller's reach, in SQL, by the module that owns the table.
   *
   * The total obeys it too. 08 §7's Query row is explicit that fetch-then-filter "leaks totals,
   * facet counts and page boundaries", and a report is mostly totals — so a row the caller cannot
   * reach is absent from the page *and* from `meta.total`, exactly as Phase 14 made the document
   * list behave.
   */
  REACH_SCOPED: 'REACH_SCOPED',
  /** No per-row reach exists for this subject; the permissions above are the whole filter. */
  TENANT_WIDE: 'TENANT_WIDE',
} as const;

export type ReportScopingKey = (typeof ReportScoping)[keyof typeof ReportScoping];

/**
 * What a parameter is, for validation that happens once rather than per report.
 *
 * `REPORTING_SERVICE.run` takes `Record<string, string>` — the shape shipped in Phase 0.5, and the
 * shape a query string arrives in — so every parameter is parsed from text here. Unknown names are
 * refused rather than ignored: a filter silently dropped because it was misspelled produces a
 * report over more rows than the person asked about, and they cannot tell by looking at it.
 */
export const ReportParameterKind = {
  DATE: 'DATE',
  UUID: 'UUID',
  ENUM: 'ENUM',
  TEXT: 'TEXT',
  BOOLEAN: 'BOOLEAN',
} as const;

export type ReportParameterKindKey = (typeof ReportParameterKind)[keyof typeof ReportParameterKind];

export interface ReportParameterSpec {
  readonly name: string;
  readonly kind: ReportParameterKindKey;
  readonly required: boolean;
  /** Present exactly when `kind` is `ENUM`. The whole of what the value may be. */
  readonly values?: readonly string[];
}

/**
 * One column, named once.
 *
 * The column list is here rather than derived from the row objects for the reason
 * `EVIDENCE_COLUMNS` is fixed in Phase 9: an order that depended on object construction would
 * change silently, and every spreadsheet built on last month's export with it. It is also what the
 * CSV header, the spreadsheet's header row and the PDF's table head are all built from, so a
 * report cannot export three different column sets.
 *
 * `type` is what the spreadsheet writer needs to emit a *typed* cell. A document number like
 * `0012-2026` written as a number is a document number Excel rounds; a date written as text is a
 * date nothing can sort.
 */
export const ReportColumnType = {
  TEXT: 'TEXT',
  NUMBER: 'NUMBER',
  DATE: 'DATE',
} as const;

export type ReportColumnTypeKey = (typeof ReportColumnType)[keyof typeof ReportColumnType];

export interface ReportColumn {
  readonly key: string;
  readonly type: ReportColumnTypeKey;
}

/** Which module answers this report. One symbol per contributing module, bound in the root. */
export const ReportSource = {
  DOCUMENT: 'DOCUMENT',
  WORKFLOW: 'WORKFLOW',
  STORAGE: 'STORAGE',
  PEOPLE: 'PEOPLE',
  ORGANIZATION: 'ORGANIZATION',
  RETENTION: 'RETENTION',
  AUDIT: 'AUDIT',
} as const;

export type ReportSourceKey = (typeof ReportSource)[keyof typeof ReportSource];

export interface ReportDefinition {
  readonly key: string;
  readonly source: ReportSourceKey;
  /** Which query within its source. The source port's own discriminator. */
  readonly query: string;
  /** Every one required. Never a choice — see rule 1 at the head of this file. */
  readonly permissions: readonly PermissionKey[];
  readonly scoping: ReportScopingKey;
  readonly parameters: readonly ReportParameterSpec[];
  readonly columns: readonly ReportColumn[];
  /**
   * Whether the web client draws this report as a chart as well as a table.
   *
   * Only the two reports that have an axis worth drawing. Phase 13 declined charts because
   * "nothing on this screen has a time axis; the trends that would earn one are Phase 15's" — and
   * that is true of exactly two of the ten keys here. A chart on a list of documents would be a
   * decoration, and 16 §8's RTL rule applies to every one that is drawn.
   */
  readonly chart: 'CATEGORY' | 'TIME' | null;
}

const DATE_RANGE: readonly ReportParameterSpec[] = Object.freeze([
  { name: 'from', kind: ReportParameterKind.DATE, required: false },
  { name: 'to', kind: ReportParameterKind.DATE, required: false },
]);

/**
 * The document lifecycle states a report may filter on.
 *
 * Spelled here rather than imported from `DocumentStatus` deliberately: this is the *wire*
 * vocabulary of a parameter, and a report that accepted whatever the enum happened to contain
 * would silently gain a filter value the day a state was added, before anything had decided the
 * report should offer it. The unit test asserts every value here is a real status, which catches
 * the opposite mistake.
 */
const DOCUMENT_STATUSES: readonly string[] = Object.freeze([
  'DRAFT',
  'SUBMITTED',
  'UNDER_REVIEW',
  'CHANGES_REQUESTED',
  'REJECTED',
  'APPROVED',
  'PUBLISHED',
  'CHECKED_OUT',
  'SUPERSEDED',
  'ARCHIVED',
  'EXPIRED',
  'DELETED',
]);

/** The dimensions "documents per …" may be asked along. Phase 13 §8 named three; this is four. */
const DOCUMENT_DIMENSIONS: readonly string[] = Object.freeze([
  'DEPARTMENT',
  'TYPE',
  'CATEGORY',
  'OWNER',
  'STATUS',
]);

export const REPORTS: readonly ReportDefinition[] = Object.freeze([
  {
    /**
     * The controlled record population, a row at a time.
     *
     * `document:view` beside `report:view` because this is the document list with a wider column
     * set: somebody who may not read the library may not read a report of it either, and the rows
     * are scoped by exactly the reach the library applies.
     */
    key: 'documents',
    source: ReportSource.DOCUMENT,
    query: 'documents',
    permissions: [Permission.REPORT_VIEW, Permission.DOCUMENT_VIEW],
    scoping: ReportScoping.REACH_SCOPED,
    parameters: [
      ...DATE_RANGE,
      { name: 'libraryId', kind: ReportParameterKind.UUID, required: false },
      { name: 'folderId', kind: ReportParameterKind.UUID, required: false },
      { name: 'documentTypeId', kind: ReportParameterKind.UUID, required: false },
      { name: 'categoryId', kind: ReportParameterKind.UUID, required: false },
      { name: 'ownerUserId', kind: ReportParameterKind.UUID, required: false },
      {
        name: 'status',
        kind: ReportParameterKind.ENUM,
        required: false,
        values: DOCUMENT_STATUSES,
      },
    ],
    columns: [
      { key: 'documentNumber', type: ReportColumnType.TEXT },
      { key: 'title', type: ReportColumnType.TEXT },
      { key: 'status', type: ReportColumnType.TEXT },
      { key: 'documentType', type: ReportColumnType.TEXT },
      { key: 'category', type: ReportColumnType.TEXT },
      { key: 'confidentiality', type: ReportColumnType.TEXT },
      { key: 'library', type: ReportColumnType.TEXT },
      { key: 'folderPath', type: ReportColumnType.TEXT },
      { key: 'owner', type: ReportColumnType.TEXT },
      { key: 'revisionCount', type: ReportColumnType.NUMBER },
      { key: 'createdAt', type: ReportColumnType.DATE },
      { key: 'updatedAt', type: ReportColumnType.DATE },
    ],
    chart: null,
  },
  {
    /**
     * "Documents per department, per type or per user" — Phase 13 §8's limit row, discharged.
     *
     * Its report named this as the moment a tile becomes a report: "a tile with a dimension is a
     * report wearing a card". It is the same predicate as `documents` above, grouped — which is
     * why it is the same source and the same permissions, and why its counts inherit the reach
     * filter without this file knowing how.
     */
    key: 'documents-by-dimension',
    source: ReportSource.DOCUMENT,
    query: 'documents-by-dimension',
    permissions: [Permission.REPORT_VIEW, Permission.DOCUMENT_VIEW],
    scoping: ReportScoping.REACH_SCOPED,
    parameters: [
      ...DATE_RANGE,
      {
        name: 'dimension',
        kind: ReportParameterKind.ENUM,
        required: true,
        values: DOCUMENT_DIMENSIONS,
      },
      { name: 'libraryId', kind: ReportParameterKind.UUID, required: false },
      {
        name: 'status',
        kind: ReportParameterKind.ENUM,
        required: false,
        values: DOCUMENT_STATUSES,
      },
    ],
    columns: [
      { key: 'label', type: ReportColumnType.TEXT },
      { key: 'count', type: ReportColumnType.NUMBER },
    ],
    chart: 'CATEGORY',
  },
  {
    /**
     * Approval decisions and how long each took.
     *
     * Reach-scoped through the *document* the task belongs to, not through the task's assignee: a
     * report of approvals is a report about records, and "which documents were approved last
     * quarter" is a question about the documents. The workflow adapter joins to the document and
     * applies the same regions the library does, so a task on a record the caller cannot reach is
     * absent — which also means a report cannot be used to enumerate who approves what in a part
     * of the tenant somebody has no access to.
     */
    key: 'approvals',
    source: ReportSource.WORKFLOW,
    query: 'approvals',
    permissions: [Permission.REPORT_VIEW, Permission.DOCUMENT_VIEW],
    scoping: ReportScoping.REACH_SCOPED,
    parameters: [
      ...DATE_RANGE,
      {
        name: 'state',
        kind: ReportParameterKind.ENUM,
        required: false,
        // `approval_task.state`, not `TaskDecision`: a task is PENDING or DECIDED, and *what* was
        // decided is its own column. Offering "APPROVED" as a state would be the report inventing
        // a vocabulary the inbox does not use.
        values: ['PENDING', 'DECIDED', 'WITHDRAWN', 'SUPERSEDED'],
      },
      { name: 'assigneeId', kind: ReportParameterKind.UUID, required: false },
      { name: 'overdueOnly', kind: ReportParameterKind.BOOLEAN, required: false },
    ],
    columns: [
      { key: 'documentNumber', type: ReportColumnType.TEXT },
      { key: 'documentTitle', type: ReportColumnType.TEXT },
      { key: 'stage', type: ReportColumnType.TEXT },
      { key: 'assignee', type: ReportColumnType.TEXT },
      { key: 'state', type: ReportColumnType.TEXT },
      { key: 'assignedAt', type: ReportColumnType.DATE },
      { key: 'dueAt', type: ReportColumnType.DATE },
      { key: 'decidedAt', type: ReportColumnType.DATE },
      { key: 'hoursToDecide', type: ReportColumnType.NUMBER },
      { key: 'overdue', type: ReportColumnType.TEXT },
    ],
    chart: null,
  },
  {
    /** Running and finished approvals per month — the one report with a genuine time axis. */
    key: 'workflow',
    source: ReportSource.WORKFLOW,
    query: 'workflow',
    permissions: [Permission.REPORT_VIEW, Permission.DOCUMENT_VIEW],
    scoping: ReportScoping.REACH_SCOPED,
    parameters: [...DATE_RANGE],
    columns: [
      { key: 'period', type: ReportColumnType.TEXT },
      { key: 'started', type: ReportColumnType.NUMBER },
      { key: 'completed', type: ReportColumnType.NUMBER },
      { key: 'rejected', type: ReportColumnType.NUMBER },
      { key: 'running', type: ReportColumnType.NUMBER },
    ],
    chart: 'TIME',
  },
  {
    /**
     * What this tenant holds, by library.
     *
     * `TENANT_WIDE`: a blob is content-addressed and shared between documents by construction
     * (ADR-0007), so "the bytes the caller may reach" is not a quantity this data model has —
     * apportioning a deduplicated blob across the documents that reference it would be an
     * invention, and an invention people would report upward.
     *
     * Bytes held and bytes referenced, and no third figure. Phase 13 §3.5 recorded that storage
     * reports bytes and never a quota, and that stays true here: what a tenant *may* store is
     * ADR-0012's data and Phase 21's enforcement, and a percentage would need a denominator this
     * module would have to invent.
     */
    key: 'storage',
    source: ReportSource.STORAGE,
    query: 'storage',
    permissions: [Permission.REPORT_VIEW],
    scoping: ReportScoping.TENANT_WIDE,
    parameters: [],
    columns: [
      { key: 'library', type: ReportColumnType.TEXT },
      { key: 'documents', type: ReportColumnType.NUMBER },
      { key: 'revisions', type: ReportColumnType.NUMBER },
      { key: 'storedBytes', type: ReportColumnType.NUMBER },
      { key: 'referencedBytes', type: ReportColumnType.NUMBER },
    ],
    chart: null,
  },
  {
    /** Departments and what sits in each. `org:manage` — Phase 13 gated its tile on exactly this. */
    key: 'departments',
    source: ReportSource.ORGANIZATION,
    query: 'departments',
    permissions: [Permission.REPORT_VIEW, Permission.ORG_MANAGE],
    scoping: ReportScoping.TENANT_WIDE,
    parameters: [],
    columns: [
      { key: 'department', type: ReportColumnType.TEXT },
      { key: 'entity', type: ReportColumnType.TEXT },
      { key: 'members', type: ReportColumnType.NUMBER },
      { key: 'managers', type: ReportColumnType.NUMBER },
    ],
    chart: null,
  },
  {
    /**
     * Accounts and their state. `user:manage` — Phase 13 gated its tile on exactly this.
     *
     * No password, no second-factor secret, no session token and no address beyond the one the
     * administration screen already shows. A report is a file somebody keeps.
     */
    key: 'users',
    source: ReportSource.PEOPLE,
    query: 'users',
    permissions: [Permission.REPORT_VIEW, Permission.USER_MANAGE],
    scoping: ReportScoping.TENANT_WIDE,
    parameters: [
      {
        name: 'state',
        kind: ReportParameterKind.ENUM,
        required: false,
        values: ['INVITED', 'ACTIVE', 'DISABLED'],
      },
    ],
    columns: [
      { key: 'displayName', type: ReportColumnType.TEXT },
      { key: 'email', type: ReportColumnType.TEXT },
      { key: 'state', type: ReportColumnType.TEXT },
      { key: 'roles', type: ReportColumnType.TEXT },
      { key: 'department', type: ReportColumnType.TEXT },
      { key: 'mfaEnrolled', type: ReportColumnType.TEXT },
      { key: 'lastSignInAt', type: ReportColumnType.DATE },
    ],
    chart: null,
  },
  {
    /**
     * What has been deleted and not yet disposed of — and the second door Phase 10 would have had.
     *
     * `document:restore` beside `report:view`, because that is ADR-0010 §2's own gate: "deleted
     * objects are visible in a recycle bin to holders of `document:restore`". A report listing them
     * to a `report:view` holder would be the recycle bin without the permission on it, and the
     * whole point of a compliance product's deletion story is that seeing what somebody removed is
     * a narrower right than seeing what exists.
     *
     * Reach-scoped as well, through the document rows themselves, so it is narrower than the bin
     * rather than wider.
     */
    key: 'deleted-documents',
    source: ReportSource.DOCUMENT,
    query: 'deleted-documents',
    permissions: [Permission.REPORT_VIEW, Permission.DOCUMENT_RESTORE],
    scoping: ReportScoping.REACH_SCOPED,
    parameters: [
      ...DATE_RANGE,
      { name: 'libraryId', kind: ReportParameterKind.UUID, required: false },
    ],
    columns: [
      { key: 'documentNumber', type: ReportColumnType.TEXT },
      { key: 'title', type: ReportColumnType.TEXT },
      { key: 'library', type: ReportColumnType.TEXT },
      { key: 'folderPath', type: ReportColumnType.TEXT },
      { key: 'deletedAt', type: ReportColumnType.DATE },
      { key: 'deletedBy', type: ReportColumnType.TEXT },
      { key: 'deleteReason', type: ReportColumnType.TEXT },
      { key: 'cascaded', type: ReportColumnType.TEXT },
    ],
    chart: null,
  },
  {
    /**
     * Retention schedules past their date, or waiting on a reviewer.
     *
     * `retention:manage` beside `report:view` — the permission the disposition queue is already
     * behind, for the same reason as the row above.
     *
     * **No `limit` parameter, and that is the difference from `listDue`.** Phase 13 recorded why
     * when it extracted `dueScheduleWhere`: the sweep takes a limit because it *processes* what it
     * reads, and a figure that stopped at the batch size would sit at 200 through a backlog of any
     * size. This is a paged report, so its total is the real one.
     */
    key: 'expired-documents',
    source: ReportSource.RETENTION,
    query: 'expired-documents',
    permissions: [Permission.REPORT_VIEW, Permission.RETENTION_MANAGE],
    scoping: ReportScoping.REACH_SCOPED,
    parameters: [
      ...DATE_RANGE,
      {
        name: 'state',
        kind: ReportParameterKind.ENUM,
        required: false,
        values: ['PENDING', 'IN_REVIEW', 'EXECUTED', 'SUSPENDED', 'CANCELLED'],
      },
    ],
    columns: [
      { key: 'documentNumber', type: ReportColumnType.TEXT },
      { key: 'title', type: ReportColumnType.TEXT },
      { key: 'trigger', type: ReportColumnType.TEXT },
      { key: 'disposition', type: ReportColumnType.TEXT },
      { key: 'state', type: ReportColumnType.TEXT },
      { key: 'dueAt', type: ReportColumnType.DATE },
      { key: 'overdueDays', type: ReportColumnType.NUMBER },
      { key: 'onLegalHold', type: ReportColumnType.TEXT },
    ],
    chart: null,
  },
  {
    /**
     * The trail, as a report — and deliberately the *same* reader as the audit search.
     *
     * 08 §10 records that the audit search is not ACL-filtered, because it crosses every subject
     * and `audit:view` is the filter. So this report requires `audit:view`, is answered through the
     * audit module's own read service rather than by a query beside it, and is `TENANT_WIDE`
     * because filtering it by document reach would produce a *different* answer from `/audit` for
     * the same question — and 13 §1 is emphatic that the trail has one reader.
     *
     * What this adds over `/audit` is paging into an export somebody keeps. It is not an evidence
     * bundle: a bundle carries the chain, the checkpoints and a signed manifest stating what each
     * digest attests, and it stays behind `audit:export`. This is a spreadsheet of rows, and it
     * says so — see `EXPORT_FORMATS` and the report.
     */
    key: 'audit',
    source: ReportSource.AUDIT,
    query: 'audit',
    permissions: [Permission.REPORT_VIEW, Permission.AUDIT_VIEW],
    scoping: ReportScoping.TENANT_WIDE,
    parameters: [
      ...DATE_RANGE,
      { name: 'action', kind: ReportParameterKind.TEXT, required: false },
      { name: 'actorId', kind: ReportParameterKind.UUID, required: false },
      { name: 'subjectType', kind: ReportParameterKind.TEXT, required: false },
      {
        name: 'outcome',
        kind: ReportParameterKind.ENUM,
        required: false,
        values: ['SUCCESS', 'DENIED', 'FAILED'],
      },
    ],
    columns: [
      { key: 'occurredAt', type: ReportColumnType.DATE },
      { key: 'action', type: ReportColumnType.TEXT },
      { key: 'outcome', type: ReportColumnType.TEXT },
      { key: 'subjectType', type: ReportColumnType.TEXT },
      { key: 'subjectId', type: ReportColumnType.TEXT },
      { key: 'actor', type: ReportColumnType.TEXT },
      { key: 'reason', type: ReportColumnType.TEXT },
    ],
    chart: null,
  },
]);

const BY_KEY: ReadonlyMap<string, ReportDefinition> = new Map(
  REPORTS.map((report) => [report.key, report]),
);

export function reportFor(key: string): ReportDefinition | null {
  return BY_KEY.get(key) ?? null;
}

export const REPORT_KEYS: readonly string[] = Object.freeze(REPORTS.map((report) => report.key));

/**
 * The formats an export may be asked for, and what each one honestly is.
 *
 * ## The Excel decision, recorded where it lives
 *
 * There is no spreadsheet library in this repository and there cannot be one: the lockfile cannot
 * be regenerated in the environment this phase was built in, so `pnpm install --frozen-lockfile`
 * is the constraint rather than a preference. XLSX is a ZIP container, and `node:zlib` gives
 * deflate but no archive writer. Four answers were available and this is the one taken, with the
 * three that were not:
 *
 * - **CSV renamed "Excel"** — refused. Excel opens it, which is exactly what makes it dishonest:
 *   the product would be claiming a format it did not produce, and every cell would be text.
 * - **A hand-built minimal XLSX** — refused, and it is the closest call. Phase 9 refused the same
 *   thing for the same reason ("hand-rolling a stored-entry archive writer … is a format
 *   implementation nobody asked for"), and one property decides it here rather than taste: a ZIP
 *   central directory states each entry's size and CRC, so the writer must either buffer the whole
 *   sheet or emit data descriptors — and this lane's entire design is that a report **streams** a
 *   page at a time and is never held in memory. An XLSX writer would undo the one property the
 *   export exists to have.
 * - **Declining Excel outright** — refused, because the brief asks for it and something honest was
 *   available.
 * - **SpreadsheetML 2003** — taken. It is Microsoft's own XML workbook format, Excel opens it
 *   natively, it is a single XML document with no container, it carries **typed** cells and a
 *   frozen header row, and — the deciding property — it streams: the header, then a `<Row>` per
 *   row, then the footer, exactly like the CSV writer beside it. It is not XLSX and this catalogue
 *   does not say it is: the format is `SPREADSHEET_XML`, the media type is the one Excel registers,
 *   and the file is `.xls`, which is what Excel opens it as.
 *
 * ## And the CSV traps, because a compliance product is where they matter
 *
 * A BOM, so Excel reads UTF-8 and Arabic renders; `\r\n`, because that is what the format says;
 * and **formula neutralisation**, which quoting alone does not give — Excel strips the quotes and
 * then evaluates a leading `=`, `+`, `-`, `@`, tab or carriage return as a formula. `csv.ts`
 * handles it, and its comment records that the evidence CSV Phase 9 writes quotes uniformly and
 * does not neutralise, which the report names as a finding rather than fixing in a bundle whose
 * bytes an auditor may already hold a digest of.
 */
export const ExportFormat = {
  CSV: 'CSV',
  /** SpreadsheetML 2003 — a real Excel format, and not XLSX. See above. */
  SPREADSHEET_XML: 'SPREADSHEET_XML',
  PDF: 'PDF',
} as const;

export type ExportFormatKey = (typeof ExportFormat)[keyof typeof ExportFormat];

export const EXPORT_FORMATS: readonly ExportFormatKey[] = Object.freeze(
  Object.values(ExportFormat),
);

export function isExportFormat(value: string): value is ExportFormatKey {
  return (EXPORT_FORMATS as readonly string[]).includes(value);
}

/**
 * The one parameter name a report may never declare.
 *
 * `requestExport(key, parameters)` is Phase 0.5's shipped signature and takes no format argument,
 * so the format travels as a reserved parameter rather than by widening a contract that four
 * phases have now been able to rely on. Reserving the name is what stops a report ever declaring
 * a filter called `format` and silently shadowing it; the unit test asserts none does.
 */
export const FORMAT_PARAMETER = 'format';

export function artefactNameFor(key: string, format: ExportFormatKey): string {
  switch (format) {
    case ExportFormat.CSV:
      return `${key}.csv`;
    case ExportFormat.SPREADSHEET_XML:
      return `${key}.xls`;
    case ExportFormat.PDF:
      return `${key}.pdf`;
  }
}

export function mediaTypeFor(format: ExportFormatKey): string {
  switch (format) {
    case ExportFormat.CSV:
      return 'text/csv; charset=utf-8';
    case ExportFormat.SPREADSHEET_XML:
      return 'application/vnd.ms-excel';
    case ExportFormat.PDF:
      return 'application/pdf';
  }
}
