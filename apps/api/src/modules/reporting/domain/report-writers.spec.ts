import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { ReportColumnType, type ReportColumn } from './report-catalogue';
import { renderReportPdf } from './report-pdf';
import {
  csvCell,
  csvHeader,
  csvRow,
  spreadsheetFooter,
  spreadsheetHeader,
  spreadsheetRow,
} from './report-writers';

const COLUMNS: readonly ReportColumn[] = [
  { key: 'title', type: ReportColumnType.TEXT },
  { key: 'count', type: ReportColumnType.NUMBER },
  { key: 'createdAt', type: ReportColumnType.DATE },
];

/**
 * The properties a compliance product's exports have to have, as unit tests.
 *
 * Every one of these is a claim `report-writers.ts` makes in prose. They are unit tests rather than
 * integration ones precisely because they are properties of the *bytes*, and a test that had to
 * reach a bucket to check whether a formula was neutralised is a test nobody runs.
 */
describe('the CSV writer', () => {
  /**
   * The trap the phase brief names, and the one uniform quoting does not close.
   *
   * A spreadsheet strips the quotes before it parses the cell, so `"=1+1"` is a formula. Only
   * changing the value stops it — and in this product the value is a document title or a delete
   * reason, written by a user and opened by somebody with access to everything.
   */
  it.each(['=1+1', '+1', '-1', '@SUM(A1)', '\tinjected', '\rinjected'])(
    'neutralises a cell beginning %j',
    (value) => {
      const cell = csvCell(value);
      expect(cell.startsWith(`"'`)).toBe(true);
    },
  );

  it('leaves an ordinary cell alone but quotes it', () => {
    expect(csvCell('Quality manual')).toBe('"Quality manual"');
  });

  it('doubles a quote inside a cell', () => {
    expect(csvCell('the "final" draft')).toBe('"the ""final"" draft"');
  });

  it('does not neutralise a hyphen that is part of a value rather than leading it', () => {
    // `2026-08-05` begins with a digit; a negative number does not, which is why the guard is on
    // the first character rather than on the presence of an operator anywhere.
    expect(csvCell('2026-08-05')).toBe('"2026-08-05"');
  });

  /** Without the BOM, a double-clicked CSV decodes in the system codepage and Arabic is mojibake. */
  it('leads the file with a byte-order mark, once', () => {
    const header = csvHeader(COLUMNS);
    expect(header.codePointAt(0)).toBe(0xfeff);
    expect([...header].filter((character) => character.codePointAt(0) === 0xfeff)).toHaveLength(1);
  });

  it('ends every line with CRLF, as RFC 4180 says', () => {
    expect(csvHeader(COLUMNS).endsWith('\r\n')).toBe(true);
    expect(csvRow(COLUMNS, { title: 'a', count: 1, createdAt: null }).endsWith('\r\n')).toBe(true);
  });

  it('carries Arabic through unchanged', () => {
    expect(csvRow(COLUMNS, { title: 'دليل الجودة', count: 2, createdAt: null })).toContain(
      'دليل الجودة',
    );
  });

  it('writes an absent value as an empty cell rather than as "null"', () => {
    expect(csvRow(COLUMNS, { title: null, count: null, createdAt: null })).toBe('"","",""\r\n');
  });
});

