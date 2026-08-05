import { Inject, Injectable } from '@nestjs/common';

import {
  type AnyId,
  type PermissionKey,
  type UserId,
  AuditSubjectType,
  QueueName,
  ScopeType,
  asId,
} from '@edms/domain';
import type { Page, PageRequest } from '@edms/utils';

import {
  ACL_RESOLVER,
  type AclResolver,
  type AuthorizationSubject,
} from '../../../core/authorization/acl-resolver.port';
import {
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
} from '../../../core/errors/application-errors';
import { AdministeredWriter, AdministrativeOperation } from '../../../core/persistence';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { QUEUE_PORT, type QueuePort } from '../../../ports/queue.port';
import { STORAGE_SERVICE, type StorageService } from '../../storage/application/ports';
import { ReportingAudit } from '../domain/audit-actions';
import {
  REPORTS,
  type ReportDefinition as CatalogueEntry,
  artefactNameFor,
  reportFor,
} from '../domain/report-catalogue';
import { parseParameters, type ParsedParameters } from '../domain/report-parameters';
import {
  REPORT_AUDIT_SOURCE,
  REPORT_DOCUMENT_SOURCE,
  REPORT_EXPORT_REPOSITORY,
  REPORT_ORGANIZATION_SOURCE,
  REPORT_PEOPLE_SOURCE,
  REPORT_RETENTION_SOURCE,
  REPORT_STORAGE_SOURCE,
  REPORT_WORKFLOW_SOURCE,
  ReportExportState,
  type ReportExportRecord,
  type ReportExportRepository,
  type ReportRow,
  type ReportSource,
  type ReportingService,
} from './ports';

/**
 * Reports, run and exported.
 *
 * ---
 *
 * ## The gate, stated once so a report added later inherits it rather than re-deriving it
 *
 * **Every permission on a catalogue entry is required, and they are resolved in one call.** Not
 * "any of" — a conjunction. `report:view` says somebody may ask an aggregate question about this
 * tenant; it does not say which rows, and every report whose rows an earlier phase put behind a
 * second permission carries that permission too. The deleted report needs `document:restore`
 * because ADR-0010 §2 put the recycle bin there; the expired report needs `retention:manage`; the
 * audit report needs `audit:view`. **A report never widens the audience of the surface it
 * summarises**, and that sentence is the whole of this phase's authorisation design.
 *
 * They are resolved in a single `capabilitiesFor` for the reason Phase 13 gives: two decisions
 * taken a few milliseconds apart are two chances for the answer to change mid-request, and a report
 * whose gate was half-true at any instant was never true at all. The token's `permissions` claim is
 * deliberately not read — 08 §3 makes collecting the subject the resolver's job, and the token is a
 * snapshot taken at sign-in.
 *
 * ## And the refusal is a refusal, not an empty report
 *
 * A caller without a report's permissions gets `ForbiddenError`, not zero rows. Phase 13 made the
 * same distinction for tiles and stated why: "you may not ask" and "there are none" are different
 * answers, and collapsing them tells somebody there is nothing in a part of the tenant they cannot
 * see into — which the day the real number stops being zero they would also learn. A refused
 * *report* is louder than a refused tile because a report is a page somebody navigated to, so it is
 * a `403` the screen renders as a refusal rather than a `FORBIDDEN` state on a card.
 *
 * ## Running a report writes nothing to the trail
 *
 * 13 §2 gives this phase exactly one row and `domain/audit-actions.ts` records why the read is not
 * it. What is audited is the *export*, twice, and the first row carries the parameters.
 *
 * ## Nothing is cached
 *
 * For Phase 13's reason and one more. Its reason: every figure is about work waiting for the person
 * reading it, and a stale number is one somebody acts on. The extra one: a report is
 * *permission-scoped*, so a cache key would have to include the caller's whole reach — and
 * `VisibilityFilter.fingerprint` exists precisely so that is expressible, which makes it a
 * temptation rather than an impossibility. It is refused anyway: the resolver already caches the
 * filter (08 §8, Phase 14), so the expensive half is cached where it is invalidated correctly, and
 * caching the *rows* would mean a second thing to invalidate on every document change in the tenant.
 */
