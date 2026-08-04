import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

import {
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { APP_CONFIG, type AppConfig } from '../../core/config';
import { Public } from '../../core/auth/public.decorator';
import { ForbiddenError, NotFoundError } from '../../core/errors/application-errors';
import { CLOCK_PORT, type ClockPort } from '../../ports/clock.port';
import type { LocalStorageAdapter } from './local.adapter';
import { LOCAL_STORAGE_ADAPTER } from './storage.tokens';
import { LOCAL_TRANSFER_PATH, decodeTransferToken } from './local-transfer-token';

/**
 * The two endpoints that make the `LOCAL` driver a storage driver.
 *
 * They exist only because a filesystem has nothing in front of it that understands a presigned URL.
 * An object store verifies its own signatures, so with `STORAGE_DRIVER=S3` nothing here is ever
 * reached — and it is registered regardless rather than conditionally, because a route that appears
 * and disappears with configuration is a route whose authorisation is tested in one deployment
 * shape and not the other. With any other driver the adapter is absent and both endpoints answer
 * "not found", which is the truth.
 *
 * **They are `@Public`, and that is the design rather than a gap.** A presigned URL is redeemed
 * without a bearer token — that is what lets a browser put it in an `<img>` tag or hand it to its
 * own download manager. The token in the query *is* the credential: it names one object, one
 * method and one expiry, it is signed with the deployment's own key, and it grants nothing else.
 * Running the ordinary guards here would not add a check; it would break the only mechanism a
 * filesystem deployment has.
 *
 * Nothing else in the product may be written this way. The reason this is acceptable is that the
 * capability is *narrower* than a session rather than a substitute for one, and it is the same
 * bargain an object store makes with its own presigned URLs.
 */
@Controller({ path: LOCAL_TRANSFER_PATH, version: '1' })
export class LocalTransferController {
  constructor(
    @Inject(LOCAL_STORAGE_ADAPTER) private readonly storage: LocalStorageAdapter | null,
    @Inject(CLOCK_PORT) private readonly clock: ClockPort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Receives the bytes of one upload.
   *
   * Written to a `.partial` name and renamed into place at the end, so an interrupted transfer
   * leaves something the sweeper removes rather than a short file that reads as a complete one. For
   * content-addressed storage the second is worse than useless: it is a blob whose bytes do not
   * match the digest that names it, and every later integrity check would report it as tampering.
   */
  @Put()
  @Public(
    'A presigned upload target is redeemed without a session; the signed token is the credential.',
  )
  @HttpCode(HttpStatus.OK)
  async upload(@Query('token') token: string, @Req() request: Request): Promise<void> {
    const adapter = this.require();
    const grant = this.grantFor(token, 'PUT');

    // The size the target was signed for. Enforced while streaming rather than from
    // `Content-Length`, which is a claim the client makes and can simply be wrong about.
    const limit = grant.maxBytes ?? this.config.storage.maxUploadBytes;
    await adapter.beginWrite(grant.key);
    let written = 0;
    try {
      await pipeline(
        request,
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            written += chunk.length;
            if (written > limit) {
              throw new ForbiddenError('send more bytes than this upload target allows');
            }
            yield chunk;
          }
        },
        createWriteStream(adapter.partialPathFor(grant.key)),
      );
      await adapter.finishWrite(grant.key);
    } catch (error) {
      await adapter.abandonWrite(grant.key);
      throw error;
    }
  }

  /**
   * Serves the bytes of one object.
   *
   * The disposition comes from the signed grant rather than from the query, so a download URL
   * cannot be turned into an inline one by editing it — which is what would let a stored SVG or
   * HTML document run in the product's own origin.
   */
  @Get()
  @Public(
    'A presigned download URL is redeemed without a session; the signed token is the credential.',
  )
  @Header('X-Content-Type-Options', 'nosniff')
  async download(
    @Query('token') token: string,
    @Res({ passthrough: false }) response: Response,
  ): Promise<void> {
    const adapter = this.require();
    const grant = this.grantFor(token, 'GET');
    const path = adapter.pathFor(grant.key);

    const metadata = await adapter.head(grant.key);
    if (metadata === null) {
      throw new NotFoundError('The requested file');
    }
    // Always `application/octet-stream`, never the document's own type. The bytes are served from
    // the API's origin, so a stored HTML or SVG document rendered as itself would execute there —
    // and a signed-in user's session is what it would execute against. A preview that needs to be
    // displayed is a rendered artefact, which is Phase 7's, not the original file.
    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('Content-Length', String(metadata.sizeBytes));
    response.setHeader('Content-Disposition', grant.disposition ?? 'attachment');
    // Private and short: the URL expires, and a shared cache holding the answer after it does
    // would be serving a document to whoever asked next.
    response.setHeader('Cache-Control', 'private, no-store');

    await pipeline(createReadStream(path), response);
  }

  private require(): LocalStorageAdapter {
    if (this.storage === null) {
      // The route exists in every deployment; the driver does not. Answering "not found" is the
      // honest response to asking a deployment with an object store for its filesystem endpoint.
      throw new NotFoundError('The requested resource');
    }
    return this.storage;
  }

  private grantFor(token: string, method: 'PUT' | 'GET') {
    const decoded = decodeTransferToken(
      this.config.auth.accessSecret,
      token ?? '',
      method,
      this.clock.now(),
    );
    if ('rejection' in decoded) {
      // One answer for every rejection. Distinguishing "expired" from "bad signature" tells
      // somebody probing the endpoint which half of a forged token to keep working on.
      throw new ForbiddenError('use this transfer link');
    }
    return decoded.grant;
  }
}
