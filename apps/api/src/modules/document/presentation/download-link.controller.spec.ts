import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { asId, type FileObjectId, type TenantId } from '@edms/domain';

import {
  ContentQuarantinedError,
  DownloadBusyError,
  ForbiddenError,
  NotFoundError,
} from '../../../core/errors/application-errors';
import type { Logger } from '../../../core/observability/logger';
import type { RequestContext } from '../../../core/tenancy/tenant-context';
import type {
  DownloadLinkGrant,
  StorageService,
  VerifiedDownload,
} from '../../storage/application/ports';
import type { DownloadRedemptionService } from '../application/download-redemption.service';
import { DownloadLinkController } from './download-link.controller';

/**
 * The door a verified download link opens — ADR-0026 §10 — over a real HTTP server, so headers,
 * streaming and a client that leaves behave as they will in production.
 *
 * Delivery and redemption are doubles here; their own suites test them against the real store and
 * database. What is under test is what the browser receives: the file with its headers once
 * verified, and otherwise a short page in its language with the status it can act on — never a
 * byte of the file.
 */

const GRANT: DownloadLinkGrant = {
  tenantId: '0199f5a1-5a9e-7000-8000-00000000a001',
  userId: '0199f5a1-5a9e-7000-8000-00000000b001',
  permissionVersion: 1,
  subject: {
    kind: 'DOCUMENT',
    documentId: '0199f5a1-5a9e-7000-8000-00000000d001',
    revisionId: null,
  },
  fileObjectId: '0199f5a1-5a9e-7000-8000-00000000f001',
  disposition: 'attachment',
  filename: 'تقرير الربع.pdf',
  mimeType: 'application/pdf',
  expiresAt: new Date('2030-01-01T00:00:00Z'),
};
const CONTENT = Buffer.from('%PDF-1.7\n% the verified bytes\n'.repeat(5_000));

let server: Server | null = null;

interface Behaviour {
  grant?: DownloadLinkGrant | null;
  redeem?: () => Promise<{ context: RequestContext; audit: Record<string, string> }>;
  deliver?: (send: (download: VerifiedDownload) => Promise<void>) => Promise<void>;
}

