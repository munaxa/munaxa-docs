import { Inject, Injectable } from '@nestjs/common';

import { type FileObjectId, PreviewArtifactKind, asId, formatFor } from '@edms/domain';

import { LOGGER, type Logger } from '../../../core/observability/logger';
import { RecordStamps } from '../../../core/persistence';
import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import type { DocumentThumbnailer } from '../../document/application/thumbnail.port';
import { STORAGE_SERVICE, type StorageService } from '../../storage/application/ports';
import { decodePng, encodePng } from '../domain/png';
import { downscale, thumbnailSizeFor } from '../domain/thumbnail';

/**
 * The upload-time thumbnail — Phase 3's entire share of preview.
 *
 * Page images, PDF renditions, extracted text and the viewer that shows them are Phase 7's. What
 * this does is draw one small picture when content arrives, for the formats where a thumbnail is a
 * size change rather than a rendering job, and record it as a `PreviewArtifact` so Phase 7 inherits
 * the table rather than a migration.
 *
 * **It never fails a document.** Every failure path here ends in a logged warning and a document
 * with no thumbnail, because that is what a thumbnail is worth: a decoration that makes a grid
 * legible. A create rolled back over one would lose a document somebody uploaded in order to
 * protect a picture — and the absence of a thumbnail is an ordinary state every client already
 * renders, since a Word document has never had one.
 *
 * The bytes pass through this process, which is the one place in the phase that happens. It is
 * unavoidable and it is bounded: there is no client to presign a target for something the server
 * draws, and the decoder refuses anything above a pixel ceiling before it allocates.
 */
@Injectable()
export class ThumbnailService implements DocumentThumbnailer {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly stamps: RecordStamps,
  ) {}

  async generate(revisionId: string, fileObjectId: string, mimeType: string): Promise<void> {
    if (!this.canRender(mimeType)) {
      // Not a failure. A Word document has no thumbnail in Phase 3 and the library shows its
      // format's icon, which is what it would show for a failed render anyway.
      return;
    }

    try {
      const source = await this.fetch(fileObjectId);
      if (source === null) {
        return;
      }
      const decoded = decodePng(source);
      if (decoded === null) {
        // The decoder declined: interlaced, palette-based, 16-bit, corrupt, or larger than the
        // pixel ceiling. All of them are the same answer to the caller.
        return;
      }

      const thumbnail = encodePng(
        downscale(decoded, thumbnailSizeFor(decoded.width, decoded.height)),
      );
      const stored = await this.storage.storeDerived({
        content: thumbnail,
        mimeType: 'image/png',
      });

      await requireTransaction().previewArtifact.create({
        data: {
          id: this.stamps.nextId(),
          tenantId: requireContext().tenantId,
          revisionId,
          kind: PreviewArtifactKind.THUMBNAIL,
          // Null: a thumbnail is not per page. Phase 7's page images are what the column is for.
          page: null,
          fileObjectId: stored.id,
          renderer: RENDERER,
          rendererVersion: RENDERER_VERSION,
          ...this.stamps.creation(),
        },
      });
    } catch (error) {
      // Swallowed, and logged with enough to find it. The alternative — letting it propagate — is
      // a document lost to a decoration, inside a transaction that had already stored the bytes.
      this.logger.warn('No thumbnail was produced for this revision.', {
        revisionId,
        fileObjectId,
        mimeType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Whether Phase 3 can draw a thumbnail for this format at all.
   *
   * PNG only, and the narrowness is deliberate rather than incidental — see `thumbnail.ts` for why
   * the encoder is written out instead of pulled in. Every other raster format waits for Phase 7's
   * renderer registry, which is the right place for a decoder per format.
   */
  private canRender(mimeType: string): boolean {
    return formatFor(mimeType)?.mimeType === 'image/png';
  }

  /**
   * The source bytes, through a signed URL the API redeems itself.
   *
   * The same path a browser takes rather than a second, privileged one. A direct read would mean a
   * code path per driver that only the thumbnailer exercises, and a code path only one caller
   * exercises is the one that breaks silently when a driver is added.
   */
  private async fetch(fileObjectId: string): Promise<Buffer | null> {
    const signed = await this.storage.createDownloadUrl(
      asId<FileObjectId>(fileObjectId),
      'source.png',
      { inline: true },
    );
    const response = await fetch(signed.url);
    if (!response.ok) {
      return null;
    }
    return Buffer.from(await response.arrayBuffer());
  }
}

/** Recorded per artefact, so a renderer upgrade can invalidate what the old version produced. */
const RENDERER = 'munaxa-raster';
const RENDERER_VERSION = '1.0.0';
