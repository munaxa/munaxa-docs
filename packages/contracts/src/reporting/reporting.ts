import { z } from 'zod';

import { pageQuerySchema } from '../common/pagination';

/**
 * Phase 15 — enterprise reports (`docs/architecture/15-api-architecture.md` §1's
 * `GET /api/v1/reports/{key}`).
 *
 * Four shapes, and three of them carry a claim the API must not overstate.
 *
 * **A report descriptor says what a report *is*, and the list contains only what the caller may
 * run.** A report they may not run is **absent**, never present-and-disabled. That is Phase 13's
 * rule for tiles applied to a menu: a greyed-out row named "Deleted documents" tells somebody the
 * product keeps one, which is exactly the fact `document:restore` exists to gate.
 *
 * **A row is `Record<string, unknown>`, and the columns are declared separately.** The alternative
 * — a typed row per report — would put ten shapes in this file that only the API and one screen
 * ever agree about. What keeps it honest is that `columns` comes from the same catalogue the query
 * is built from, so a client renders the columns the server says exist rather than columns it
 * remembers.
 *
 * **An export is a job, never a response body.** `REPORTING_SERVICE`'s own contract has said since
 * Phase 0.5 that "large exports are queued and audited rather than streamed from a request", and
 * the wire shape says so rather than pretending a download is available immediately. What it also
 * says, on every completed export, is whether it was **truncated** and how many characters a PDF
 * could not encode — because a spreadsheet cut off at a round number looks exactly like a complete
 * one, and a PDF full of `?` is worse than none unless somebody is told.
 *
 * **`format` is `SPREADSHEET_XML`, not `XLSX`.** There is no spreadsheet library in this product
 * and none can be added, so the Excel format it produces is SpreadsheetML 2003 — which Excel opens
 * natively and which is genuinely not XLSX. Naming the value for what it is keeps the wire from
 * asserting a container the product never wrote; the reporting module's catalogue records the three
 * answers that were not taken.
 */

export const reportScopingSchema = z.enum(['REACH_SCOPED', 'TENANT_WIDE']);

export const reportParameterKindSchema = z.enum(['DATE', 'UUID', 'ENUM', 'TEXT', 'BOOLEAN']);

export const reportColumnTypeSchema = z.enum(['TEXT', 'NUMBER', 'DATE']);

export const exportFormatSchema = z.enum(['CSV', 'SPREADSHEET_XML', 'PDF']);

export type ExportFormatValue = z.infer<typeof exportFormatSchema>;

export interface ReportParameterDescriptor {
  readonly name: string;
  readonly kind: z.infer<typeof reportParameterKindSchema>;
  readonly required: boolean;
  /** Present exactly when `kind` is `ENUM`. The whole of what the value may be. */
  readonly values: readonly string[] | null;
}

export interface ReportColumnDescriptor {
  readonly key: string;
  readonly type: z.infer<typeof reportColumnTypeSchema>;
}

export interface ReportDescriptor {
  readonly key: string;
  /**
   * How the rows are narrowed, on the wire so a client can say so.
   *
   * A screen that renders "scoped to what you can see" beside a reach-scoped report and nothing
   * beside a tenant-wide one is telling somebody why two people running the same report get
   * different totals — which is otherwise the most alarming thing a report can do.
   */
  readonly scoping: z.infer<typeof reportScopingSchema>;
  readonly parameters: readonly ReportParameterDescriptor[];
  readonly columns: readonly ReportColumnDescriptor[];
  /** `CATEGORY`, `TIME`, or null for a report with no axis worth drawing. */
  readonly chart: 'CATEGORY' | 'TIME' | null;
}

/** One page of a report. `total` obeys the same predicate the rows do (08 §7). */
export interface ReportPage {
  readonly key: string;
  readonly columns: readonly ReportColumnDescriptor[];
  readonly data: readonly Readonly<Record<string, unknown>>[];
  readonly meta: {
    readonly page: number;
    readonly pageSize: number;
    readonly total: number;
    readonly hasMore: boolean;
  };
}

export const reportExportStateSchema = z.enum(['REQUESTED', 'RUNNING', 'COMPLETED', 'FAILED']);

export interface ReportExport {
  readonly id: string;
  readonly reportKey: string;
  readonly format: ExportFormatValue;
  readonly state: z.infer<typeof reportExportStateSchema>;
  /** Exactly what was asked for — the same map the `REPORT_EXPORTED` audit row carries. */
  readonly parameters: Readonly<Record<string, string>>;
  readonly requestedAt: string;
  readonly rowCount: number;
  readonly sizeBytes: number;
  /** The digest of the bytes written, so a downloaded file can be checked against the record. */
  readonly sha256: string | null;
  /** True when the row cap cut the report short. Never only in a log. */
  readonly truncated: boolean;
  /** Characters the PDF's font could not encode; zero for every other format. */
  readonly substitutions: number;
  readonly completedAt: string | null;
  readonly error: string | null;
}

export interface ReportExportLink {
  readonly url: string;
  readonly expiresAt: string;
  readonly filename: string;
}

/**
 * Running a report: paging, plus whatever parameters the report declares.
 *
 * `passthrough`, deliberately and uniquely in this package. Every other list contract enumerates
 * its filters, because every other list has a fixed set; a report's parameters are the catalogue's
 * and differ per key, so the API validates them against the descriptor rather than against a
 * schema this file would have to grow a branch of per report. **Unknown names are refused by the
 * service**, not ignored — a filter silently dropped because it was misspelled produces a report
 * over more rows than somebody asked about, and they cannot tell by looking at it.
 */
export const runReportQuerySchema = pageQuerySchema.passthrough();

export const requestExportBodySchema = z.object({
  format: exportFormatSchema,
  /** The parameters, exactly as the run query takes them. Validated against the descriptor. */
  parameters: z.record(z.string(), z.string()).default({}),
});

export type RequestExportBody = z.infer<typeof requestExportBodySchema>;

/**
 * A saved report — `REPORT_DEFINITION_REPOSITORY`, bound at last.
 *
 * **Parameters, never a query.** There is no column list, no table name and no SQL anywhere in this
 * shape, and its absence is the enforcement of the constraint reporting's own port file opens with:
 * a definition that could name a column would be a tenant pinning one, and no migration would ever
 * again be a decision this repository alone could take.
 *
 * Personal, like a saved search: a definition belongs to whoever made it, and there is no owner
 * field on the wire because there is no request by which one person could read another's.
 */
export interface ReportDefinition {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly parameters: Readonly<Record<string, string>>;
}

export const saveReportDefinitionSchema = z.object({
  key: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(120),
  parameters: z.record(z.string(), z.string()).default({}),
});

export type SaveReportDefinitionBody = z.infer<typeof saveReportDefinitionSchema>;
