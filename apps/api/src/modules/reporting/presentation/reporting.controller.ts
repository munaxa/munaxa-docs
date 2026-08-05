import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';

import {
  type ReportDefinition as WireDefinition,
  type ReportDescriptor,
  type ReportExport as WireExport,
  type ReportExportLink,
  type ReportPage,
  type RequestExportBody,
  type SaveReportDefinitionBody,
  requestExportBodySchema,
  runReportQuerySchema,
  saveReportDefinitionSchema,
} from '@edms/contracts';
import { type AnyId, Permission, type ReportDefinitionId, asId } from '@edms/domain';
import { normalizePageRequest } from '@edms/utils';

import { RequirePermission } from '../../../core/authorization/permission.decorator';
import { NotFoundError } from '../../../core/errors/application-errors';
import { ZodValidationPipe } from '../../../core/http/zod-validation.pipe';
import { FORMAT_PARAMETER, type ReportDefinition } from '../domain/report-catalogue';
import { ReportDefinitionService } from '../application/report-definition.service';
import {
  REPORTING_SERVICE,
  type ReportExportRecord,
  type ReportingService,
} from '../application/ports';

/**
 * The reporting surface — 15 §1's `GET /api/v1/reports/{key}`, and what it needs around it.
 *
 * ## The gate on this controller is the *floor*, not the whole of it
 *
 * `@RequirePermission(Permission.REPORT_VIEW)` is on the class, and every report requires more than
 * it: the deleted report also requires `document:restore`, the expired report `retention:manage`,
 * the audit report `audit:view`, users `user:manage`, departments `org:manage`. Those are resolved
 * **in the service**, per report, against the ACL resolver — not here, and not by a decorator.
 *
 * That is a deliberate departure from how the rest of this product gates, and it is worth stating.
 * `@RequirePermission` names one permission per route, and this is one route serving ten resources
 * with five different gates. Declaring the loosest of them at the door and the rest inside is
 * exactly the shape `NavigationDestination.anyOf` exists to avoid — *except* that here the
 * decorator is the loosest gate and the service enforces the conjunction, so nothing is reachable
 * on the floor alone. `RouteRegistry`'s boot-time assertion is satisfied by the class decorator,
 * the real decision is one `capabilitiesFor` call, and the integration suite asserts the refusal
 * per report rather than trusting the arrangement.
 *
 * ## Every route here reads except two, and both of those queue rather than produce
 *
 * `POST /reports/{key}/exports` returns `202` with the export record: a report worth exporting is a
 * report worth not holding a request open for, which is `REPORTING_SERVICE`'s own contract since
 * Phase 0.5. `POST /reports/definitions` saves a set of parameters and nothing else.
 *
 * There is deliberately **no route that streams a report body**. A `GET` that rendered a CSV inline
 * would be the streamed-from-a-request shape the port forbids, and it would also be the one path
 * on which a report's bytes never reach `file_object` — so nothing would carry a digest and
 * `FILE_DOWNLOAD_ISSUED` would never be written for a file that left the product.
 */
@Controller({ path: 'reports', version: '1' })
@RequirePermission(Permission.REPORT_VIEW)
export class ReportingController {
  constructor(
    @Inject(REPORTING_SERVICE) private readonly reports: ReportingService,
    private readonly definitions: ReportDefinitionService,
  ) {}

  /**
   * The reports this caller may run.
   *
   * Resolved rather than listed: a report whose permissions the caller does not hold is **absent**,
   * not disabled. Phase 13's rule for tiles, applied to a menu — a greyed-out row named "Deleted
   * documents" tells somebody the product keeps one.
   */
  @Get()
  async available(): Promise<{ data: readonly ReportDescriptor[] }> {
    return { data: (await this.reports.available()).map(toDescriptor) };
  }

  /** The caller's own saved definitions. No route here names an owner. */
  @Get('definitions')
  async listDefinitions(
    @Query(new ZodValidationPipe(runReportQuerySchema)) query: Record<string, string>,
  ): Promise<{ data: readonly WireDefinition[] }> {
    const page = await this.definitions.listForCaller(normalizePageRequest(query));
    return {
      data: page.data.map((record) => ({
        id: String(record.id),
        key: record.key,
        name: record.name,
        parameters: record.query as Readonly<Record<string, string>>,
      })),
    };
  }

  @Post('definitions')
  @HttpCode(201)
  async saveDefinition(
    @Body(new ZodValidationPipe(saveReportDefinitionSchema)) body: SaveReportDefinitionBody,
  ): Promise<WireDefinition> {
    const record = await this.definitions.save(body.key, body.name, body.parameters);
    return {
      id: String(record.id),
      key: record.key,
      name: record.name,
      parameters: record.query as Readonly<Record<string, string>>,
    };
  }

  @Delete('definitions/:id')
  @HttpCode(204)
  async deleteDefinition(@Param('id') id: string): Promise<void> {
    await this.definitions.remove(asId<ReportDefinitionId>(id));
  }

