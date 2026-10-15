import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';

import {
  type AuditActions,
  type AuditEntry as WireAuditEntry,
  type AuditExport as WireAuditExport,
  type AuditExportDownload,
  type AuditExportRequestBody,
  type AuditPage,
  type AuditSearchQuery,
  type AuditTimelineQuery,
  auditExportRequestSchema,
  auditSearchQuerySchema,
  auditTimelineQuerySchema,
} from '@edms/contracts';
import { type AnyId, type AuditSubjectTypeKey, Permission, type UserId, asId } from '@edms/domain';
import { normalizePageRequest } from '@edms/utils';

import { RequirePermission } from '../../../core/authorization/permission.decorator';
import { APP_CONFIG, type AppConfig } from '../../../core/config';
import { NotFoundError } from '../../../core/errors/application-errors';
import { ZodValidationPipe } from '../../../core/http/zod-validation.pipe';
import { AuditExportService } from '../application/audit-export.service';
import { AuditReadService } from '../application/audit-read.service';
import type { AuditEventRecord, AuditExportRecord } from '../application/ports';

/**
 * The audit surface (`13-audit-architecture.md` §6).
 *
 * The gating is the interesting part, and it is deliberately not uniform.
 *
 * **A timeline is gated on `document:history:view`**, the permission that already means "may read
 * this thing's history", and then narrowed by the service to the caller's reach on the subject
 * itself. An author who may read a procedure may see who else has read it; that is what §6 means by
 * "filtered to what the caller may see", and `audit:view` would be the wrong gate because it is the
 * trail-*wide* grant and holding it is not a precondition for reading one document's story.
 *
 * **The search and the exports are gated on `audit:view` and `audit:export`.** Those are the two
 * permissions the catalogue has carried since Phase 1 and which have gated exactly nothing until
 * now. Crossing subjects is what makes them the right gate: a query that spans every document in
 * the tenant is the auditor's question, not the reader's.
 *
 * **A refusal is a 404.** 08 §7's rule, and it matters more here than anywhere: the existence of a
 * trail for a document number is itself an answer worth harvesting.
 */
