import { Body, Controller, Inject, Param, Post, Query } from '@nestjs/common';

import {
  type CheckInDocumentBody,
  type CheckInManyBody,
  type CheckInManyReport,
  type Document,
  type ForceCheckInBody,
  type PublishDocumentBody,
  type RestoreRevisionBody,
  checkInDocumentSchema,
  checkInManySchema,
  forceCheckInSchema,
  publishDocumentSchema,
  restoreRevisionSchema,
} from '@edms/contracts';
import { Permission } from '@edms/domain';

import { RequirePermission } from '../../../core/authorization/permission.decorator';
import { ZodValidationPipe } from '../../../core/http/zod-validation.pipe';
import { RevisionControlService } from '../application/revision-control.service';
import { DOCUMENT_NUMBER_SERVICE } from '../application/ports';
import type { DocumentNumberService, DocumentRow } from '../application/ports';
import { toDocument } from './documents.controller';

/**
 * Check-out, check-in, publication and restore — the writes of revision control.
 *
 * Reads — the history, the compare — live in the Revision module's own controller, which owns
 * the record; the writes live here because every one of them moves the document's lifecycle,
 * takes its lock, or both, and those are Document's aggregate to move.
 *
 * Permissions are per operation, like the rest of the library: the four keys these routes
 * guard with have been in the catalogue since Phase 1, with matrix rows in
 * `08-permission-model.md` — nothing was added.
 */
@Controller({ path: 'documents', version: '1' })
export class RevisionControlController {
  constructor(
    private readonly control: RevisionControlService,
    @Inject(DOCUMENT_NUMBER_SERVICE) private readonly numbers: DocumentNumberService,
  ) {}

  /**
   * Takes the exclusive claim on producing the next revision. A second check-out gets a
   * refusal naming the holder — decided by `uq_document_lock_live`, not by politeness.
   */
  @Post(':id/checkout')
  @RequirePermission(Permission.DOCUMENT_CHECKOUT)
  async checkOut(@Param('id') id: string): Promise<Document> {
    return this.toResponse(await this.control.checkOut(id));
  }

  /**
   * Gives the claim back. The holder's own cancel; releasing somebody else's lock is the
   * force endpoint below, with a reason.
   */
  @Post(':id/checkout/cancel')
  @RequirePermission(Permission.DOCUMENT_CHECKOUT)
  async cancel(@Param('id') id: string): Promise<Document> {
    return this.toResponse(await this.control.cancelCheckOut(id));
  }

  /** Checks new content in: revision n+1, in DRAFT, beneath the still-effective published one. */
  @Post(':id/checkin')
  @RequirePermission(Permission.DOCUMENT_CHECKIN)
  async checkIn(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(checkInDocumentSchema)) body: CheckInDocumentBody,
  ): Promise<Document> {
    return this.toResponse(
      await this.control.checkIn({
        documentId: id,
        fileObjectId: body.fileObjectId,
        filename: body.filename,
        changeNote: body.changeNote,
        keepCheckedOut: body.keepCheckedOut,
      }),
    );
  }

  /**
   * Several documents checked in as one request — each item its own transaction, outcomes
   * reported per item. One file per document: a revision holds exactly one file (ADR-0003).
   */
  @Post('checkin')
  @RequirePermission(Permission.DOCUMENT_CHECKIN)
  async checkInMany(
    @Body(new ZodValidationPipe(checkInManySchema)) body: CheckInManyBody,
  ): Promise<CheckInManyReport> {
    const outcomes = await this.control.checkInMany(body.items);
    return {
      outcomes: outcomes.map((outcome) => ({
        documentId: outcome.documentId,
        ok: outcome.ok,
        ...(outcome.ok
          ? { revisionLabel: outcome.revisionLabel ?? null }
          : { reason: outcome.reason ?? 'The check-in failed.' }),
      })),
    };
  }

  /**
   * Releases somebody else's lock, with a reason, preserving their uploaded draft unless the
   * body says to discard it. Audited as `CHECKOUT_FORCED`, naming whom and why.
   */
  @Post(':id/force-checkin')
  @RequirePermission(Permission.DOCUMENT_FORCE_CHECKIN)
  async forceCheckIn(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(forceCheckInSchema)) body: ForceCheckInBody,
  ): Promise<Document> {
    return this.toResponse(
      await this.control.forceCheckIn(id, { note: body.note, discardDraft: body.discardDraft }),
    );
  }

  /**
   * Publishes the approved revision — and supersedes the prior one in the same transaction.
   * An approved, unnumbered document is refused with the sentence that says where to go.
   */
  @Post(':id/publish')
  @RequirePermission(Permission.DOCUMENT_PUBLISH)
  async publish(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(publishDocumentSchema)) body: PublishDocumentBody,
  ): Promise<Document> {
    return this.toResponse(
      await this.control.publish(id, {
        effectiveFrom: body.effectiveFrom,
        effectiveTo: body.effectiveTo,
      }),
    );
  }

  /**
   * Restores an older revision's content as the next draft revision. Restore never rewinds —
   * the old revision is untouched, the new one goes through approval like any other change.
   * Guarded by `document:checkout` because that is what it mechanically is: the check-out and
   * check-in that produce the next revision, in one step.
   */
  @Post(':id/revisions/:revisionId/restore')
  @RequirePermission(Permission.DOCUMENT_CHECKOUT)
  async restore(
    @Param('id') id: string,
    @Param('revisionId') revisionId: string,
    @Body(new ZodValidationPipe(restoreRevisionSchema)) body: RestoreRevisionBody,
  ): Promise<Document> {
    return this.toResponse(
      await this.control.restoreRevision(id, revisionId, { changeNote: body.changeNote }),
    );
  }

  /**
   * A short-lived, signed link to one revision's bytes — history as evidence. Both keys are
   * required: seeing that a revision existed is `document:history:view`; opening its content
   * is still a download.
   */
  @Post(':id/revisions/:revisionId/content')
  @RequirePermission(Permission.DOCUMENT_HISTORY_VIEW, Permission.DOCUMENT_DOWNLOAD)
  async revisionContent(
    @Param('id') id: string,
    @Param('revisionId') revisionId: string,
    @Query('inline') inline?: string,
  ): Promise<{ url: string; expiresAt: string }> {
    const signed = await this.control.revisionDownloadUrl(id, revisionId, inline === 'true');
    return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
  }

  /** The same wire shape every document write returns, pending number included. */
  private async toResponse(row: DocumentRow): Promise<Document> {
    const pendingNumber =
      row.documentNumber === null ? await this.numbers.pendingNumberFor(row.id) : null;
    return toDocument(row, pendingNumber);
  }
}