describe('the SpreadsheetML writer', () => {
  /** Typed cells are the whole reason this is not a CSV with a different extension. */
  it('writes a number as a number and text as text', () => {
    const row = spreadsheetRow(COLUMNS, { title: '0012-2026', count: 7, createdAt: null });
    expect(row).toContain('<Data ss:Type="Number">7</Data>');
    // The document number stays text, so Excel does not read `0012-2026` as a subtraction.
    expect(row).toContain('<Data ss:Type="String">0012-2026</Data>');
  });

  it('writes a date without a zone suffix, which is what Excel accepts', () => {
    const row = spreadsheetRow(COLUMNS, {
      title: 'a',
      count: 1,
      createdAt: new Date('2026-08-05T09:00:00.000Z'),
    });
    expect(row).toContain('<Data ss:Type="DateTime">2026-08-05T09:00:00</Data>');
    expect(row).not.toContain('2026-08-05T09:00:00.000Z');
  });

  /**
   * A malformed numeric cell makes Excel refuse the whole workbook, so one bad row must not cost
   * the export. It degrades to text rather than emitting `NaN`.
   */
  it('degrades a non-finite number to text rather than losing the workbook', () => {
    const row = spreadsheetRow(COLUMNS, { title: 'a', count: 'not a number', createdAt: null });
    expect(row).toContain('<Data ss:Type="String">not a number</Data>');
    expect(row).not.toContain('NaN');
  });

  it('writes an absent value as an empty cell', () => {
    expect(spreadsheetRow(COLUMNS, { title: null, count: null, createdAt: null })).toBe(
      '<Row><Cell/><Cell/><Cell/></Row>\n',
    );
  });

  it('escapes the three characters XML needs escaped', () => {
    const row = spreadsheetRow(COLUMNS, { title: '<a> & "b"', count: 1, createdAt: null });
    expect(row).toContain('&lt;a&gt; &amp; "b"');
  });

  /**
   * XML 1.0 cannot represent most control characters at all — not even as a numeric reference — so
   * a value carrying one can only be stripped. One pasted NUL would otherwise produce a workbook
   * Excel refuses to open, which is a worse failure than a missing character.
   */
  it('strips a control character rather than producing a workbook Excel refuses', () => {
    const row = spreadsheetRow(COLUMNS, { title: 'a\u0000b', count: 1, createdAt: null });
    expect(row).toContain('<Data ss:Type="String">ab</Data>');
  });

  it('opens and closes a well-formed workbook', () => {
    const document = `${spreadsheetHeader('documents', COLUMNS)}${spreadsheetRow(COLUMNS, {
      title: 'a',
      count: 1,
      createdAt: null,
    })}${spreadsheetFooter()}`;
    expect(document).toContain('<?mso-application progid="Excel.Sheet"?>');
    expect(document).toContain('<Worksheet ss:Name="documents">');
    expect(document.trimEnd().endsWith('</Workbook>')).toBe(true);
    // Every opened element is closed — the cheapest well-formedness check that does not need a
    // parser this repository cannot add.
    for (const tag of ['Workbook', 'Worksheet', 'Table']) {
      expect(document.split(`<${tag}`).length - 1).toBe(document.split(`</${tag}>`).length - 1);
    }
  });

  it('carries Arabic through unchanged', () => {
    expect(spreadsheetRow(COLUMNS, { title: 'دليل الجودة', count: 1, createdAt: null })).toContain(
      'دليل الجودة',
    );
  });
});

describe('the PDF writer', () => {
  const input = {
    title: 'documents',
    columns: COLUMNS,
    parameters: { status: 'PUBLISHED' },
    requestedBy: 'ada',
    producedAt: new Date('2026-08-05T09:00:00.000Z'),
    tenantName: 'acme',
  };

  it('produces a PDF, with the parameters that produced it', async () => {
    const result = await renderReportPdf({
      ...input,
      rows: [{ title: 'Quality manual', count: 3, createdAt: new Date() }],
      totalRows: 1,
    });
    expect(result.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(result.substitutions).toBe(0);
  });

  /**
   * The honest half of the PDF, and the reason `substitutions` is on the export record and on the
   * wire. `pdf-lib`'s standard fonts are WinAnsi and this repository can add neither a dependency
   * nor a font asset — so an Arabic report is lossy, it is *counted*, and the screen says so.
   * Phase 7 refused to render text to PDF for exactly this reason; what makes it acceptable here
   * is that nobody is handed the file without being told.
   */
  it('counts what the standard font cannot encode instead of failing the export', async () => {
    const result = await renderReportPdf({
      ...input,
      rows: [{ title: 'دليل', count: 1, createdAt: null }],
      totalRows: 1,
    });
    expect(result.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(result.substitutions).toBeGreaterThan(0);
  });

  it('paginates rather than overflowing one page', async () => {
    const rows = Array.from({ length: 200 }, (_, index) => ({
      title: `Document ${index}`,
      count: index,
      createdAt: null,
    }));
    const result = await renderReportPdf({ ...input, rows, totalRows: rows.length });
    // Read back rather than grepped for a marker: the exact page count depends on layout, the fact
    // that two hundred rows did not silently overwrite one page does not.
    const reloaded = await PDFDocument.load(result.bytes);
    expect(reloaded.getPageCount()).toBeGreaterThan(1);
  });
});