@Controller({ path: 'audit', version: '1' })
export class AuditController {
  constructor(
    private readonly read: AuditReadService,
    private readonly exports: AuditExportService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * One subject's timeline.
   *
   * The subject type is in the path rather than inferred from the id, because the id alone cannot
   * say what it names — and the type is what decides which scope the permission is resolved on.
   */
  @Get('timeline/:subjectType/:subjectId')
  @RequirePermission(Permission.DOCUMENT_HISTORY_VIEW)
  async timeline(
    @Param('subjectType') subjectType: string,
    @Param('subjectId') subjectId: string,
    @Query(new ZodValidationPipe(auditTimelineQuerySchema)) query: AuditTimelineQuery,
  ): Promise<AuditPage> {
    const page = await this.read.timelineFor(
      subjectType as AuditSubjectTypeKey,
      asId<AnyId>(subjectId),
      normalizePageRequest(query),
    );
    return { data: page.data.map(toEntry), meta: page.meta };
  }

  @Get('events')
  @RequirePermission(Permission.AUDIT_VIEW)
  async search(
    @Query(new ZodValidationPipe(auditSearchQuerySchema)) query: AuditSearchQuery,
  ): Promise<AuditPage> {
    const page = await this.read.search(
      {
        from: query.from === undefined ? null : new Date(query.from),
        to: query.to === undefined ? null : new Date(query.to),
        actorId: query.actorId === undefined ? null : asId<UserId>(query.actorId),
        actions: query.action === undefined ? [] : [query.action].flat(),
        subjectType: query.subjectType ?? null,
        subjectId: query.subjectId === undefined ? null : asId<AnyId>(query.subjectId),
        outcome: query.outcome ?? null,
        correlationId: query.correlationId ?? null,
      },
      normalizePageRequest(query),
    );
    return { data: page.data.map(toEntry), meta: page.meta };
  }

  /** The filter list. Distinct actions actually present, not the catalogue's full vocabulary. */
  @Get('actions')
  @RequirePermission(Permission.AUDIT_VIEW)
  async actions(): Promise<AuditActions> {
    return { data: await this.read.actions() };
  }

  @Get('exports')
  @RequirePermission(Permission.AUDIT_EXPORT)
  async listExports(
    @Query(new ZodValidationPipe(auditTimelineQuerySchema)) query: AuditTimelineQuery,
  ): Promise<{ data: WireAuditExport[]; meta: AuditPage['meta'] }> {
    const page = await this.exports.list(normalizePageRequest(query));
    return { data: page.data.map((record) => this.toExport(record)), meta: page.meta };
  }

  /** 202: the bundle is produced on the lane, not in this request. */
  @Post('exports')
  @RequirePermission(Permission.AUDIT_EXPORT)
  @HttpCode(202)
  async requestExport(
    @Body(new ZodValidationPipe(auditExportRequestSchema)) body: AuditExportRequestBody,
  ): Promise<WireAuditExport> {
    const filters: Record<string, string> = {};
    for (const key of ['action', 'actorId', 'subjectType', 'outcome'] as const) {
      const value = body[key];
      if (value !== undefined) {
        filters[key] = value;
      }
    }
    return this.toExport(
      await this.exports.request(new Date(body.from), new Date(body.to), filters),
    );
  }

  @Get('exports/:id')
  @RequirePermission(Permission.AUDIT_EXPORT)
  async getExport(@Param('id') id: string): Promise<WireAuditExport> {
    const record = await this.exports.get(asId<AnyId>(id));
    if (record === null) {
      throw new NotFoundError('The requested resource');
    }
    return this.toExport(record);
  }

  /**
   * Verified download links for a completed bundle: every artefact, all or nothing, or with
   * `?artefact=` the one named — what the screen asks for, one click per file, so no browser
   * blocks the second of several downloads started at once (E-12).
   *
   * A `POST` rather than a `GET`, because issuing a capability that outlives the request is a
   * change to the world: it writes `BULK_DOWNLOAD` and a `FILE_DOWNLOAD_ISSUED` per artefact, and
   * a `GET` that a browser may prefetch or a proxy may cache would write those rows for a request
   * nobody made.
   */
  @Post('exports/:id/download')
  @RequirePermission(Permission.AUDIT_EXPORT)
  async download(
    @Param('id') id: string,
    @Query('artefact') artefact: string | undefined,
  ): Promise<AuditExportDownload> {
    if (artefact !== undefined && !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(artefact)) {
      throw new NotFoundError('The requested resource');
    }
    const links = await this.exports.download(asId<AnyId>(id), artefact ?? null);
    return {
      data: links.map((link) => ({
        name: link.name,
        url: link.url,
        expiresAt: link.expiresAt.toISOString(),
      })),
    };
  }

  /** The wire shape, with whether each artefact is small enough to verify for download. */
  private toExport(record: AuditExportRecord): WireAuditExport {
    return {
      id: record.id,
      state: record.state,
      from: record.from.toISOString(),
      to: record.to.toISOString(),
      filters: record.filters,
      requestedById: record.requestedById,
      requestedAt: record.requestedAt.toISOString(),
      eventCount: record.eventCount,
      artefacts: record.artefacts.map((artefact) => ({
        name: artefact.name,
        mediaType: artefact.mediaType,
        sizeBytes: artefact.sizeBytes,
        sha256: artefact.sha256,
        // Said on the row rather than discovered by a refused click; never an unverified link.
        tooLargeToDownload: artefact.sizeBytes > this.config.download.maxFileBytes,
      })),
      chainIntact: record.chainIntact,
      completedAt: record.completedAt?.toISOString() ?? null,
      error: record.error,
    };
  }
}

function toEntry(event: AuditEventRecord): WireAuditEntry {
  return {
    id: event.id,
    sequence: event.sequence.toString(),
    occurredAt: event.occurredAt.toISOString(),
    actorId: event.actorId,
    onBehalfOfId: event.onBehalfOfId,
    channel: event.channel,
    action: event.action,
    subjectType: event.subjectType,
    subjectId: event.subjectId,
    outcome: event.outcome,
    payload: event.payload,
    reason: event.reason,
    correlationId: event.correlationId,
    // Unlike `ipAddress` below, this *is* on the wire: it names a credential the tenant issued
    // rather than a person's location, and "which of our integrations did that" is a question the
    // administrator reading this screen is the right person to be asking.
    apiClientId: event.apiClientId,
    hash: event.hash,
    previousHash: event.previousHash,
    chainHashVersion: event.chainHashVersion,
    // `ipAddress` and `userAgent` are deliberately absent from the wire. They are in the trail and
    // in an evidence export, which is where an investigation reads them; putting them on a screen
    // that anyone with `document:history:view` can open would publish one colleague's address to
    // another for no question either of them is asking.
  };
}
