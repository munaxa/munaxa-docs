import { Inject, Injectable } from '@nestjs/common';

import {
  type AnyId,
  type PermissionKey,
  AuditOutcome,
  AuditSubjectType,
  ScopeType,
  asId,
} from '@edms/domain';

import {
  ACL_RESOLVER,
  type AclResolver,
  type AuthorizationSubject,
} from '../../../core/authorization/acl-resolver.port';
import { APP_CONFIG, type AppConfig } from '../../../core/config';
import { ForbiddenError } from '../../../core/errors/application-errors';
import { LOGGER, type Logger } from '../../../core/observability/logger';
import { OUTBOX_WRITER, type OutboxWriter } from '../../../core/outbox/outbox.port';
import {
  AdministeredWriter,
  AdministrativeOperation,
  StreamDigest,
} from '../../../core/persistence';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../core/prisma';
import { requireContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { CLOCK_PORT, type ClockPort } from '../../../ports/clock.port';
import { STORAGE_SERVICE, type StorageService } from '../../storage/application/ports';
import { ReportingAudit } from '../domain/audit-actions';
import { reportExportReadyEvent } from '../domain/events';
import { renderReportPdf } from '../domain/report-pdf';
import {
  ExportFormat,
  artefactNameFor,
  mediaTypeFor,
  reportFor,
  type ReportDefinition as CatalogueEntry,
} from '../domain/report-catalogue';
import { parseParameters } from '../domain/report-parameters';
import { writerFor, type ReportRow } from '../domain/report-writers';
import {
  REPORT_AUDIT_SOURCE,
  REPORT_DOCUMENT_SOURCE,
  REPORT_EXPORT_REPOSITORY,
  REPORT_ORGANIZATION_SOURCE,
  REPORT_PEOPLE_SOURCE,
  REPORT_RETENTION_SOURCE,
  REPORT_STORAGE_SOURCE,
  REPORT_SUBJECT_READER,
  REPORT_WORKFLOW_SOURCE,
  ReportExportState,
  type ReportExportRecord,
  type ReportExportRepository,
  type ReportSource,
  type ReportSubjectReader,
} from './ports';

/**
 * Producing a report export. Called by the lane's consumer, never by a request.
 *
 * ---
 *
 * ## The safety property this file exists for: an export runs under the *requester's* reach
 *
 * A queue consumer's request context has no user in it. `audit-lane.consumer.ts`'s `systemContext`
 * sets `userId: null` and that is correct for what it does — a nightly chain verification is
 * nobody's act. It is emphatically wrong here. `PrismaDocumentRepository.visibilityCondition`
 * returns an *empty* predicate when `context.userId` is null, deliberately, because the search
 * projection has to materialise an entry's answer for everybody — so a report run in a system
 * context would be a report over **every row in the tenant**, written to a file, and handed to
 * whoever asked. That is the single worst thing this phase could ship, and it is one missing line
 * away in the obvious implementation.
 *
 * So `run` reconstitutes the requester: it asks Identity for their roles, builds a request context
 * naming them, and runs the whole export inside it. Every source port then applies exactly the
 * reach it applies to a request, because it is one.
 *
 * **The roles are read now, not copied at request time**, and that is Phase 11's rule rather than a
 * convenience: *authority is read at the instant of the decision from the delegator's current
 * grants rather than copied onto the delegation at creation*. A snapshot on the export row would
 * let a queue backlog hand out reach that had already been withdrawn. The permissions are then
 * re-checked against the resolver — an account that lost `document:restore` while its export
 * queued gets a failure, not a file — and an account that has gone entirely gets one too.
 *
 * ## What streams, and the one thing that does not
 *
 * CSV and the spreadsheet stream: a page is read, rendered and written, and the next page replaces
 * it. A report of any size costs one page of memory. A PDF cannot — its cross-reference table
 * states the byte offset of every object, so it is assembled whole — which is why it has a
 * *smaller* cap of its own, refused rather than silently applied.
 *
 * ## Truncation is reported, never silent
 *
 * `REPORTING_EXPORT_MAX_ROWS` bounds the file. Reaching it sets `truncated` on the record, on the
 * wire and in the audit row, and the screen says so beside the download. A spreadsheet cut off at
 * a round number looks exactly like a complete one, and somebody reconciles against it.
 */
@Injectable()
export class ReportExportService {
  constructor(
    @Inject(REPORT_EXPORT_REPOSITORY) private readonly exports: ReportExportRepository,
    @Inject(REPORT_SUBJECT_READER) private readonly subjects: ReportSubjectReader,
    @Inject(ACL_RESOLVER) private readonly acl: AclResolver,
    @Inject(REPORT_DOCUMENT_SOURCE) private readonly documents: ReportSource,
    @Inject(REPORT_WORKFLOW_SOURCE) private readonly workflow: ReportSource,
    @Inject(REPORT_STORAGE_SOURCE) private readonly storage: ReportSource,
    @Inject(REPORT_PEOPLE_SOURCE) private readonly people: ReportSource,
    @Inject(REPORT_ORGANIZATION_SOURCE) private readonly organization: ReportSource,
    @Inject(REPORT_RETENTION_SOURCE) private readonly retention: ReportSource,
    @Inject(REPORT_AUDIT_SOURCE) private readonly audit: ReportSource,
    @Inject(STORAGE_SERVICE) private readonly files: StorageService,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriter,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK_PORT) private readonly clock: ClockPort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly writer: AdministeredWriter,
  ) {}

  /**
   * Idempotent through `claim`: a redelivered job finds the row no longer `REQUESTED` and returns,
   * rather than producing a second file under the same identifier.
   */
  async run(id: AnyId): Promise<void> {
    const claimed = await this.unitOfWork.run(() => this.exports.claim(id));
    if (!claimed) {
      this.logger.info('A report export was already claimed', { exportId: id });
      return;
    }
    const record = await this.unitOfWork.run(() => this.exports.findById(id));
    if (record === null) {
      return;
    }
    const report = reportFor(record.reportKey);
    if (report === null) {
      // The catalogue changed between the request and the run — a deployment during a queued
      // export. Failing is the honest answer: a report key that no longer exists has no columns to
      // write, and guessing at the last shape would produce a file nobody could reproduce.
      await this.failed(record, `No report is registered under ${record.reportKey}.`);
      return;
    }

    try {
      const outcome = await this.produceAsRequester(record, report);
      await this.unitOfWork.run(() => this.exports.complete(id, outcome));
      await this.unitOfWork.run(() =>
        this.outbox.publish([
          reportExportReadyEvent(id, {
            exportId: String(id),
            reportKey: record.reportKey,
            rowCount: outcome.rowCount,
            storageKey: outcome.storageKey,
          }),
        ]),
      );
      await this.auditOutcome(record, AuditOutcome.SUCCESS, {
        state: ReportExportState.COMPLETED,
        reportKey: record.reportKey,
        format: record.format,
        parameters: record.parameters,
        rowCount: outcome.rowCount,
        truncated: outcome.truncated,
        substitutions: outcome.substitutions,
        sha256: outcome.sha256,
        sizeBytes: outcome.sizeBytes,
      });
    } catch (error) {
      await this.failed(record, error instanceof Error ? error.message : 'unknown');
      throw error;
    }
  }

  // --- Internals ------------------------------------------------------------------------------

  /**
   * The whole production, inside a context that names the person who asked.
   *
   * The tenant is the one the job carries — the consumer already established it — and only the
   * *subject* is replaced. Rebuilding the context wholesale would lose the correlation identifier,
   * and a report export that could not be traced back to the job that produced it is the one thing
   * an operator asks for when it goes wrong.
   */
  private async produceAsRequester(record: ReportExportRecord, report: CatalogueEntry) {
    const outer = requireContext();
    const roles = await this.unitOfWork.run(() => this.subjects.rolesFor(record.requestedById));
    if (roles === null) {
      throw new ForbiddenError('The account that requested this export no longer exists.');
    }

    return runWithContext(
      {
        ...outer,
        userId: record.requestedById,
        roles: [...roles],
        // Deliberately empty. 08 §3 makes collecting the subject the resolver's job, and a
        // permissions list assembled here would be this file deciding an authorisation question
        // it is the resolver's business to answer.
        permissions: [],
      },
      async () => {
        await this.reauthorise(report, record);
        return this.produce(record, report);
      },
    );
  }

  /**
   * The permissions, re-resolved at the instant the file is produced.
   *
   * Not a repetition of the request-time check: that one established that the person could ask, and
   * this one establishes that they still can. Between them sits a queue, and 08's model is that a
   * revocation takes effect when the decision is next made.
   */
  private async reauthorise(report: CatalogueEntry, record: ReportExportRecord): Promise<void> {
    const context = requireContext();
    const subject: AuthorizationSubject = {
      userId: record.requestedById,
      roleIds: context.roles.map((role) => asId<AnyId>(role)),
      departmentIds: [],
      delegationIds: [],
    };
    const capabilities = await this.unitOfWork.run(() =>
      this.acl.capabilitiesFor(
        subject,
        { type: ScopeType.TENANT, id: asId<AnyId>(context.tenantId) },
        report.permissions,
      ),
    );
    const missing = report.permissions.find(
      (permission: PermissionKey) => capabilities[permission] !== true,
    );
    if (missing !== undefined) {
      throw new ForbiddenError(
        `This export requires ${missing}, which the requester no longer holds.`,
      );
    }
  }

  private async produce(record: ReportExportRecord, report: CatalogueEntry) {
    const name = artefactNameFor(record.reportKey, record.format);
    const mediaType = mediaTypeFor(record.format);
    return record.format === ExportFormat.PDF
      ? this.producePdf(record, report, name, mediaType)
      : this.produceStreamed(record, report, name, mediaType);
  }

  /**
   * CSV and the spreadsheet: a page at a time, hashed on the way past.
   *
   * The generator is what makes this constant-memory — `storeStreamed` pulls a chunk, the source is
   * read for the next page, and the previous page is collectable. Reading every page into an array
   * first and yielding from it would be the same code with the property removed, which is exactly
   * the mistake `audit.export`'s lane description warns about.
   */
  private async produceStreamed(
    record: ReportExportRecord,
    report: CatalogueEntry,
    name: string,
    mediaType: string,
  ) {
    const digest = new StreamDigest();
    const writer = writerFor(record.format);
    const counters = { rows: 0, truncated: false };
    const pageSize = this.config.reporting.exportBatchSize;
    const maxRows = this.config.reporting.exportMaxRows;
    const read = (page: number) => this.readPage(report, record, page, pageSize);

    async function* body(): AsyncIterable<Uint8Array> {
      const head = Buffer.from(writer.header(report.key, report.columns), 'utf8');
      digest.update(head);
      yield new Uint8Array(head);

      for (let page = 1; ; page += 1) {
        const slice = await read(page);
        if (slice.length === 0) {
          break;
        }
        for (const row of slice) {
          if (counters.rows >= maxRows) {
            counters.truncated = true;
            break;
          }
          const chunk = Buffer.from(writer.row(report.columns, row), 'utf8');
          digest.update(chunk);
          counters.rows += 1;
          yield new Uint8Array(chunk);
        }
        if (counters.truncated || slice.length < pageSize) {
          break;
        }
      }

      const tail = Buffer.from(writer.footer(), 'utf8');
      if (tail.length > 0) {
        digest.update(tail);
        yield new Uint8Array(tail);
      }
    }

    const stored = await this.files.storeStreamed({
      bundleId: String(record.id),
      name,
      body: body(),
      mimeType: mediaType,
    });
    if (counters.truncated) {
      this.logger.warn('A report export reached the row cap and was truncated', {
        exportId: record.id,
        reportKey: record.reportKey,
        maxRows,
      });
    }
    return {
      rowCount: counters.rows,
      storageKey: stored.storageKey,
      fileObjectId: stored.id,
      sizeBytes: digest.sizeBytes,
      sha256: digest.digest(),
      truncated: counters.truncated,
      substitutions: 0,
    };
  }

  /** The one format that is assembled rather than streamed, and therefore bounded harder. */
  private async producePdf(
    record: ReportExportRecord,
    report: CatalogueEntry,
    name: string,
    mediaType: string,
  ) {
    const pageSize = this.config.reporting.exportBatchSize;
    const maxRows = this.config.reporting.pdfMaxRows;
    const rows: ReportRow[] = [];
    let truncated = false;

    for (let page = 1; ; page += 1) {
      const slice = await this.readPage(report, record, page, pageSize);
      if (slice.length === 0) {
        break;
      }
      for (const row of slice) {
        if (rows.length >= maxRows) {
          truncated = true;
          break;
        }
        rows.push(row);
      }
      if (truncated || slice.length < pageSize) {
        break;
      }
    }

    const context = requireContext();
    const rendered = await renderReportPdf({
      title: report.key,
      columns: report.columns,
      rows,
      parameters: record.parameters,
      requestedBy: String(record.requestedById),
      producedAt: this.clock.now(),
      totalRows: rows.length,
      tenantName: context.tenantId,
    });

    const digest = new StreamDigest();
    digest.update(rendered.bytes);
    const stored = await this.files.storeStreamed({
      bundleId: String(record.id),
      name,
      body: single(rendered.bytes),
      mimeType: mediaType,
    });
    return {
      rowCount: rows.length,
      storageKey: stored.storageKey,
      fileObjectId: stored.id,
      sizeBytes: digest.sizeBytes,
      sha256: digest.digest(),
      truncated,
      substitutions: rendered.substitutions,
    };
  }

  /**
   * One page from the source, through the caller's own reach.
   *
   * The parameters are re-parsed from the stored strings rather than a parsed object being carried
   * on the record. The record holds what somebody *asked for*, which is what the trail and the PDF
   * print; turning it into dates and identifiers is the catalogue's job, and doing it in one place
   * means the export cannot interpret a parameter differently from the screen that previewed it.
   */
  private async readPage(
    report: CatalogueEntry,
    record: ReportExportRecord,
    page: number,
    pageSize: number,
  ): Promise<readonly ReportRow[]> {
    const parsed = parseParameters(report, record.parameters);
    if (!parsed.ok) {
      throw new Error('The stored parameters are no longer valid for this report.');
    }
    const result = await this.unitOfWork.run(() =>
      this.sourceFor(report).run({
        query: report.query,
        dates: parsed.parameters.dates,
        strings: parsed.parameters.strings,
        booleans: parsed.parameters.booleans,
        page: { page, pageSize },
      }),
    );
    return result.data;
  }

  private sourceFor(report: CatalogueEntry): ReportSource {
    switch (report.source) {
      case 'DOCUMENT':
        return this.documents;
      case 'WORKFLOW':
        return this.workflow;
      case 'STORAGE':
        return this.storage;
      case 'PEOPLE':
        return this.people;
      case 'ORGANIZATION':
        return this.organization;
      case 'RETENTION':
        return this.retention;
      case 'AUDIT':
        return this.audit;
    }
  }

  private async failed(record: ReportExportRecord, reason: string): Promise<void> {
    await this.unitOfWork.run(() => this.exports.fail(record.id, reason));
    await this.auditOutcome(record, AuditOutcome.FAILED, {
      state: ReportExportState.FAILED,
      reportKey: record.reportKey,
      parameters: record.parameters,
      error: reason,
    });
  }

  private async auditOutcome(
    record: ReportExportRecord,
    outcome: typeof AuditOutcome.SUCCESS | typeof AuditOutcome.FAILED,
    after: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.writer.write<void>(() =>
      Promise.resolve({
        result: undefined,
        change: {
          action: ReportingAudit.REPORT_EXPORTED,
          subjectType: AuditSubjectType.EXPORT,
          subjectId: record.id,
          operation: AdministrativeOperation.UPDATED,
          after: { ...after, outcome },
        },
      }),
    );
  }
}

// eslint-disable-next-line @typescript-eslint/require-await -- a generator, not a task
async function* single(content: Buffer): AsyncIterable<Uint8Array> {
  yield new Uint8Array(content);
}
