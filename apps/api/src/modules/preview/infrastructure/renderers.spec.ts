import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { PreviewArtifactKind } from '@edms/domain';

import type { RenderInput, RenderLimits, RenderedArtifact } from '../../../ports/preview.port';
import { RenderFailedError } from '../../../ports/preview.port';
import { TINY_JPEG, makeDocx, makePptx, makeXlsx, makeZip } from '../../../testing/office-fixtures';
import { encodePng } from '../domain/png';
import { ZipError, readZipEntry } from '../domain/zip';
import { LibreOfficeConverter, NoOfficeConverter } from './libreoffice.converter';
import { ImageRenderer } from './image.renderer';
import { OfficeRenderer } from './office.renderer';
import { PdfRenderer } from './pdf.renderer';
import { DefaultRendererRegistry, RegistryPreviewAdapter } from './renderer.registry';
import { TextRenderer } from './text.renderer';

/**
 * Every renderer against a real file of its format — a PDF written by a real PDF library, OOXML
 * documents that are genuine ZIPs of the specification's parts, a PNG from the product's own
 * encoder, a byte-exact libjpeg JPEG. No fixture is a stub of the format it claims to be.
 */

const LIMITS: RenderLimits = {
  timeoutMs: 30_000,
  maxOutputBytes: 32 * 1024 * 1024,
  maxPages: 100,
  maxTextBytes: 1024 * 1024,
  maxArchiveEntries: 256,
  maxArchiveExpansionRatio: 200,
  maxPixels: 40_000_000,
};

function input(bytes: Buffer, mimeType: string): RenderInput {
  return { bytes, mimeType, limits: LIMITS };
}

async function realPdf(pages: readonly string[]): Promise<Buffer> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const text of pages) {
    const page = document.addPage([595, 842]);
    page.drawText(text, { x: 50, y: 780, size: 14, font });
  }
  return Buffer.from(await document.save());
}

function ofKind(artifacts: readonly RenderedArtifact[], kind: string): readonly RenderedArtifact[] {
  return artifacts.filter((artifact) => artifact.kind === kind);
}

function textOf(artifact: RenderedArtifact | undefined): string {
  if (artifact === undefined || artifact.content === 'SOURCE') {
    return '';
  }
  return artifact.content.bytes.toString('utf8');
}

describe('PdfRenderer', () => {
  const renderer = new PdfRenderer();

  it('claims exactly application/pdf', () => {
    expect(renderer.supports('application/pdf')).toBe(true);
    expect(renderer.supports('image/png')).toBe(false);
  });

  it('answers the page count, the source as its own rendition, and the text layer per page', async () => {
    const pdf = await realPdf(['First page words', 'Second page words']);
    const result = await renderer.render(input(pdf, 'application/pdf'));

    expect(result.pageCount).toBe(2);
    const rendition = ofKind(result.artifacts, PreviewArtifactKind.PDF);
    expect(rendition).toHaveLength(1);
    // The source *is* the rendition: referenced, never copied — the content-addressed store
    // would refuse the byte-identical duplicate anyway.
    expect(rendition[0]?.content).toBe('SOURCE');

    const text = ofKind(result.artifacts, PreviewArtifactKind.TEXT);
    expect(text.map((artifact) => artifact.page)).toEqual([1, 2]);
    expect(textOf(text[0])).toContain('First page words');
    expect(textOf(text[1])).toContain('Second page words');
  });

  it('produces no TEXT artefact for a PDF with no text layer, which is what routes it to OCR', async () => {
    const document = await PDFDocument.create();
    document.addPage([100, 100]);
    const result = await renderer.render(
      input(Buffer.from(await document.save()), 'application/pdf'),
    );
    expect(ofKind(result.artifacts, PreviewArtifactKind.TEXT)).toHaveLength(0);
  });

  it('refuses bytes that are not a PDF, terminally', async () => {
    await expect(
      renderer.render(input(Buffer.from('not a pdf'), 'application/pdf')),
    ).rejects.toThrow(RenderFailedError);
  });
});

