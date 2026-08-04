import { Controller, Get, Header, Inject, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import { type FileObjectId, type TenantId, asId } from '@edms/domain';

import { APP_CONFIG, type AppConfig } from '../../../core/config';
import { Public } from '../../../core/auth/public.decorator';
import { LOGGER, type Logger } from '../../../core/observability/logger';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../core/prisma/unit-of-work';
import { runWithContext } from '../../../core/tenancy/tenant-context';
import { CLOCK_PORT, type ClockPort } from '../../../ports/clock.port';
import { STORAGE_PORT, type StoragePort } from '../../../ports/storage.port';
import { STORAGE_SERVICE, type StorageService } from '../../storage/application/ports';
import {
  PREVIEW_STREAM_PATH,
  type PreviewStreamGrant,
  decodePreviewToken,
} from '../domain/preview-stream-token';
import { stampWatermark } from '../infrastructure/watermark';

/**
 * Where a preview URL is redeemed — the one endpoint that puts artefact bytes on the wire.
 *
 * `@Public`, exactly like the `LOCAL` storage transfer endpoint and under the same bargain: a
 * preview URL is redeemed by an `<img>` tag, a viewer's fetch or the browser's print frame,
 * none of which carry a bearer token, so the token in the query is the credential. It names
 * one artefact, one disposition, one expiry — nothing to walk, nothing to widen — and it was
 * issued by an endpoint that checked permission, state and confidentiality in that order.
 *
 * This is also where a watermark is burned in. The mark has to be inside the bytes — a mark
 * the client composites is a mark a client omits — and it names the viewer, so the stamped
 * rendition is minted per request rather than cached: the deliberate trade recorded in
 * `watermark.ts`.
 *
 * Every refusal is 404 with nothing in the body. A token holder is not a session; the
 * difference between "expired", "forged" and "never existed" is nobody's business at this
 * door, though each is logged for the operator.
 */
@Controller({ path: PREVIEW_STREAM_PATH, version: '1' })
export class PreviewStreamController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK_PORT) private readonly clock: ClockPort,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    @Inject(STORAGE_PORT) private readonly storagePort: StoragePort,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  @Get()
  @Public(
    'A preview URL is redeemed without a session; the signed token in the query is the ' +
      'credential, scoped to one artefact and one expiry.',
  )
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Cache-Control', 'private, no-store')
  async stream(
    @Query('token') token: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const decoded = decodePreviewToken(
      this.config.auth.accessSecret,
      token ?? '',
      this.clock.now(),
    );
    if ('rejection' in decoded) {
      this.logger.warn('A preview token was refused', { rejection: decoded.rejection });
      response.status(404).end();
      return;
    }
    const grant = decoded.grant;

    let bytes: Buffer | null;
    try {
      bytes = await runWithContext(
        {
          tenantId: asId<TenantId>(grant.tenantId),
          userId: null,
          roles: [],
          permissions: [],
          sessionId: null,
          correlationId: `preview-stream:${grant.fileObjectId}`,
          permissionVersion: 0,
          locale: 'en',
        },
        () => this.fetchArtifact(grant),
      );
    } catch (error) {
      this.logger.error('A preview stream failed', {
        fileObjectId: grant.fileObjectId,
        reason: error instanceof Error ? error.message : 'unknown',
      });
      response.status(404).end();
      return;
    }
    if (bytes === null) {
      response.status(404).end();
      return;
    }

    if (grant.watermark !== null && grant.mimeType === 'application/pdf') {
      bytes = await stampWatermark(bytes, grant.watermark);
    }

    response.setHeader('Content-Type', grant.mimeType);
    response.setHeader('Content-Length', String(bytes.length));
    response.setHeader(
      'Content-Disposition',
      grant.disposition === 'inline' ? 'inline' : 'attachment; filename="preview"',
    );
    response.status(200).end(bytes);
  }

  /** The artefact's bytes, through the same presigned path every other read takes. */
  private async fetchArtifact(grant: PreviewStreamGrant): Promise<Buffer | null> {
    const file = await this.uow.run(() => this.storage.get(asId<FileObjectId>(grant.fileObjectId)));
    // Only derived artefacts and clean sources are streamable: a grant is minted against an
    // artefact row, but the check is repeated here because this door is public.
    if (file === null || (!file.derived && file.scanStatus !== 'CLEAN')) {
      return null;
    }
    const signed = await this.storagePort.createDownloadUrl(file.storageKey, {
      expiresInSeconds: 60,
      inline: true,
    });
    const fetched = await fetch(signed.url);
    if (!fetched.ok) {
      return null;
    }
    return Buffer.from(await fetched.arrayBuffer());
  }
}
