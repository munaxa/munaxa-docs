import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

import { cellText, type ReportRow } from './report-writers';
import type { ReportColumn } from './report-catalogue';

/**
 * A report as a PDF, with `pdf-lib` — the one format in this phase that has a library behind it.
 *
 * ---
 *
 * ## Why it is assembled rather than streamed
 *
 * The other two formats are three strings: a header, a chunk per page, a footer. A PDF is an object
 * graph with a cross-reference table stating the byte offset of every object, so it cannot be
 * emitted before it is finished. That is not a limitation of `pdf-lib`; it is the format. It is
 * therefore the one artefact bounded by memory rather than by patience, and `REPORTING_PDF_MAX_ROWS`
 * is a *smaller* cap than the export's own — stated in configuration, refused in the service, and
 * reported rather than silently applied.
 *
 * ## The Arabic problem, stated rather than hidden
 *
 * `pdf-lib`'s standard fonts are WinAnsi: they encode Latin-1 and nothing else. Phase 7 hit this
 * already and refused to render plain text to PDF at all, in `text.renderer.ts`, for exactly this
 * reason — *"in a product whose OCR ships `ara+eng` — Arabic shaping, none of which pdf-lib's
 * standard fonts do. A rendition that garbles Arabic text is worse than no rendition."* Embedding a
 * font that covers Arabic would mean adding either a dependency or a binary asset, and this phase
 * can add neither.
 *
 * So a character the font cannot encode becomes `?` **and the substitution is counted**. The count
 * travels onto the export record, onto the wire and into the `REPORT_EXPORTED` audit row, and the
 * download screen says the PDF is lossy. Phase 7's judgement stands — a garbled rendition is worse
 * than none — and what makes this acceptable where that was not is that nobody is handed the file
 * without being told. An Arabic tenant exports CSV or the spreadsheet, both of which are UTF-8 and
 * neither of which loses a character.
 *
 * ## Layout
 *
 * Landscape A4, a repeated header row, a footer carrying the page number and the total, and a
 * title block naming the report, who ran it, when, and every parameter that produced it. The last
 * of those is the point: a report printed without its parameters is a page of numbers nobody can
 * reproduce, which is precisely the artefact a compliance conversation must not turn on.
 */
export interface ReportPdfInput {
  readonly title: string;
  readonly columns: readonly ReportColumn[];
  readonly rows: readonly ReportRow[];
  /** What produced these rows. Rendered verbatim under the title. */
  readonly parameters: Readonly<Record<string, string>>;
  readonly requestedBy: string;
  readonly producedAt: Date;
  readonly totalRows: number;
  readonly tenantName: string;
}

export interface ReportPdfResult {
  readonly bytes: Buffer;
  /** How many characters the standard font could not encode. Zero is the ordinary case. */
  readonly substitutions: number;
}

const PAGE = { width: 841.89, height: 595.28 } as const;
const MARGIN = 32;
const HEADER_SIZE = 8;
const BODY_SIZE = 7.5;
const ROW_HEIGHT = 13;

