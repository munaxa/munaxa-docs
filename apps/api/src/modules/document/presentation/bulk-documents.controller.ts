import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';

import {
  type BulkExportBody,
  type BulkExportItems,
  type BulkExportLink,
  type BulkMetadataBody,
  type BulkOperationResult,
  type BulkOperationView,
  type BulkRestoreBody,
  type BulkUploadBody,
  type Collection,
  bulkExportItemsQuerySchema,
  bulkExportSchema,
  bulkMetadataSchema,
  bulkOperationListQuerySchema,
  bulkRestoreSchema,
  bulkUploadSchema,
} from '@edms/contracts';
import { Permission, type UserId, asId } from '@edms/domain';
import { normalizePageRequest } from '@edms/utils';

import type { BulkOperationRecord, BulkResult } from '../../../core/bulk';
import { BULK_OPERATION_REPOSITORY, type BulkOperationRepository } from '../../../core/bulk';
import { Inject } from '@nestjs/common';
import { RequirePermission } from '../../../core/authorization/permission.decorator';
import { NotFoundError } from '../../../core/errors/application-errors';
import { ZodValidationPipe } from '../../../core/http/zod-validation.pipe';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { BulkDocumentService } from '../application/bulk-document.service';
import { BulkExportService } from '../application/bulk-export.service';

/**
 * Bulk document operations.
 *
 * ## Why there is no `@ScopedTo` on the four that need it most
 *
 * `@ScopedTo` binds **one** route parameter to **one** object, so `AclGuard` can resolve that
 * object's scope chain before the use case runs. A bulk route has N objects in its body and no
 * route parameter at all, so the decorator cannot express what it needs to.
 *
 * The answer is not to leave the check out. It is made instead by `DefaultBulkExecutor`, per
 * object, through the same `ACL_RESOLVER` the guard uses, inside the transaction that writes that
 * object — which is strictly *stronger* than the guard, because the guard resolves once before the
 * use case and this resolves immediately before each write. The `@RequirePermission` decorators
 * below are still the tenant-wide floor, exactly as they are on every other route, and
 * `RoutePermissionRegistry` still fails the boot if one is missing.
 *
 * `POST /documents/bulk/upload` looks like the exception — its objects do not exist yet, so its
 * decision is `document:create` on **one** object, the destination folder — and it is not, because
 * `AclGuard` reads the scope binding from `request.params` and the folder arrives in the body. A
 * decorator naming a body field would silently resolve `undefined` and refuse every request, which
 * is a worse failure than not having one. So the folder's reach is resolved by the executor too,
 * once per file, answering the same decision each time.
 *
 * ## Why every one of these answers a body rather than `204`
 *
 * The only interesting thing about a bulk operation is the part that did not happen. A `204` would
 * be an endpoint that cannot say which two of forty documents were refused, or whether they were
 * refused for reach, for a legal hold, or by a failure.
 */
@Controller({ path: 'documents/bulk', version: '1' })
export class BulkDocumentsController {
  constructor(
    private readonly bulk: BulkDocumentService,
    private readonly exports: BulkExportService,
    @Inject(BULK_OPERATION_REPOSITORY) private readonly operations: BulkOperationRepository,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
  ) {}

  /**
   * Many uploaded files become many documents in one folder.
   *
   * The decision is about the *destination*, because the objects being created do not exist yet —
   * so the executor resolves the same folder scope for every file and answers the same thing each
   * time. That is not theatre: it means a caller who cannot reach the folder gets every file
   * refused with a reason, through the one code path that decides reach in this phase, rather than
   * through a second check written here.
   */
  @Post('upload')
  @RequirePermission(Permission.DOCUMENT_CREATE)
  async upload(
    @Body(new ZodValidationPipe(bulkUploadSchema)) body: BulkUploadBody,
  ): Promise<BulkOperationResult> {
    return toResult(await this.bulk.upload(body), 'UPLOAD');
  }

  @Post('metadata')
  @RequirePermission(Permission.DOCUMENT_EDIT)
  async metadata(
    @Body(new ZodValidationPipe(bulkMetadataSchema)) body: BulkMetadataBody,
  ): Promise<BulkOperationResult> {
    return toResult(await this.bulk.setMetadata(body), 'METADATA');
  }

  @Post('restore')
  @RequirePermission(Permission.DOCUMENT_RESTORE)
  async restore(
    @Body(new ZodValidationPipe(bulkRestoreSchema)) body: BulkRestoreBody,
  ): Promise<BulkOperationResult> {
    return toResult(await this.bulk.restore(body.ids), 'RESTORE');
  }

  /**
   * Releasing many documents.
   *
   * `document:download` rather than `document:view`: this is a release of content, and 08 §6
   * separates the two because a reader who may look at a controlled drawing and may not take a copy
   * is the ordinary case in this product.
   */
  @Post('exports')
  @RequirePermission(Permission.DOCUMENT_DOWNLOAD)
  async export(
    @Body(new ZodValidationPipe(bulkExportSchema)) body: BulkExportBody,
  ): Promise<BulkOperationResult> {
    return toResult(await this.exports.export(body.ids), 'EXPORT');
  }

