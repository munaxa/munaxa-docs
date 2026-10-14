import { once } from 'node:events';

import { Controller, Get, Inject, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { ErrorCode, type FileObjectId, asId, isDomainError } from '@edms/domain';
import { isLocale, type MessageKey, negotiateLocale, translate } from '@edms/i18n';
import { contentDisposition } from '@edms/utils';

import { Public } from '../../../core/auth/public.decorator';
import { STATUS_BY_CODE } from '../../../core/errors/all-exceptions.filter';
import { correlationIdOf } from '../../../core/http/correlation-id.middleware';
import { LOGGER, type Logger } from '../../../core/observability/logger';
import { runWithContext } from '../../../core/tenancy/tenant-context';
import {
  DOWNLOAD_LINK_PATH,
  STORAGE_SERVICE,
  type StorageService,
  VERIFIED_DOWNLOAD_DELIVERY,
  type VerifiedDownload,
  type VerifiedDownloadDelivery,
} from '../../storage/application/ports';
import { DownloadRedemptionService } from '../application/download-redemption.service';

/**
 * Where a verified download link is redeemed — ADR-0026 §10, the download-integrity proposal §3.
 *
 * `@Public` for the preview stream's reason: the browser follows the link by navigation, which
 * carries no bearer token, so the signed token in the query is what arrives. It authorizes
 * nothing by itself — `DownloadRedemptionService` asks every question the guards and the use case
 * would ask, of the person the link names, now.
 *
 * Then `VerifiedDownloadDelivery` reads the object whole into an encrypted staging file, hashing it,
 * and calls back only when the size and the SHA-256 both equal the record. **Until that callback
 * runs, no header that announces content and no byte of the file has been written** — so a file
 * that does not verify reaches the browser as a short error page and nothing else.
 *
 * A refusal is a small page in the person's language rather than JSON: this is a navigation, and
 * whatever answers it is what the tab shows. It carries the status a client can act on, and
 * `Retry-After` when trying again is the remedy.
 */
@Controller({ path: DOWNLOAD_LINK_PATH, version: '1' })
export class DownloadLinkController {
  constructor(
    @Inject(VERIFIED_DOWNLOAD_DELIVERY) private readonly delivery: VerifiedDownloadDelivery,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly redemption: DownloadRedemptionService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  @Get()
  @Public(
    'A download link is followed by navigation, without a session header; the signed token is ' +
      'checked, and the person it names is re-authorized from the database, on every use.',
  )
  async download(
    @Query('token') token: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    // Never cached anywhere, never handed on as a referrer: the URL carries the token.
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const locale = localeOf(request);

    const grant = this.delivery.decode(token ?? '');
    if (grant === null) {
      refusalPage(response, locale, 404, 'errorReason.DOWNLOAD_LINK_INVALID');
      return;
    }

    const abort = new AbortController();
    response.on('close', () => {
      if (!response.writableFinished) {
        abort.abort();
      }
    });

    const fileObjectId = asId<FileObjectId>(grant.fileObjectId);
    try {
      const context = await this.redemption.redeem(grant, correlationIdOf(request));
      await runWithContext(context, () =>
        this.delivery.deliver(
          fileObjectId,
          async (verified) => {
            const served = await this.send(response, grant, verified, abort.signal);
            if (served) {
              await this.storage.recordDownloadServed(fileObjectId, {
                sizeBytes: verified.sizeBytes,
                verifiedAfterMs: verified.verifiedAfterMs,
              });
            }
          },
          abort.signal,
        ),
      );
    } catch (error) {
      this.answerFailure(response, locale, error, grant.fileObjectId, abort.signal.aborted);
    }
  }

  /** Verified bytes to the connection, honouring backpressure. True when every byte was flushed. */
  private async send(
    response: Response,
    grant: {
      readonly disposition: 'inline' | 'attachment';
      readonly filename: string;
      readonly mimeType: string;
    },
    verified: VerifiedDownload,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (signal.aborted) {
      return false;
    }
    const inline = grant.disposition === 'inline' && INLINE_SAFE.has(grant.mimeType);
    response.status(200);
    response.setHeader('Content-Type', inline ? grant.mimeType : contentTypeFor(grant.mimeType));
    response.setHeader('Content-Length', String(verified.sizeBytes));
    response.setHeader(
      'Content-Disposition',
      contentDisposition(inline ? 'inline' : 'attachment', grant.filename),
    );
    // Served from the application's own origin now, so whatever is opened inline is sandboxed: no
    // script, no same-origin access, whatever the file claims to be.
    response.setHeader(
      'Content-Security-Policy',
      "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
    );
    for await (const chunk of verified.chunks) {
      if (signal.aborted) {
        return false;
      }
      if (!response.write(chunk)) {
        await Promise.race([once(response, 'drain'), once(response, 'close')]);
      }
    }
    response.end();
    if (!response.writableFinished) {
      await Promise.race([once(response, 'finish'), once(response, 'close')]);
    }
    return response.writableFinished;
  }

  private answerFailure(
    response: Response,
    locale: ReturnType<typeof negotiateLocale>,
    error: unknown,
    fileObjectId: string,
    clientGone: boolean,
  ): void {
    if (response.headersSent) {
      // Only after verification can headers have been sent. What failed is the connection or the
      // staging file's own authentication; the length promised is not met, so the client discards
      // what it has. Logged, never retried here.
      this.logger.warn('A verified download ended before every byte was sent', {
        fileObjectId,
        clientGone,
        error: error instanceof Error ? error.message : 'unknown',
      });
      response.destroy();
      return;
    }
    if (clientGone) {
      this.logger.info('A download was abandoned before it was verified', { fileObjectId });
      response.destroy();
      return;
    }
    if (isDomainError(error)) {
      const status = STATUS_BY_CODE[error.code];
      const key: MessageKey =
        error.code === ErrorCode.NOT_FOUND
          ? 'errorReason.DOWNLOAD_LINK_INVALID'
          : error.publicReason === null
            ? (`error.${error.code}` as MessageKey)
            : (`errorReason.${error.publicReason.reason}` as MessageKey);
      if (status >= 500) {
        response.setHeader('Retry-After', '30');
      }
      refusalPage(response, locale, status, key, error.publicReason?.values ?? {});
      return;
    }
    this.logger.error('A verified download failed', {
      fileObjectId,
      error: error instanceof Error ? error.stack : String(error),
    });
    refusalPage(response, locale, 500, 'error.INTERNAL');
  }
}

/**
 * The interface's language: the web app keeps it in the `edms_locale` cookie, which a same-origin
 * navigation to this door carries; the browser's own Accept-Language otherwise.
 */
function localeOf(request: Request): ReturnType<typeof negotiateLocale> {
  const cookie = /(?:^|;\s*)edms_locale=([^;]*)/u.exec(request.headers.cookie ?? '')?.[1];
  return cookie !== undefined && isLocale(cookie)
    ? cookie
    : negotiateLocale(request.headers['accept-language']);
}

/** Types a browser may render in place. Anything else is always an attachment. */
const INLINE_SAFE = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
]);

/** An attachment's type: as recorded, unless it is one a browser would run. */
function contentTypeFor(mimeType: string): string {
  return /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml)$/iu.test(
    mimeType,
  )
    ? 'application/octet-stream'
    : mimeType;
}

function refusalPage(
  response: Response,
  locale: ReturnType<typeof negotiateLocale>,
  status: number,
  key: MessageKey,
  values: Readonly<Record<string, string | number>> = {},
): void {
  const message = escapeHtml(translate(locale, key, values));
  const direction = locale === 'ar' ? 'rtl' : 'ltr';
  response
    .status(status)
    .setHeader('Content-Type', 'text/html; charset=utf-8')
    .setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
    .end(
      `<!doctype html><html lang="${locale}" dir="${direction}"><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${message}</title>` +
        '<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem}</style>' +
        `</head><body><p>${message}</p></body></html>`,
    );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}
