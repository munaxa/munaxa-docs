import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { stampWatermark } from './watermark';

async function twoPagePdf(): Promise<Buffer> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const text of ['Page one', 'Page two']) {
    document.addPage([595, 842]).drawText(text, { x: 40, y: 800, size: 12, font });
  }
  return Buffer.from(await document.save());
}

describe('stampWatermark', () => {
  it('stamps every page and the result is still a loadable PDF with the same page count', async () => {
    const original = await twoPagePdf();
    const stamped = await stampWatermark(original, {
      viewer: 'Dana Q',
      reference: 'DOC-001',
      issuedAt: '2026-08-20 09:00 UTC',
    });

    expect(stamped.subarray(0, 5).toString()).toBe('%PDF-');
    expect(stamped.equals(original)).toBe(false);
    const reloaded = await PDFDocument.load(stamped);
    expect(reloaded.getPageCount()).toBe(2);
  });

  it('survives parameters the standard font cannot encode, rather than refusing to serve', async () => {
    const stamped = await stampWatermark(await twoPagePdf(), {
      viewer: 'مستخدم',
      reference: 'وثيقة',
      issuedAt: '2026-08-20 09:00 UTC',
    });
    expect(stamped.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
