import type { AnyId, ReportDefinitionId, UserId } from '@edms/domain';
import type { Page, PageRequest } from '@edms/utils';

import type {
  ExportFormatKey,
  ReportDefinition as CatalogueEntry,
} from '../domain/report-catalogue';

/**
 * Reports read from read models, never from another module's tables.
 *
 * That constraint is what keeps a reporting query from quietly becoming the reason a schema
 * cannot change (`docs/architecture/02-backend-architecture.md` §3).
 *
 * ---
 *
 * ## What Phase 15 decided that sentence means
 *
 * There were three readings, and the phase report argues all three. The one taken is **Phase 13's
 * shape, applied to queries instead of counts**: what this module needs is declared below in the
 * *reporting* vocabulary, and implemented by whichever module owns the table — the inverted
 * dependency the dashboard uses eight times and Document already used for `REVISION_WRITER`.
 *
 * The two rejected readings are worth naming, because each is defensible and each costs something
 * this product has already paid for once:
 *
 * - **Materialised read models of its own.** A reporting schema, projected from events, is the
 *   textbook answer and it comes with an invalidation story. Phase 14 has just written a long one
 *   about `acl_subjects` — an ACL change re-projects an affected subtree a page at a time, and the
 *   index must never be emptied while it is live — and a report is *more* sensitive to staleness
 *   than an index, not less, because a search result somebody cannot see is a missing row and a
 *   report figure somebody cannot see is a **wrong number they act on**. Owning a second
 *   materialisation would mean a second such story, for a capability whose queries are aggregates
 *   over tables that are already indexed for exactly these predicates.
 * - **Reading the search index.** It is already permission-materialised, which is genuinely
 *   tempting. It also holds documents and nothing else — no approvals, no storage, no accounts, no
 *   retention schedule — so seven of the ten reports could not be answered from it at all, and the
 *   three that could would be answered from a projection that is *eventually* consistent with the
 *   record. A report that disagrees with the document it is about is worse than a slow one.
 *
 * **So this module has an `infrastructure/` and the dashboard does not, and the difference is
 * exactly one word: its own.** `report_definition` and `report_export` are Reporting's tables and
 * Reporting's repositories read them. Nothing under `reporting/` reads another module's table, and
 * the unit test asserts it — the same property Phase 13 enforced by having no `infrastructure/` at
 * all, kept here in the only form a module that owns two tables can keep it.
 */
export const REPORT_DEFINITION_REPOSITORY = Symbol('ReportDefinitionRepository');

export interface ReportDefinitionRecord {
  readonly id: ReportDefinitionId;
  readonly key: string;
  readonly name: string;
  readonly ownerId: UserId;
  readonly query: Readonly<Record<string, unknown>>;
}

export interface ReportDefinitionRepository {
  findById(id: ReportDefinitionId): Promise<ReportDefinitionRecord | null>;
  findByKey(key: string): Promise<ReportDefinitionRecord | null>;
  listFor(ownerId: UserId, page: PageRequest): Promise<Page<ReportDefinitionRecord>>;
  save(definition: ReportDefinitionRecord): Promise<void>;
  /**
   * Phase 15's one addition to a four-method interface that had been stable since the skeleton.
   *
   * Added rather than worked around, because the alternative was a cast at the call site — an
   * implementation detail leaking into the service to avoid touching a contract nobody else
   * implements. Soft, like every other administered row: the delete is a `deleted_at`, the partial
   * unique index frees the name, and the four methods above are unchanged.
   */
  softDelete(id: ReportDefinitionId): Promise<boolean>;
}

export const REPORTING_SERVICE = Symbol('ReportingService');

export interface ReportingService {
  /** Every row is permission-scoped to the caller, in SQL, exactly like a document list. */
  run(
    key: string,
    parameters: Readonly<Record<string, string>>,
    page: PageRequest,
  ): Promise<Page<Readonly<Record<string, unknown>>>>;
  /** Large exports are queued and audited rather than streamed from a request. */
  requestExport(
    key: string,
    parameters: Readonly<Record<string, string>>,
  ): Promise<{ jobId: string }>;

  // -------------------------------------------------------------------------------------------
  // Phase 15's additions. **The two methods above are byte-for-byte as Phase 0.5 shipped them**,
  // including `requestExport` returning a job identifier rather than a record — which is why the
  // export format travels as the reserved `format` parameter rather than as a third argument. Four
  // phases have now had to bind a contract somebody else wrote, and every one of their reports says
  // the same thing about the ones that were left alone: a signature that did not change is a
  // signature no caller had to be found for.
  // -------------------------------------------------------------------------------------------

  /** The reports this caller may actually run, with their parameters and columns. */
  available(): Promise<readonly CatalogueEntry[]>;
  /** One export, for the screen that polls it. Null when it is not this tenant's. */
  export(id: AnyId): Promise<ReportExportRecord | null>;
  listExports(page: PageRequest): Promise<Page<ReportExportRecord>>;
  /** A signed URL for a completed export's artefact, audited by Storage as it is issued. */
  downloadExport(id: AnyId): Promise<{ url: string; expiresAt: Date; filename: string }>;
}

// --- The export record --------------------------------------------------------------------

/**
 * The states an export moves through.
 *
 * Deliberately the same four as `AuditExportState`, and deliberately **not** the same type. They
 * are two tables with two lifecycles that happen to agree today; sharing an enum would mean a
 * fifth state added for one of them silently appearing in the other's column, and a database
 * constraint that no longer means what its name says.
 */