  /**
   * Every export this tenant has requested, newest first.
   *
   * Tenant-wide rather than the caller's own, and gated by `report:view` alone — which is a
   * decision worth naming. An export row carries a report key and its parameters, not its rows, and
   * "who has been exporting the deleted-documents report" is a question the people who hold
   * `report:view` should be able to ask about their own tenant. The *file* is a different matter:
   * `downloadExport` re-checks the report's full permission set before signing anything, so a row
   * being visible in this list never implies its contents are reachable.
   */
  @Get('exports')
  async listExports(
    @Query(new ZodValidationPipe(runReportQuerySchema)) query: Record<string, string>,
  ): Promise<{ data: readonly WireExport[] }> {
    const page = await this.reports.listExports(normalizePageRequest(query));
    return { data: page.data.map(toExport) };
  }

  @Get('exports/:id')
  async export(@Param('id') id: string): Promise<WireExport> {
    const record = await this.reports.export(asId<AnyId>(id));
    if (record === null) {
      throw new NotFoundError('The requested resource');
    }
    return toExport(record);
  }

  /**
   * A signed URL for a completed export.
   *
   * Audited by Storage as it is issued — `createDownloadUrl` writes `FILE_DOWNLOAD_ISSUED`, which
   * is already the row for "a signed URL for these bytes was handed to somebody". This phase adds
   * no second action for it: 13 §2 gives Reporting exactly one row, and it is spent on the export.
   */
  @Get('exports/:id/download')
  async download(@Param('id') id: string): Promise<ReportExportLink> {
    const link = await this.reports.downloadExport(asId<AnyId>(id));
    return {
      url: link.url,
      expiresAt: link.expiresAt.toISOString(),
      filename: link.filename,
    };
  }

  /**
   * One page of a report.
   *
   * The parameters arrive as the rest of the query string, which is why the schema is the only
   * `passthrough` in the contracts package: a report's parameters are the catalogue's and differ per
   * key. Paging is stripped out here rather than being left for the service to ignore — a report
   * that received `page` as a filter would refuse it as an unknown parameter, which is the right
   * behaviour for a misspelling and the wrong behaviour for the paging every list shares.
   */
  @Get(':key')
  async run(
    @Param('key') key: string,
    @Query(new ZodValidationPipe(runReportQuerySchema)) query: Record<string, unknown>,
  ): Promise<ReportPage> {
    const page = await this.reports.run(key, parametersFrom(query), normalizePageRequest(query));
    const descriptor = (await this.reports.available()).find((report) => report.key === key);
    return {
      key,
      // The columns travel with the page, from the same catalogue the query was built from, so a
      // client renders what the server says exists rather than what it remembers. A report that
      // served one column set and exported another would be two reports with one name.
      columns: descriptor === undefined ? [] : descriptor.columns.map((column) => ({ ...column })),
      data: page.data,
      meta: page.meta,
    };
  }

  /**
   * Queues an export. `202`, because the file does not exist yet and saying otherwise would be a
   * lie the client then polls to discover.
   */
  @Post(':key/exports')
  @HttpCode(202)
  async requestExport(
    @Param('key') key: string,
    @Body(new ZodValidationPipe(requestExportBodySchema)) body: RequestExportBody,
  ): Promise<WireExport> {
    // The format joins the parameters here rather than widening `requestExport`, whose two-argument
    // signature has been stable since Phase 0.5. `FORMAT_PARAMETER` is reserved in the catalogue,
    // and a unit test asserts no report declares a parameter by that name.
    const { jobId } = await this.reports.requestExport(key, {
      ...body.parameters,
      [FORMAT_PARAMETER]: body.format,
    });
    const record = await this.reports.export(asId<AnyId>(jobId));
    if (record === null) {
      throw new NotFoundError('The requested resource');
    }
    return toExport(record);
  }
}

/** Paging is the list contract's; everything else in the query string is the report's. */
function parametersFrom(query: Record<string, unknown>): Readonly<Record<string, string>> {
  const parameters: Record<string, string> = {};
  for (const [name, value] of Object.entries(query)) {
    if (PAGING.has(name) || typeof value !== 'string') {
      continue;
    }
    parameters[name] = value;
  }
  return parameters;
}

const PAGING: ReadonlySet<string> = new Set(['page', 'pageSize', 'sortBy', 'sortDirection']);

function toDescriptor(report: ReportDefinition): ReportDescriptor {
  return {
    key: report.key,
    scoping: report.scoping,
    parameters: report.parameters.map((parameter) => ({
      name: parameter.name,
      kind: parameter.kind,
      required: parameter.required,
      values: parameter.values === undefined ? null : [...parameter.values],
    })),
    columns: report.columns.map((column) => ({ ...column })),
    chart: report.chart,
  };
}

function toExport(record: ReportExportRecord): WireExport {
  return {
    id: String(record.id),
    reportKey: record.reportKey,
    format: record.format,
    state: record.state,
    parameters: record.parameters,
    requestedAt: record.requestedAt.toISOString(),
    rowCount: record.rowCount,
    sizeBytes: record.sizeBytes,
    sha256: record.sha256,
    truncated: record.truncated,
    substitutions: record.substitutions,
    completedAt: record.completedAt?.toISOString() ?? null,
    error: record.error,
  };
}