async function serve(behaviour: Behaviour = {}) {
  const served: { sizeBytes: number }[] = [];
  const controller = new DownloadLinkController(
    {
      decode: (token: string) => (token === 'good' ? (behaviour.grant ?? GRANT) : null),
      deliver: (_id: FileObjectId, send: (download: VerifiedDownload) => Promise<void>) =>
        behaviour.deliver?.(send) ??
        send({ sizeBytes: CONTENT.length, chunks: chunksOf(CONTENT), verifiedAfterMs: 5 }),
    },
    {
      recordDownloadServed: (_id: FileObjectId, details: { sizeBytes: number }) => {
        served.push(details);
        return Promise.resolve();
      },
    } as unknown as StorageService,
    {
      redeem: () =>
        behaviour.redeem?.() ??
        Promise.resolve({
          context: {
            tenantId: asId<TenantId>(GRANT.tenantId),
            userId: GRANT.userId,
          } as unknown as RequestContext,
          audit: {},
        }),
    } as unknown as DownloadRedemptionService,
    { warn: () => undefined, info: () => undefined, error: () => undefined } as unknown as Logger,
  );
  const app = express();
  app.get('/download', (request, response) => {
    void controller.download(request.query['token'] as string | undefined, request, response);
  });
  server = createServer(app);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}/download`, served };
}

async function* chunksOf(bytes: Buffer): AsyncIterable<Buffer> {
  for (let offset = 0; offset < bytes.length; offset += 16_384) {
    await Promise.resolve();
    yield bytes.subarray(offset, offset + 16_384);
  }
}

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (server === null) {
      resolve();
      return;
    }
    server.closeAllConnections();
    server.close(() => {
      resolve();
    });
  });
  server = null;
});

describe('a verified download link, followed by a browser', () => {
  it('serves an export with the media type its link names, and records what it was released as', async () => {
    const { url, served } = await serve({
      grant: {
        ...GRANT,
        subject: { kind: 'REPORT_EXPORT', exportId: '0199f5a1-5a9e-7000-8000-00000000c0e1' },
        filename: 'documents.csv',
        mimeType: 'text/csv; charset=utf-8',
      },
      redeem: () =>
        Promise.resolve({
          context: { tenantId: asId<TenantId>(GRANT.tenantId) } as unknown as RequestContext,
          audit: { reportExportId: '0199f5a1-5a9e-7000-8000-00000000c0e1' },
        }),
    });
    const response = await fetch(`${url}?token=good`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('content-disposition')).toContain('attachment;');
    await response.arrayBuffer();
    expect(served).toEqual([
      {
        sizeBytes: CONTENT.length,
        verifiedAfterMs: 5,
        audit: { reportExportId: '0199f5a1-5a9e-7000-8000-00000000c0e1' },
      },
    ]);
  });

  it('sends the verified bytes as an RFC 6266 attachment, private and never cached', async () => {
    const { url, served } = await serve();
    const response = await fetch(`${url}?token=good`);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(CONTENT)).toBe(true);
    expect(response.headers.get('content-length')).toBe(String(CONTENT.length));
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="download.pdf"; filename*=UTF-8''%D8%AA%D9%82%D8%B1%D9%8A%D8%B1%20%D8%A7%D9%84%D8%B1%D8%A8%D8%B9.pdf`,
    );
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain('sandbox');
    expect(served).toEqual([{ sizeBytes: CONTENT.length, verifiedAfterMs: 5, audit: {} }]);
  });

  it('serves inline only the types a browser cannot run, and an attachment for the rest', async () => {
    const inlinePdf = await serve({ grant: { ...GRANT, disposition: 'inline' } });
    const pdf = await fetch(`${inlinePdf.url}?token=good`);
    expect(pdf.headers.get('content-disposition')?.startsWith('inline;')).toBe(true);
    await pdf.arrayBuffer();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;

    const inlineHtml = await serve({
      grant: { ...GRANT, disposition: 'inline', mimeType: 'text/html', filename: 'x.html' },
    });
    const html = await fetch(`${inlineHtml.url}?token=good`);
    expect(html.headers.get('content-disposition')?.startsWith('attachment;')).toBe(true);
    expect(html.headers.get('content-type')).toBe('application/octet-stream');
    await html.arrayBuffer();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;

    // A type with parameters is judged on the type: never sent as something a browser would run.
    const withCharset = await serve({
      grant: { ...GRANT, mimeType: 'text/html; charset=utf-8', filename: 'x.html' },
    });
    const parametered = await fetch(`${withCharset.url}?token=good`);
    expect(parametered.headers.get('content-type')).toBe('application/octet-stream');
    await parametered.arrayBuffer();
  });

  it.each([
    ['a forged, edited or expired link', 'bad', {}, 404, 'This download link has expired'],
    [
      'a link the person may no longer use',
      'good',
      { redeem: () => Promise.reject(new NotFoundError('The requested file')) },
      404,
      'This download link has expired',
    ],
    [
      'a confidentiality level that forbids download',
      'good',
      { redeem: () => Promise.reject(new ForbiddenError('download this document')) },
      403,
      'You do not have permission',
    ],
    [
      'a file that did not verify',
      'good',
      { deliver: () => Promise.reject(new ContentQuarantinedError('MISMATCH')) },
      409,
      'This file failed its integrity check',
    ],
  ] as const)(
    'answers %s with a short page and no file bytes',
    async (_case, token, behaviour, status, text) => {
      const { url, served } = await serve(behaviour);
      const response = await fetch(`${url}?token=${token}`);
      expect(response.status).toBe(status);
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(response.headers.get('content-disposition')).toBeNull();
      const body = await response.text();
      expect(body).toContain(text);
      expect(body).not.toContain('the verified bytes');
      expect(served).toEqual([]);
    },
  );

  it('answers busy with 503 and Retry-After, in the person’s language', async () => {
    const { url } = await serve({ deliver: () => Promise.reject(new DownloadBusyError()) });
    const response = await fetch(`${url}?token=good`, { headers: { 'accept-language': 'ar' } });
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('30');
    const body = await response.text();
    expect(body).toContain('dir="rtl"');
    expect(body).toContain('التنزيلات مشغولة');
  });

  it('answers in the interface’s language (the edms_locale cookie) before the browser’s', async () => {
    const { url } = await serve();
    const response = await fetch(`${url}?token=bad`, {
      headers: { 'accept-language': 'en', cookie: 'edms_tenant=acme; edms_locale=ar' },
    });
    expect(await response.text()).toContain('dir="rtl"');
  });

  it('records nothing as served when the person leaves part-way', async () => {
    let release: () => void = () => {};
    const sending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { url, served } = await serve({
      deliver: async (send) => {
        const big = Buffer.alloc(64 * 1024 * 1024, 0x61);
        await send({ sizeBytes: big.length, chunks: chunksOf(big), verifiedAfterMs: 1 });
        release();
      },
    });
    const abort = new AbortController();
    const response = await fetch(`${url}?token=good`, { signal: abort.signal });
    const reader = response.body?.getReader();
    await reader?.read();
    abort.abort();
    await sending;
    expect(served).toEqual([]);
  });
});