@Injectable()
export class DefaultReportingService implements ReportingService {
  constructor(
    @Inject(ACL_RESOLVER) private readonly acl: AclResolver,
    @Inject(REPORT_EXPORT_REPOSITORY) private readonly exports: ReportExportRepository,
    @Inject(REPORT_DOCUMENT_SOURCE) private readonly documents: ReportSource,
    @Inject(REPORT_WORKFLOW_SOURCE) private readonly workflow: ReportSource,
    @Inject(REPORT_STORAGE_SOURCE) private readonly storage: ReportSource,
    @Inject(REPORT_PEOPLE_SOURCE) private readonly people: ReportSource,
    @Inject(REPORT_ORGANIZATION_SOURCE) private readonly organization: ReportSource,
    @Inject(REPORT_RETENTION_SOURCE) private readonly retention: ReportSource,
    @Inject(REPORT_AUDIT_SOURCE) private readonly audit: ReportSource,
    @Inject(QUEUE_PORT) private readonly queue: QueuePort,
    @Inject(STORAGE_SERVICE) private readonly files: StorageService,
    private readonly writer: AdministeredWriter,
  ) {}

  async run(
    key: string,
    parameters: Readonly<Record<string, string>>,
    page: PageRequest,
  ): Promise<Page<ReportRow>> {
    const report = this.require(key);
    await this.authorise(report);
    const parsed = this.parse(report, parameters);

    return this.writer.read(() =>
      this.sourceFor(report).run({
        query: report.query,
        dates: parsed.dates,
        strings: parsed.strings,
        booleans: parsed.booleans,
        page,
      }),
    );
  }

  /**
   * Records the request, audits it with the parameters, and hands the work to the lane.
   *
   * `202` at the endpoint, because a report worth exporting is a report worth not holding a request
   * open for — and because a streamed response would have to be produced under the request's own
   * timeout, connection and memory, which is what `REPORTING_SERVICE`'s own comment forbids:
   * *"large exports are queued and audited rather than streamed from a request"*.
   *
   * The enqueue happens **after** the transaction, not inside it. The outbox rule exists for
   * events; this is a job whose row is its own record, and enqueuing before commit would let a
   * consumer claim a row nothing had written yet. Phase 9's `AuditExportService.request` is the
   * same shape and the same comment.
   *
   * The permission is checked here, at request time, **and again when the export runs** — not
   * because this one is untrusted, but because the run happens later and Phase 11's rule applies:
   * authority is read at the instant it is used. Somebody whose grant is revoked while their export
   * sits in the queue does not get the file.
   */
  async requestExport(
    key: string,
    parameters: Readonly<Record<string, string>>,
  ): Promise<{ jobId: string }> {
    const report = this.require(key);
    await this.authorise(report);
    const parsed = this.parse(report, parameters);
    const context = requireContext();
    if (context.userId === null) {
      // An export is always somebody's act. There is no system path to one, and a nullable
      // requester would make "who took a copy of this" unanswerable for exactly the export an
      // investigation cares about — Phase 9's reasoning, and it holds identically here.
      throw new UnauthenticatedError('A report export must be requested by a signed-in user.');
    }

    const record = await this.writer.write<ReportExportRecord>(async () => {
      const created: ReportExportRecord = {
        id: asId<AnyId>(this.writer.clock.nextId()),
        reportKey: report.key,
        format: parsed.format,
        state: ReportExportState.REQUESTED,
        parameters: parsed.supplied,
        requestedById: context.userId as UserId,
        requestedAt: this.writer.clock.now(),
        rowCount: 0,
        storageKey: null,
        fileObjectId: null,
        sizeBytes: 0,
        sha256: null,
        truncated: false,
        substitutions: 0,
        completedAt: null,
        error: null,
      };
      await this.exports.insert(created);
      return {
        result: created,
        change: {
          action: ReportingAudit.REPORT_EXPORTED,
          subjectType: AuditSubjectType.EXPORT,
          subjectId: created.id,
          operation: AdministrativeOperation.CREATED,
          after: {
            reportKey: report.key,
            format: parsed.format,
            state: ReportExportState.REQUESTED,
            // The parameters that produced it. Without them the trail records that somebody
            // exported "the documents report" and nothing about *which* documents, which is the
            // only part an investigation six months later is asking about.
            parameters: parsed.supplied,
          },
        },
      };
    });

    await this.queue.enqueue(
      QueueName.REPORTING_EXPORT,
      { kind: 'reporting.export', tenantId: context.tenantId, exportId: record.id },
      { jobId: `reporting:export:${record.id}` },
    );
    // Phase 0.5's declared return shape, unchanged. The identifier is the export's, which is also
    // the queue job's, so a client polling `GET /reports/exports/{id}` needs nothing else.
    return { jobId: String(record.id) };
  }

