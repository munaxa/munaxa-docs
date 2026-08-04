import { Controller, Get, HttpStatus, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';

import { Permission } from '@edms/domain';
import type { PreviewContent, PreviewManifest, PreviewText } from '@edms/contracts';

import { RequirePermission } from '../../../core/authorization/permission.decorator';
import { DocumentPreviewService } from '../application/document-preview.service';

/**
 * The preview surface — 14 §4, as routes.
 *
 * Reads are `GET` and issue nothing; the content endpoints are `POST` because issuing a link is
 * an audited act, the same reasoning as the download endpoint beside them. A content request
 * whose artefacts are still rendering answers **202** with the same body shape and no URL — the
 * codebase's first 202, and the contract 14 §4 sketched: not an error, not an answer, ask again.
 *
 * Permission → state → confidentiality, in that order and in different places: the decorator
 * holds the permission (`document:view` — deliberately *not* `document:download`; preview is
 * what "readable, not downloadable" means), the use case resolves the effective revision, and
 * the confidentiality level subtracts last. The revision-addressed routes add
 * `document:history:view`, because a draft's pages are history the same way its bytes are.
 */
@Controller({ path: 'documents', version: '1' })
export class DocumentPreviewController {
  constructor(private readonly previews: DocumentPreviewService) {}

  @Get(':id/preview')
  @RequirePermission(Permission.DOCUMENT_VIEW)
  manifest(@Param('id') id: string): Promise<PreviewManifest> {
    return this.previews.manifest(id);
  }

  @Get(':id/revisions/:revisionId/preview')
  @RequirePermission(Permission.DOCUMENT_VIEW, Permission.DOCUMENT_HISTORY_VIEW)
  revisionManifest(
    @Param('id') id: string,
    @Param('revisionId') revisionId: string,
  ): Promise<PreviewManifest> {
    return this.previews.revisionManifest(id, revisionId);
  }

  /** The viewing artefact's URL — 200 when ready, 202 with status while the queue works. */
  @Post(':id/preview/content')
  @RequirePermission(Permission.DOCUMENT_VIEW)
  async content(@Param('id') id: string, @Res() response: Response): Promise<void> {
    respond(response, await this.previews.viewContent(id));
  }

  @Post(':id/revisions/:revisionId/preview/content')
  @RequirePermission(Permission.DOCUMENT_VIEW, Permission.DOCUMENT_HISTORY_VIEW)
  async revisionContent(
    @Param('id') id: string,
    @Param('revisionId') revisionId: string,
    @Res() response: Response,
  ): Promise<void> {
    respond(response, await this.previews.viewContent(id, revisionId));
  }

  /**
   * A print, through the preview path and never the original (14 §4) — which is what keeps the
   * watermark on the paper and the act in the audit trail.
   */
  @Post(':id/preview/print')
  @RequirePermission(Permission.DOCUMENT_VIEW, Permission.DOCUMENT_PRINT)
  async print(@Param('id') id: string, @Res() response: Response): Promise<void> {
    respond(response, await this.previews.printContent(id));
  }

  /** The extracted text: the viewer's text pane, its in-document search, and nothing more. */
  @Get(':id/preview/text')
  @RequirePermission(Permission.DOCUMENT_VIEW)
  text(@Param('id') id: string): Promise<PreviewText | null> {
    return this.previews.text(id);
  }

  @Get(':id/revisions/:revisionId/preview/text')
  @RequirePermission(Permission.DOCUMENT_VIEW, Permission.DOCUMENT_HISTORY_VIEW)
  revisionText(
    @Param('id') id: string,
    @Param('revisionId') revisionId: string,
  ): Promise<PreviewText | null> {
    return this.previews.text(id, revisionId);
  }
}

/** One body shape, two statuses: 202 says "rendering", everything else is an answer. */
function respond(response: Response, content: PreviewContent): void {
  response.status(content.state === 'PENDING' ? HttpStatus.ACCEPTED : HttpStatus.OK).json(content);
}