  /**
   * A completed export's released documents, a page at a time, as the caller may see them now —
   * ADR-0026 §10, the export design §3.1. **No URL** is in it: a release is a link issued when one
   * item is clicked, below. Paged, so every item is reachable however many were exported.
   * Audited as `BULK_EXPORT_OPENED`, counts only.
   */
  @Get(':id/items')
  @RequirePermission(Permission.DOCUMENT_DOWNLOAD)
  async items(
    @Param('id') id: string,
    @Query(new ZodValidationPipe(bulkExportItemsQuerySchema))
    query: ReturnType<typeof bulkExportItemsQuerySchema.parse>,
  ): Promise<BulkExportItems> {
    const page = await this.exports.items(identifier(id), normalizePageRequest(query));
    return {
      operationId: page.operationId,
      tally: page.tally,
      hidden: page.hidden,
      manifestAvailable: page.manifestAvailable,
      data: page.data.map((item) => ({ ...item })),
      meta: page.meta,
    };
  }

  /**
   * A verified download link for one released document, issued as it is clicked and re-checked
   * in full: the export's own, released by it, and every rule of the document's own download.
   *
   * A `POST`, as for an evidence bundle: issuing a link writes `FILE_DOWNLOAD_ISSUED`, and a `GET`
   * a browser might prefetch would write it for a request nobody made.
   */
  @Post(':id/items/:documentId/link')
  @RequirePermission(Permission.DOCUMENT_DOWNLOAD)
  async itemLink(
    @Param('id') id: string,
    @Param('documentId') documentId: string,
  ): Promise<BulkExportLink> {
    const link = await this.exports.itemLink(identifier(id), identifier(documentId));
    return {
      documentId: link.documentId,
      filename: link.filename,
      url: link.url,
      expiresAt: link.expiresAt.toISOString(),
    };
  }

  /**
   * A verified download link for the export's manifest — its requester's, refused while it names
   * any document they can no longer see (the export design §4).
   */
  @Post(':id/manifest/link')
  @RequirePermission(Permission.DOCUMENT_DOWNLOAD)
  async manifestLink(@Param('id') id: string): Promise<BulkExportLink> {
    const link = await this.exports.manifestLink(identifier(id));
    return {
      documentId: null,
      filename: link.filename,
      url: link.url,
      expiresAt: link.expiresAt.toISOString(),
    };
  }

  /**
   * The caller's own operations.
   *
   * No user parameter, and that is the design — Phase 13's shape for a personal list. An operation
   * record names what somebody selected, so a tenant-wide list of them is a list of what every
   * colleague has been working through. The tenant-wide reading is a report, and reports are
   * Phase 15's with their own permission.
   */
  @Get()
  @RequirePermission(Permission.DOCUMENT_VIEW)
  async list(
    @Query(new ZodValidationPipe(bulkOperationListQuerySchema))
    query: ReturnType<typeof bulkOperationListQuerySchema.parse>,
  ): Promise<Collection<BulkOperationView>> {
    const { userId } = requireContext();
    const page = await this.unitOfWork.run(() =>
      this.operations.listFor(asId<UserId>(userId ?? ''), query),
    );
    return { data: page.data.map(toView), meta: page.meta };
  }

  @Get(':id')
  @RequirePermission(Permission.DOCUMENT_VIEW)
  async get(@Param('id') id: string): Promise<BulkOperationView> {
    return toView(await this.requireOwnOperation(id));
  }

  /**
   * The operation, if it is the caller's own.
   *
   * Scoped to the requester rather than to the tenant, for the reason the list is: the item rows
   * name which documents somebody selected, and reading somebody else's would disclose that. It is
   * a `404` rather than a `403` — "you may not read this" and "it is not yours" are the same
   * answer, and the other one is a probe for which operation identifiers exist.
   */
  private async requireOwnOperation(id: string): Promise<BulkOperationRecord> {
    const { userId } = requireContext();
    const record = await this.unitOfWork.run(() => this.operations.findById(id));
    if (record === null || (record.requestedById as string) !== userId) {
      throw new NotFoundError('The requested bulk operation');
    }
    return record;
  }
}

function toResult(result: BulkResult, kind: BulkOperationResult['kind']): BulkOperationResult {
  return {
    operationId: result.operationId,
    kind,
    state: result.state,
    tally: result.tally,
    items: result.items.map((item) => ({
      targetId: item.targetId,
      outcome: item.outcome,
      errorCode: item.errorCode,
      detail: item.detail,
    })),
  };
}

function toView(record: BulkOperationRecord): BulkOperationView {
  return {
    id: record.id,
    kind: record.kind,
    state: record.state,
    requestedAt: record.requestedAt.toISOString(),
    startedAt: record.startedAt?.toISOString() ?? null,
    completedAt: record.completedAt?.toISOString() ?? null,
    tally: record.tally,
    fileObjectId: record.fileObjectId,
    sizeBytes: record.sizeBytes,
    sha256: record.sha256,
    error: record.error,
  };
}

/**
 * An identifier from the path, or the same 404 as an identifier that names nothing — so a
 * malformed one is neither a different answer nor a query the database has to reject.
 */
function identifier(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) {
    throw new NotFoundError('The requested bulk export');
  }
  return value.toLowerCase();
}