  /**
   * The reports this caller may run — resolved, not guessed.
   *
   * One `capabilitiesFor` over the union of every permission the catalogue mentions, then a filter.
   * The alternative, one resolution per report, is ten walks for a menu; the alternative to
   * resolving at all is reading the token, which 08 §3 forbids for the reason a menu makes vivid —
   * a role revoked after sign-in would leave a report listed and refused.
   *
   * A report the caller may not run is **absent**, not disabled. Phase 13's rule for tiles applied
   * to a list: a greyed-out row named "Deleted documents" tells somebody the product keeps one.
   */
  async available(): Promise<readonly CatalogueEntry[]> {
    const held = await this.capabilities(ALL_REPORT_PERMISSIONS);
    return REPORTS.filter((report) => report.permissions.every((permission) => held(permission)));
  }

  export(id: AnyId): Promise<ReportExportRecord | null> {
    return this.writer.read(() => this.exports.findById(id));
  }

  listExports(page: PageRequest): Promise<Page<ReportExportRecord>> {
    return this.writer.read(() => this.exports.list(page));
  }

  /**
   * A signed URL for a completed export.
   *
   * Through Storage's own `createDownloadUrl`, which writes `FILE_DOWNLOAD_ISSUED` — so the trail
   * records that these bytes were handed to somebody, without this phase inventing a second action
   * for it. Signing here instead would be a second place that obligation has to be remembered, and
   * the second place is the one that gets forgotten (Phase 9's words, and its practice).
   *
   * **The report's permissions are re-checked**, not merely the export's ownership. An export is a
   * file of rows somebody was entitled to at request time; the entitlement can be withdrawn, and a
   * link that kept working afterwards would be the revocation not applying to the one artefact that
   * left the product.
   */
  async downloadExport(id: AnyId): Promise<{ url: string; expiresAt: Date; filename: string }> {
    const record = await this.export(id);
    if (
      record === null ||
      record.state !== ReportExportState.COMPLETED ||
      record.fileObjectId === null
    ) {
      // Indistinguishable from "no such export", deliberately: an export that failed and an export
      // that is somebody else's should not be told apart by the shape of the refusal.
      throw new NotFoundError('The requested resource');
    }
    const report = this.require(record.reportKey);
    await this.authorise(report);

    const filename = artefactNameFor(record.reportKey, record.format);
    const signed = await this.files.createDownloadUrl(asId(record.fileObjectId), filename);
    return { url: signed.url, expiresAt: signed.expiresAt, filename };
  }

  // --- Internals ------------------------------------------------------------------------------

  private require(key: string): CatalogueEntry {
    const report = reportFor(key);
    if (report === null) {
      // A `404`, not a validation error: the catalogue is a set of resources, and a key that is not
      // in it is a resource that does not exist.
      throw new NotFoundError('The requested resource');
    }
    return report;
  }

  private parse(
    report: CatalogueEntry,
    parameters: Readonly<Record<string, string>>,
  ): ParsedParameters {
    const outcome = parseParameters(report, parameters);
    if (!outcome.ok) {
      throw new ValidationError('This report cannot be run with those parameters.', [
        ...outcome.errors,
      ]);
    }
    return outcome.parameters;
  }

  /** Every permission this report requires, or a refusal naming the first one missing. */
  private async authorise(report: CatalogueEntry): Promise<void> {
    const held = await this.capabilities(report.permissions);
    const missing = report.permissions.find((permission) => !held(permission));
    if (missing !== undefined) {
      throw new ForbiddenError(`This report requires ${missing}.`);
    }
  }

  private async capabilities(
    permissions: readonly PermissionKey[],
  ): Promise<(permission: PermissionKey) => boolean> {
    const context = requireContext();
    const subject: AuthorizationSubject = {
      userId: context.userId ?? asId<UserId>(''),
      roleIds: context.roles.map((role) => asId<AnyId>(role)),
      departmentIds: [],
      delegationIds: [],
    };
    const capabilities = await this.writer.read(() =>
      this.acl.capabilitiesFor(
        subject,
        { type: ScopeType.TENANT, id: asId<AnyId>(context.tenantId) },
        permissions,
      ),
    );
    return (permission) => capabilities[permission] === true;
  }

  /**
   * Which module answers this report.
   *
   * A switch over the catalogue's own enum rather than a map built at construction, so a source
   * added to `ReportSource` without a branch here is a compile error rather than a runtime one.
   */
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
}

/**
 * Every permission any report mentions, deduplicated.
 *
 * Derived from the catalogue rather than listed, so a report added with a new permission is
 * resolvable by `available()` on the day it is added — the failure mode a hand-written list has is
 * a report that nobody can ever see in the menu and everybody can run by URL.
 */
const ALL_REPORT_PERMISSIONS: readonly PermissionKey[] = Object.freeze([
  ...new Set(REPORTS.flatMap((report) => report.permissions)),
]);