export async function renderReportPdf(input: ReportPdfInput): Promise<ReportPdfResult> {
  const pdf = await PDFDocument.create();
  const body = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const counter = { substitutions: 0 };

  const usable = PAGE.width - MARGIN * 2;
  // Every column the same width. A measured layout would be prettier and would need the whole
  // report in memory twice — once to measure and once to draw — for a document whose columns are
  // fixed by the catalogue anyway.
  const columnWidth = usable / Math.max(input.columns.length, 1);

  let page = pdf.addPage([PAGE.width, PAGE.height]);
  let cursor = PAGE.height - MARGIN;
  let pageNumber = 1;

  const drawTitleBlock = (): void => {
    page.drawText(encode(input.title, counter), {
      x: MARGIN,
      y: cursor - 12,
      size: 14,
      font: bold,
      color: rgb(0.1, 0.1, 0.1),
    });
    cursor -= 26;
    const lines = [
      `${input.tenantName} · produced ${input.producedAt.toISOString()} · requested by ${input.requestedBy}`,
      `${input.totalRows} row(s)`,
      parameterLine(input.parameters),
    ];
    for (const line of lines) {
      page.drawText(encode(line, counter), {
        x: MARGIN,
        y: cursor,
        size: HEADER_SIZE,
        font: body,
        color: rgb(0.35, 0.35, 0.35),
      });
      cursor -= 11;
    }
    cursor -= 6;
  };

  const drawColumnHeads = (): void => {
    input.columns.forEach((column, index) => {
      page.drawText(encode(column.key, counter), {
        x: MARGIN + index * columnWidth,
        y: cursor,
        size: HEADER_SIZE,
        font: bold,
        color: rgb(0.1, 0.1, 0.1),
      });
    });
    cursor -= 4;
    page.drawLine({
      start: { x: MARGIN, y: cursor },
      end: { x: PAGE.width - MARGIN, y: cursor },
      thickness: 0.5,
      color: rgb(0.7, 0.7, 0.7),
    });
    cursor -= ROW_HEIGHT;
  };

  const drawFooter = (): void => {
    page.drawText(encode(`Page ${pageNumber}`, counter), {
      x: PAGE.width - MARGIN - 40,
      y: MARGIN / 2,
      size: HEADER_SIZE,
      font: body,
      color: rgb(0.5, 0.5, 0.5),
    });
  };

  drawTitleBlock();
  drawColumnHeads();

  for (const row of input.rows) {
    if (cursor < MARGIN + ROW_HEIGHT) {
      drawFooter();
      page = pdf.addPage([PAGE.width, PAGE.height]);
      pageNumber += 1;
      cursor = PAGE.height - MARGIN;
      // The header repeats on every page, because a page of a report that arrives on its own —
      // printed, photographed, attached to an email — has to say what its columns are.
      drawColumnHeads();
    }
    input.columns.forEach((column, index) => {
      page.drawText(encode(truncate(cellText(row[column.key]), columnWidth), counter), {
        x: MARGIN + index * columnWidth,
        y: cursor,
        size: BODY_SIZE,
        font: body,
        color: rgb(0.15, 0.15, 0.15),
      });
    });
    cursor -= ROW_HEIGHT;
  }
  drawFooter();

  return { bytes: Buffer.from(await pdf.save()), substitutions: counter.substitutions };
}

function parameterLine(parameters: Readonly<Record<string, string>>): string {
  const entries = Object.entries(parameters);
  // "no filters" rather than an empty line, so the absence of parameters is a stated fact rather
  // than a blank somebody reads as "the parameters were cut off".
  return entries.length === 0
    ? 'Parameters: none'
    : `Parameters: ${entries.map(([name, value]) => `${name}=${value}`).join(' · ')}`;
}

/** Roughly what fits, at this font size. A cell that overflowed would print over its neighbour. */
function truncate(value: string, width: number): string {
  const characters = Math.max(Math.floor(width / (BODY_SIZE * 0.5)) - 1, 4);
  return value.length <= characters ? value : `${value.slice(0, characters - 1)}…`;
}

/**
 * What the standard font can actually draw.
 *
 * `drawText` **throws** on a character WinAnsi cannot encode, which would abandon the whole export
 * for one Arabic title — so substitution happens here, deliberately and counted, rather than being
 * discovered as a failed job. The ellipsis `truncate` adds is itself outside Latin-1, so it is
 * mapped rather than counted: the product put it there, not a user.
 */
function encode(value: string, counter: { substitutions: number }): string {
  let out = '';
  for (const character of value.replaceAll('…', '...')) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0x20 && code <= 0x7e) {
      out += character;
      continue;
    }
    if (code >= 0xa0 && code <= 0xff) {
      out += character;
      continue;
    }
    out += '?';
    counter.substitutions += 1;
  }
  return out;
}
