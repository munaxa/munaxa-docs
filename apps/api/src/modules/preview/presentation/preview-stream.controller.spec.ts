import { createHash } from 'node:crypto';

import type { Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../../../core/config';
import type { Logger } from '../../../core/observability/logger';
import type { ClockPort } from '../../../ports/clock.port';
import type { StoragePort } from '../../../ports/storage.port';
import type { StorageService } from '../../storage/application/ports';
import { encodePreviewToken } from '../domain/preview-stream-token';
import { PreviewStreamController } from './preview-stream.controller';

/**
 * The preview stream serves only the bytes that were recorded — ADR-0026 §10, Phase A.
 *
 * The artefact passes through the process whole (it may be watermarked), so its digest is checked
 * against the row before a byte is sent: an object rewritten in the store is a 404, never the
 * other bytes.
 */

const SECRET = 'a-preview-stream-test-secret-of-32-chars';
const NOW = new Date('2026-10-14T12:00:00Z');
const recorded = Buffer.from('%PDF-1.7\n% the rendition that was recorded\n');

function controllerServing(served: Buffer, errors: string[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(new Uint8Array(served), { status: 200 }))),
  );
  const file = {
    id: 'file-1',
    storageKey: 'derived/ab/cd/artefact',
    checksumSha256: createHash('sha256').update(recorded).digest('hex'),
  };
  return new PreviewStreamController(
    { auth: { accessSecret: SECRET } } as unknown as AppConfig,
    { now: () => NOW } as unknown as ClockPort,
    { run: <T>(work: () => Promise<T>) => work() },
    {
      isReachable: () => Promise.resolve(true),
      get: () => Promise.resolve(file),
    } as unknown as StorageService,
    {
      createDownloadUrl: () =>
        Promise.resolve({ url: 'https://store.test/artefact', expiresAt: NOW }),
    } as unknown as StoragePort,
    {
      error: (message: string) => errors.push(message),
      warn: () => undefined,
      info: () => undefined,
    } as unknown as Logger,
  );
}

function capture() {
  const sent = { status: 0, body: null as Buffer | null };
  const response = {
    status(code: number) {
      sent.status = code;
      return response;
    },
    setHeader: () => response,
    end(body?: Buffer) {
      sent.body = body ?? null;
      return response;
    },
  };
  return { sent, response: response as unknown as Response };
}

const token = encodePreviewToken(SECRET, {
  fileObjectId: '0199f5a1-5a9e-7000-8000-000000000001',
  tenantId: '0199f5a1-5a9e-7000-8000-00000000a001',
  mimeType: 'application/pdf',
  disposition: 'inline',
  expiresAt: new Date(NOW.getTime() + 60_000),
  watermark: null,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the preview stream', () => {
  it('serves the artefact when its bytes are the recorded ones', async () => {
    const errors: string[] = [];
    const { sent, response } = capture();
    await controllerServing(recorded, errors).stream(token, response);
    expect(sent.status).toBe(200);
    expect(sent.body?.equals(recorded)).toBe(true);
    expect(errors).toEqual([]);
  });

  it('answers 404, and logs it, when the stored bytes are not the recorded ones', async () => {
    const errors: string[] = [];
    const { sent, response } = capture();
    await controllerServing(Buffer.from('%PDF-1.7\n% something else\n'), errors).stream(
      token,
      response,
    );
    expect(sent.status).toBe(404);
    expect(sent.body).toBeNull();
    expect(errors).toEqual(['A preview artefact did not match its recorded digest; not served']);
  });
});
