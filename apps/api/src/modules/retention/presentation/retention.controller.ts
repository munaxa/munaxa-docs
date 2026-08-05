import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';

import {
  type ApproveDispositionBody,
  type LegalHold as WireLegalHold,
  type PlaceLegalHoldBody,
  type RecycleBinItem,
  type RecycleBinQuery,
  type ReleaseLegalHoldBody,
  type RetentionScheduleView,
  type Tombstone as WireTombstone,
  approveDispositionSchema,
  placeLegalHoldSchema,
  recycleBinQuerySchema,
  releaseLegalHoldSchema,
} from '@edms/contracts';
import { type DocumentId, Permission, asId } from '@edms/domain';
import { normalizePageRequest } from '@edms/utils';

import { RequirePermission } from '../../../core/authorization/permission.decorator';
import { ZodValidationPipe } from '../../../core/http/zod-validation.pipe';
import {
  type DeletedItem,
  LEGAL_HOLD_SERVICE,
  type LegalHoldRecord,
  type LegalHoldService,
  RECYCLE_BIN_SERVICE,
  RETENTION_SERVICE,
  type RecycleBinService,
  type RetentionScheduleRecord,
  type RetentionService,
  type TombstoneRecord,
} from '../application/ports';

interface PageMeta {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly hasMore: boolean;
}

/**
 * The recycle bin (`16-frontend-architecture.md` §2's top-level route, finally served).
 *
 * `document:restore` gates it, per ADR-0010 §2: "deleted objects are visible in a recycle bin to
 * holders of `document:restore`". Listing only — restoring goes through the owning module's own
 * endpoint, which carries the owning module's own rules.
 */
@Controller({ path: 'recycle-bin', version: '1' })
export class RecycleBinController {
  constructor(@Inject(RECYCLE_BIN_SERVICE) private readonly bin: RecycleBinService) {}

  @Get()
  @RequirePermission(Permission.DOCUMENT_RESTORE)
  async list(
    @Query(new ZodValidationPipe(recycleBinQuerySchema)) query: RecycleBinQuery,
  ): Promise<{ data: readonly RecycleBinItem[]; meta: PageMeta }> {
    const page = await this.bin.list({
      ...normalizePageRequest(query),
      search: query.search,
      kind: query.kind,
      sortBy: query.sortBy,
      sortDirection: query.sortDirection,
    });
    return { data: page.data.map(toBinItem), meta: page.meta };
  }
}

/**
 * Legal holds, on the document they hold.
 *
 * One permission for all three operations: `legal-hold:manage` has been in the catalogue since
 * Phase 1, granted by the seed to the roles accountable for litigation response. Reading is behind
 * the same grant as writing, deliberately — who is holding a record, and for which matter, is
 * counsel's business and not part of the document's ordinary metadata.
 */
@Controller({ path: 'documents/:documentId/holds', version: '1' })
@RequirePermission(Permission.LEGAL_HOLD_MANAGE)
export class LegalHoldsController {
  constructor(@Inject(LEGAL_HOLD_SERVICE) private readonly holds: LegalHoldService) {}

  @Get()
  async list(@Param('documentId') documentId: string): Promise<{ data: readonly WireLegalHold[] }> {
    const holds = await this.holds.listFor(asId<DocumentId>(documentId));
    return { data: holds.map(toHold) };
  }

  @Post()
  async place(
    @Param('documentId') documentId: string,
    @Body(new ZodValidationPipe(placeLegalHoldSchema)) body: PlaceLegalHoldBody,
  ): Promise<WireLegalHold> {
    return toHold(await this.holds.place(documentId, body.reason));
  }

  @Post(':holdId/release')
  @HttpCode(HttpStatus.NO_CONTENT)
  async release(
    @Param('holdId') holdId: string,
    @Body(new ZodValidationPipe(releaseLegalHoldSchema)) body: ReleaseLegalHoldBody,
  ): Promise<void> {
    await this.holds.release(holdId, body.reason);
  }
}

/**
 * The disposition queue and the register (`retention:manage`).
 *
 * Note the verb that is missing: there is no purge endpoint. Approving moves a schedule to
 * `IN_REVIEW`; the sweep — single consumer, never concurrent with itself — is what executes.
 */
