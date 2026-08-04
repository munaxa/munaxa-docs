import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';

import { winAnsiSafe } from '../domain/watermark-text';

/**
 * The watermark 14 §4 specifies: who is looking, when, at which controlled document.
 *
 * Stamped onto the PDF rendition at serve time, per user, per request — every page, diagonal
 * "CONTROLLED COPY" across the middle, the viewer's identity and the instant along the foot.
 * Nothing is cached: the alternative in 14 §4 (a shared, time-stamped mark cached once) trades
 * accountability for storage, and the stamping cost here is milliseconds against a rendition
 * already capped in size, so this deployment takes the stronger mark and the report says so.
 *
 * The stamp is drawn with a standard font, which carries WinAnsi and nothing else — so the
 * parameters are transliterated to what the font can carry rather than allowed to throw.
 * A viewer whose display name is Arabic is identified by the fallback the caller supplies
 * (their account email), not silently omitted. Embedding a shaping-capable Arabic font is the
 * recorded improvement, not this phase's.
 */
export interface WatermarkStamp {
  /** Who is looking — display name where encodable, account identifier otherwise. */
  readonly viewer: string;
  /** The controlled identity: the document number, or the title while unnumbered. */
  readonly reference: string;
  /** The instant of issue, already formatted. */
  readonly issuedAt: string;
}

const BANNER = 'CONTROLLED COPY';

export async function stampWatermark(rendition: Buffer, stamp: WatermarkStamp): Promise<Buffer> {
  const document = await PDFDocument.load(rendition, { ignoreEncryption: true });
  const font = await document.embedFont(StandardFonts.Helvetica);
  const footer = winAnsiSafe(`${stamp.reference} · ${stamp.viewer} · ${stamp.issuedAt}`);

  for (const page of document.getPages()) {
    const { width, height } = page.getSize();
    const bannerSize = Math.max(24, Math.min(width, height) / 12);
    const bannerWidth = font.widthOfTextAtSize(BANNER, bannerSize);
    page.drawText(BANNER, {
      // Centred on the diagonal: rotation happens about the text origin, so the origin is
      // pushed back along the rotated baseline by half the text's length.
      x: width / 2 - (bannerWidth / 2) * Math.cos(Math.PI / 4),
      y: height / 2 - (bannerWidth / 2) * Math.sin(Math.PI / 4),
      size: bannerSize,
      font,
      color: rgb(0.75, 0.1, 0.1),
      opacity: 0.18,
      rotate: degrees(45),
    });
    const footerSize = 8;
    page.drawText(footer, {
      x: Math.max(12, (width - font.widthOfTextAtSize(footer, footerSize)) / 2),
      y: 6,
      size: footerSize,
      font,
      color: rgb(0.35, 0.35, 0.35),
      opacity: 0.9,
    });
  }
  return Buffer.from(await document.save());
}
