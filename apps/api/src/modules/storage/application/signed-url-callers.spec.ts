import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * No person receives a store-signed URL — ADR-0026 §10, the export design §10 step 7.
 *
 * Every download a person receives is a verified link the API serves (`/api/v1/downloads`), read
 * whole and matched against its digest first. Store-signed URLs remain only for the API's own
 * reads: the preview pipeline fetching a source to render, rasterise or OCR, and the preview
 * stream reading an artefact it then serves itself. This fails the build when any other file
 * starts signing — an export, a document route, a fallback in an error handler — so the
 * unverified door cannot quietly come back.
 */

const SOURCE = join(__dirname, '..', '..', '..');

/** Callers of `StorageService.createInternalReadUrl`: the pipeline's own source reads. */
const INTERNAL_READERS = [
  'modules/preview/application/ocr.service.ts',
  'modules/preview/application/render.service.ts',
  'modules/preview/application/thumbnail.service.ts',
];

/** Callers of the raw port's `createDownloadUrl`: its implementation, adapters and API reads. */
const PORT_SIGNERS = [
  'infrastructure/tenancy/tenant-scoped-storage.ts',
  'modules/preview/application/preview-query.service.ts',
  'modules/preview/presentation/preview-stream.controller.ts',
  'modules/storage/application/storage.service.ts',
];

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
  it('only the preview pipeline reads through the internal signed URL', () => {
    expect(callersOf(/\.createInternalReadUrl\(/u)).toEqual(INTERNAL_READERS);
  });

  it('only storage, its adapters and the preview pipeline sign on the raw port', () => {
    expect(callersOf(/\.createDownloadUrl\(/u)).toEqual(PORT_SIGNERS);
  });

  it('no export or document module signs anything', () => {
    for (const module of ['reporting', 'audit', 'document']) {
      expect(
        callersOf(/\.(createDownloadUrl|createInternalReadUrl)\(/u).filter((path) =>
          path.startsWith(`modules/${module}/`),
        ),
        module,
      ).toEqual([]);
    }
  });
});