@Controller({ path: 'retention', version: '1' })
@RequirePermission(Permission.RETENTION_MANAGE)
export class RetentionController {
  constructor(@Inject(RETENTION_SERVICE) private readonly retention: RetentionService) {}

  /** What is due or awaiting review, oldest first — the review queue. */
  @Get('dispositions')
  async dispositions(): Promise<{ data: readonly RetentionScheduleView[] }> {
    const due = await this.retention.listDue(200);
    return { data: due.map(toScheduleView) };
  }

  /** One document's schedules, for the record page's retention panel. */
  @Get('schedules/:documentId')
  async schedules(
    @Param('documentId') documentId: string,
  ): Promise<{ data: readonly RetentionScheduleView[] }> {
    const schedules = await this.retention.scheduleFor(asId<DocumentId>(documentId));
    return { data: schedules.map(toScheduleView) };
  }

  @Post('dispositions/:scheduleId/approve')
  @HttpCode(HttpStatus.NO_CONTENT)
  async approve(
    @Param('scheduleId') scheduleId: string,
    @Body(new ZodValidationPipe(approveDispositionSchema)) body: ApproveDispositionBody,
  ): Promise<void> {
    await this.retention.approveDisposition(scheduleId, body.note);
  }

  /** The disposition register: what this tenant has destroyed, and when. */
  @Get('tombstones')
  async tombstones(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<{ data: readonly WireTombstone[]; meta: PageMeta }> {
    const result = await this.retention.listTombstones(
      normalizePageRequest({ page: Number(page ?? 1), pageSize: Number(pageSize ?? 25) }),
    );
    return { data: result.data.map(toTombstone), meta: result.meta };
  }
}

// --- Mapping --------------------------------------------------------------------------------

function toBinItem(item: DeletedItem): RecycleBinItem {
  return {
    id: item.id,
    kind: item.kind,
    name: item.name,
    documentNumber: item.documentNumber,
    path: item.path,
    deletedAt: item.deletedAt.toISOString(),
    deletedBy: item.deletedBy,
    deletedByName: item.deletedByName,
    deleteReason: item.deleteReason,
    cascadeId: item.cascadeId,
    version: item.version,
  };
}

function toHold(hold: LegalHoldRecord): WireLegalHold {
  return {
    id: hold.id,
    documentId: hold.documentId,
    reason: hold.reason,
    placedBy: hold.placedBy,
    placedAt: hold.placedAt.toISOString(),
    releasedAt: hold.releasedAt === null ? null : hold.releasedAt.toISOString(),
    releasedById: hold.releasedById,
    releaseReason: hold.releaseReason,
  };
}

function toScheduleView(schedule: RetentionScheduleRecord): RetentionScheduleView {
  return {
    id: schedule.id,
    documentId: schedule.documentId,
    policyId: schedule.policyId,
    trigger: schedule.trigger,
    triggerAt: schedule.triggerAt.toISOString(),
    dueAt: schedule.dueAt.toISOString(),
    disposition: schedule.disposition,
    state: schedule.state,
    reviewRequired: schedule.reviewRequired,
    reviewedById: schedule.reviewedById,
    reviewedAt: schedule.reviewedAt === null ? null : schedule.reviewedAt.toISOString(),
    reviewNote: schedule.reviewNote,
    executedAt: schedule.executedAt === null ? null : schedule.executedAt.toISOString(),
  };
}

function toTombstone(tombstone: TombstoneRecord): WireTombstone {
  return {
    documentId: tombstone.documentId,
    documentNumber: tombstone.documentNumber,
    title: tombstone.title,
    documentTypeName: tombstone.documentTypeName,
    folderPath: tombstone.folderPath,
    deletedAt: tombstone.deletedAt === null ? null : tombstone.deletedAt.toISOString(),
    purgedAt: tombstone.purgedAt.toISOString(),
    purgedById: tombstone.purgedById,
    revisionsRemoved: tombstone.revisionsRemoved,
    blobsDereferenced: tombstone.blobsDereferenced,
  };
}