describe('OfficeRenderer without a converter (OFFICE_DRIVER=NONE)', () => {
  const renderer = new OfficeRenderer(new NoOfficeConverter());

  it('claims OOXML but not the legacy formats an office suite alone can open', () => {
    expect(
      renderer.supports('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    ).toBe(true);
    expect(renderer.supports('application/msword')).toBe(false);
  });

  it('extracts a real Word document’s paragraphs as unpaginated text', async () => {
    const docx = makeDocx(['Quality manual', 'Scope and definitions', 'الوثيقة العربية']);
    const result = await renderer.render(
      input(docx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    );
    expect(result.pageCount).toBeNull();
    const text = ofKind(result.artifacts, PreviewArtifactKind.TEXT);
    expect(text).toHaveLength(1);
    expect(text[0]?.page).toBeNull();
    const words = textOf(text[0]);
    expect(words).toContain('Quality manual');
    expect(words).toContain('الوثيقة العربية');
    // Paragraph ends survive as breaks, which is what the paragraph diff aligns on.
    expect(words.indexOf('\n')).toBeGreaterThan(0);
  });

  it('extracts a workbook’s shared strings', async () => {
    const xlsx = makeXlsx(['Register', 'DOC-001', 'Retained']);
    const result = await renderer.render(
      input(xlsx, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
    );
    expect(textOf(ofKind(result.artifacts, PreviewArtifactKind.TEXT)[0])).toContain('DOC-001');
  });

  it('extracts a presentation per slide, because slides are its pages', async () => {
    const pptx = makePptx(['Title slide', 'Second slide']);
    const result = await renderer.render(
      input(pptx, 'application/vnd.openxmlformats-officedocument.presentationml.presentation'),
    );
    const text = ofKind(result.artifacts, PreviewArtifactKind.TEXT);
    expect(text.map((artifact) => artifact.page)).toEqual([1, 2]);
    expect(textOf(text[1])).toContain('Second slide');
  });
});

describe('the archive caps, which are what make a .docx bomb fail the job', () => {
  it('refuses an entry whose declared expansion exceeds the ratio', () => {
    const bomb = makeZip([{ name: 'word/document.xml', content: 'a'.repeat(1_000_000) }]);
    expect(() =>
      readZipEntry(bomb, 'word/document.xml', {
        maxEntries: 16,
        maxExpansionRatio: 10,
        maxEntryBytes: 64 * 1024 * 1024,
      }),
    ).toThrow(ZipError);
  });

  it('refuses an entry above the byte ceiling before inflating it', () => {
    const zip = makeZip([{ name: 'word/document.xml', content: 'irrelevant '.repeat(100) }]);
    expect(() =>
      readZipEntry(zip, 'word/document.xml', {
        maxEntries: 16,
        maxExpansionRatio: 200,
        maxEntryBytes: 8,
      }),
    ).toThrow(ZipError);
  });
});

describe('ImageRenderer', () => {
  const renderer = new ImageRenderer();

  it('serves a PNG as its own single page, with a rendition and a thumbnail', async () => {
    const png = encodePng({
      width: 4,
      height: 4,
      pixels: new Uint8Array(4 * 4 * 4).fill(200),
    });
    const result = await renderer.render(input(png, 'image/png'));

    expect(result.pageCount).toBe(1);
    expect(ofKind(result.artifacts, PreviewArtifactKind.PAGE_IMAGE)[0]?.content).toBe('SOURCE');
    const rendition = ofKind(result.artifacts, PreviewArtifactKind.PDF)[0];
    expect(rendition?.content).not.toBe('SOURCE');
    if (rendition !== undefined && rendition.content !== 'SOURCE') {
      expect(rendition.content.bytes.subarray(0, 5).toString()).toBe('%PDF-');
    }
    expect(ofKind(result.artifacts, PreviewArtifactKind.THUMBNAIL)).toHaveLength(1);
  });

  it('embeds a real JPEG into a one-page rendition', async () => {
    const result = await renderer.render(input(TINY_JPEG, 'image/jpeg'));
    expect(ofKind(result.artifacts, PreviewArtifactKind.PDF)).toHaveLength(1);
  });

  it('passes GIF through for the browser and produces no rendition for it', async () => {
    const gif = Buffer.from('GIF89a', 'ascii');
    const result = await renderer.render(input(gif, 'image/gif'));
    expect(ofKind(result.artifacts, PreviewArtifactKind.PAGE_IMAGE)[0]?.content).toBe('SOURCE');
    expect(ofKind(result.artifacts, PreviewArtifactKind.PDF)).toHaveLength(0);
  });

  it('does not claim TIFF: browsers cannot draw it and a wrong preview is worse than none', () => {
    expect(renderer.supports('image/tiff')).toBe(false);
  });
});

describe('TextRenderer', () => {
  const renderer = new TextRenderer();

  it('normalises a real text file to one UTF-8 artefact', async () => {
    const result = await renderer.render(
      input(Buffer.from('﻿line one\r\nline two\r\n', 'utf8'), 'text/plain'),
    );
    const text = ofKind(result.artifacts, PreviewArtifactKind.TEXT);
    expect(textOf(text[0])).toBe('line one\nline two\n');
    expect(result.pageCount).toBeNull();
  });

  it('caps the artefact without splitting a multi-byte character', async () => {
    const arabic = 'م'.repeat(100); // two bytes per character in UTF-8
    const result = await renderer.render({
      bytes: Buffer.from(arabic, 'utf8'),
      mimeType: 'text/plain',
      limits: { ...LIMITS, maxTextBytes: 33 },
    });
    const text = textOf(ofKind(result.artifacts, PreviewArtifactKind.TEXT)[0]);
    // 33 bytes would split the seventeenth character; the cap lands on a boundary instead,
    // and nothing decodes to a replacement character.
    expect(text).toBe('م'.repeat(16));
  });
});

describe('the registry, dispatching per file', () => {
  const registry = new DefaultRendererRegistry();
  registry.register(new PdfRenderer());
  registry.register(new OfficeRenderer(new NoOfficeConverter()));
  registry.register(new ImageRenderer());
  registry.register(new TextRenderer());
  const port = new RegistryPreviewAdapter(registry);

  it('resolves every claimed format and answers null for the rest', () => {
    expect(port.canRender('application/pdf')).toBe(true);
    expect(port.canRender('text/csv')).toBe(true);
    // DWG deliberately has no renderer: 14 §7's unsupported-format row is the designed answer.
    expect(port.canRender('image/vnd.dwg')).toBe(false);
    expect(port.canRender('application/zip')).toBe(false);
  });

  it('records which renderer answered, with its version', async () => {
    const result = await port.render(input(Buffer.from('plain words'), 'text/plain'));
    expect(result?.renderer).toBe('munaxa-text');
    expect(result?.version).toBe('1.0.0');
  });

  it('lists supported formats by asking the plugins', () => {
    expect(registry.supportedMimeTypes).toContain('application/pdf');
    expect(registry.supportedMimeTypes).not.toContain('image/vnd.dwg');
    // Legacy Office appears only when a converter is present — the renderer knows, not a list.
    expect(registry.supportedMimeTypes).not.toContain('application/msword');
  });
});

describe('OfficeRenderer with LibreOffice (OFFICE_DRIVER=LIBREOFFICE)', () => {
  const binary = findSoffice();

  it.skipIf(binary === null)(
    'converts a real Word document to a paginated PDF rendition',
    async () => {
      const renderer = new OfficeRenderer(new LibreOfficeConverter(binary ?? 'soffice'));
      const result = await renderer.render(
        input(
          makeDocx(['Controlled procedure', 'Applies to every site.']),
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ),
      );
      expect(result.pageCount).toBeGreaterThanOrEqual(1);
      const rendition = ofKind(result.artifacts, PreviewArtifactKind.PDF)[0];
      expect(rendition).toBeDefined();
      if (rendition !== undefined && rendition.content !== 'SOURCE') {
        expect(rendition.content.bytes.subarray(0, 5).toString()).toBe('%PDF-');
      }
      const text = ofKind(result.artifacts, PreviewArtifactKind.TEXT);
      expect(text.length).toBeGreaterThanOrEqual(1);
      expect(text.map((artifact) => textOf(artifact)).join('\n')).toContain('Controlled procedure');
    },
    120_000,
  );
});

/**
 * The binary, if this machine can genuinely convert — CI's Ubuntu image can; a laptop may not.
 *
 * Probed by converting rather than by `--version`, because a machine with `libreoffice-core`
 * and no Writer answers the version cheerfully and loads nothing; a skip must mean "no engine
 * here", never "the engine is broken".
 */
function findSoffice(): string | null {
  for (const candidate of ['soffice', 'libreoffice']) {
    try {
      const workdir = mkdtempSync(join(tmpdir(), 'edms-soffice-probe-'));
      try {
        writeFileSync(join(workdir, 'probe.txt'), 'probe');
        execFileSync(
          candidate,
          [
            '--headless',
            `-env:UserInstallation=${pathToFileURL(join(workdir, 'profile')).toString()}`,
            '--convert-to',
            'pdf',
            '--outdir',
            workdir,
            join(workdir, 'probe.txt'),
          ],
          {
            stdio: 'ignore',
            timeout: 60_000,
            env: { PATH: process.env['PATH'] ?? '', HOME: workdir },
          },
        );
        if (existsSync(join(workdir, 'probe.pdf'))) {
          return candidate;
        }
      } finally {
        rmSync(workdir, { recursive: true, force: true });
      }
    } catch {
      // Try the next name.
    }
  }
  return null;
}
