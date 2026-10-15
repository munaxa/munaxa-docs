import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Nothing in the API signs a store URL for reading — ADR-0026 §10, the export design §10 step 7,
 * and R-9 of the Hetzner readiness report.
 *
 * Every download a person receives is a verified link the API serves (`/api/v1/downloads`), read
 * whole and matched against its digest first. The preview pipeline's own reads used to be the one
 * remaining signer: rendering, thumbnails and OCR fetched their source through a signed URL and
 * checked nothing, and the preview stream and text reads did the same for artefacts. They now read
 * on the port (`readVerifiedSource`, or `read` plus a digest check). Only the port's implementations
 * may still implement `createDownloadUrl`; this fails the build when any other file starts calling
 * it — an export, a document route, a fallback in an error handler — so the unverified door cannot
 * quietly come back.
 */

const SOURCE = join(__dirname, '..', '..', '..');

/** Callers of the raw port's `createDownloadUrl`: only the tenant-scoping adapter that wraps it. */
const PORT_SIGNERS = ['infrastructure/tenancy/tenant-scoped-storage.ts'];

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      return entry === '__tests__' || entry === 'testing' ? [] : sources(path);
    }
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

function callersOf(pattern: RegExp): string[] {
  return sources(SOURCE)
    .filter((path) => pattern.test(readFileSync(path, 'utf8')))
    .map((path) => relative(SOURCE, path).split('\\').join('/'))
    .sort();
}

describe('who may sign a store URL', () => {
  it('the internal signed-URL method is gone', () => {
    expect(callersOf(/createInternalReadUrl/u)).toEqual([]);
  });

  it('only the tenant-scoping adapter calls the raw port’s signer', () => {
    expect(callersOf(/\.createDownloadUrl\(/u)).toEqual(PORT_SIGNERS);
  });

  it('the preview pipeline reads its sources through the verified read', () => {
    expect(callersOf(/\.readVerifiedSource\(/u)).toEqual([
      'modules/preview/application/ocr.service.ts',
      'modules/preview/application/render.service.ts',
      'modules/preview/application/thumbnail.service.ts',
    ]);
  });
});