export const ReportExportState = {
  REQUESTED: 'REQUESTED',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;

export type ReportExportStateKey = (typeof ReportExportState)[keyof typeof ReportExportState];

export interface ReportExportRecord {
  readonly id: AnyId;
  readonly reportKey: string;
  readonly format: ExportFormatKey;
  readonly state: ReportExportStateKey;
  /** Exactly what was asked for. What the trail records, and what the PDF prints under its title. */
  readonly parameters: Readonly<Record<string, string>>;
  readonly requestedById: UserId;
  readonly requestedAt: Date;
  readonly rowCount: number;
  readonly storageKey: string | null;
  readonly fileObjectId: string | null;
  readonly sizeBytes: number;
  readonly sha256: string | null;
  /**
   * Whether the row cap cut the report short.
   *
   * On the record, on the wire and in the audit row — never only in a log. A truncated export that
   * did not say so is the "silent cap" failure: a spreadsheet of 100,000 rows looks exactly like a
   * complete one, and somebody reconciles against it.
   */
  readonly truncated: boolean;
  /** How many characters the PDF's standard font could not encode. Zero for every other format. */
  readonly substitutions: number;
  readonly completedAt: Date | null;
  readonly error: string | null;
}

export const REPORT_EXPORT_REPOSITORY = Symbol('ReportExportRepository');

export interface ReportExportRepository {
  insert(record: ReportExportRecord): Promise<void>;
  findById(id: AnyId): Promise<ReportExportRecord | null>;
  list(page: PageRequest): Promise<Page<ReportExportRecord>>;
  /**
   * Claims a requested export for this run.
   *
   * Conditional on `REQUESTED`, which is what makes at-least-once delivery harmless: a redelivered
   * job finds the row already `RUNNING` or `COMPLETED` and does nothing, rather than producing a
   * second file under the same identifier — the shape Phase 9's `AuditExportRepository.claim`
   * established and this follows.
   */
  claim(id: AnyId): Promise<boolean>;
  complete(
    id: AnyId,
    outcome: {
      readonly rowCount: number;
      readonly storageKey: string;
      readonly fileObjectId: string;
      readonly sizeBytes: number;
      readonly sha256: string;
      readonly truncated: boolean;
      readonly substitutions: number;
    },
  ): Promise<void>;
  fail(id: AnyId, error: string): Promise<void>;
}

// --- What Reporting needs from the modules that own the tables ----------------------------

/**
 * One page of a report, in the only vocabulary this module speaks.
 *
 * A row is `Record<string, unknown>` because `REPORTING_SERVICE.run` says so, and because the
 * alternative — a typed row per report — would put ten shapes in this file that only the catalogue
 * and one adapter ever agree about. What keeps it honest is that the *columns* are declared in
 * `report-catalogue.ts` and asserted against every adapter in the integration suite: a report whose
 * adapter stops producing a declared column fails there rather than exporting a blank spreadsheet.
 */
export type ReportRow = Readonly<Record<string, unknown>>;

/**
 * What every source is asked, and it is deliberately the same question ten times.
 *
 * `query` is the catalogue key's own discriminator, so one port per module rather than one method
 * per report: a module with three reports implements one method with three branches, beside the
 * predicates its lists are built from, instead of exporting three symbols the composition root has
 * to keep in step with a catalogue it cannot see.
 *
 * **The permission check has already happened when a source is called**, and no source re-does it.
 * That is stated here rather than left to be inferred, because the opposite convention — every
 * adapter checks — is how a permission comes to be checked in nine places and forgotten in the
 * tenth. What an adapter *does* apply is the caller's **reach**, and only through the predicate its
 * own module's list already uses.
 */
export interface ReportQuery {
  readonly query: string;
  readonly dates: Readonly<Record<string, Date>>;
  readonly strings: Readonly<Record<string, string>>;
  readonly booleans: Readonly<Record<string, boolean>>;
  readonly page: PageRequest;
}

export interface ReportSource {
  run(query: ReportQuery): Promise<Page<ReportRow>>;
}

export const REPORT_DOCUMENT_SOURCE = Symbol('ReportDocumentSource');
export const REPORT_WORKFLOW_SOURCE = Symbol('ReportWorkflowSource');
export const REPORT_STORAGE_SOURCE = Symbol('ReportStorageSource');
export const REPORT_PEOPLE_SOURCE = Symbol('ReportPeopleSource');
export const REPORT_ORGANIZATION_SOURCE = Symbol('ReportOrganizationSource');
export const REPORT_RETENTION_SOURCE = Symbol('ReportRetentionSource');
export const REPORT_AUDIT_SOURCE = Symbol('ReportAuditSource');

/**
 * The requester's own reach, reconstituted for a run that happens later.
 *
 * An export is produced by a queue consumer, and a consumer's request context has no user in it —
 * `audit-lane.consumer.ts`'s `systemContext` sets `userId: null`, correctly, because a nightly
 * verification is nobody's act. But a report **is** somebody's act, and its rows are scoped to
 * their reach: running it with no subject would either produce an unfiltered report (the whole
 * disclosure this phase exists to prevent) or an empty one.
 *
 * So the lane asks Identity who the requester is *at the moment the export runs*, and runs under
 * that. Reading it then rather than copying it onto the export row at request time is **Phase 11's
 * rule** — authority is read at the instant of the decision, never copied at creation — and it has
 * the same consequence here as it does for a delegation: somebody whose access was revoked between
 * asking and running gets a smaller report, and somebody removed entirely gets none. A snapshot
 * taken at request time would let a queue backlog hand out reach that had already been taken away.
 */
export const REPORT_SUBJECT_READER = Symbol('ReportSubjectReader');

export interface ReportSubjectReader {
  /** Null when the account is gone or disabled — which is a refusal, not an empty report. */
  rolesFor(userId: UserId): Promise<readonly string[] | null>;
}
