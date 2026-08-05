import { describe, expect, it } from 'vitest';

import { ExportFormat, reportFor } from './report-catalogue';
import { parseParameters } from './report-parameters';

const documents = reportFor('documents');
const breakdown = reportFor('documents-by-dimension');

if (documents === null || breakdown === null) {
  throw new Error('The catalogue no longer has the reports these tests are about.');
}

describe('report parameters', () => {
  /**
   * The rule that matters most, and the tempting behaviour it refuses.
   *
   * Dropping what you do not recognise is what most query parsers do, and for a report it is
   * dangerous: a misspelled `departmentId` produces a report over *every* department, and the
   * person reading it cannot tell — it has rows, it has a total, and it is a confident answer to a
   * question nobody asked.
   */
  it('refuses an unknown parameter rather than ignoring it', () => {
    const outcome = parseParameters(documents, { departmentId: 'x' });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.errors[0]?.field).toBe('departmentId');
  });

  it('treats an empty value as absent, so an untouched select filters nothing', () => {
    const outcome = parseParameters(documents, { status: '', libraryId: '' });
    expect(outcome.ok).toBe(true);
    expect(outcome.ok === true && outcome.parameters.supplied).toEqual({});
  });

  it('reports a required parameter given an empty value as missing, not as malformed', () => {
    const outcome = parseParameters(breakdown, { dimension: '' });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.errors[0]?.message).toContain('requires');
  });

  it('refuses a value outside an enum', () => {
    const outcome = parseParameters(documents, { status: 'ALMOST_PUBLISHED' });
    expect(outcome.ok).toBe(false);
  });

  it('refuses an identifier that is not one', () => {
    const outcome = parseParameters(documents, { libraryId: 'the-main-library' });
    expect(outcome.ok).toBe(false);
  });

  it('parses a date range and keeps what was supplied', () => {
    const outcome = parseParameters(documents, {
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-03-31T23:59:59.000Z',
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.ok === true && outcome.parameters.dates['from']?.getUTCMonth()).toBe(0);
    // `supplied` is what the audit row and the PDF's title block carry: what somebody asked for,
    // in the words they asked it in.
    expect(outcome.ok === true && outcome.parameters.supplied['to']).toBe(
      '2026-03-31T23:59:59.000Z',
    );
  });

  /**
   * A range that ends before it begins would produce an empty report, which is indistinguishable
   * from "there is nothing" — the same conflation Phase 13 refused between a forbidden tile and a
   * zero one.
   */
  it('refuses a range that ends before it begins', () => {
    const outcome = parseParameters(documents, {
      from: '2026-03-01T00:00:00.000Z',
      to: '2026-01-01T00:00:00.000Z',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.errors[0]?.field).toBe('to');
  });

  it('defaults the format to CSV and never puts it among the report parameters', () => {
    const outcome = parseParameters(documents, { status: 'PUBLISHED' });
    expect(outcome.ok === true && outcome.parameters.format).toBe(ExportFormat.CSV);
    expect(outcome.ok === true && outcome.parameters.supplied).toEqual({ status: 'PUBLISHED' });
  });

  it('reads the reserved format parameter, and refuses one it does not produce', () => {
    expect(
      parseParameters(documents, { format: 'SPREADSHEET_XML' }).ok === true &&
        parseParameters(documents, { format: 'SPREADSHEET_XML' }),
    ).toMatchObject({ parameters: { format: 'SPREADSHEET_XML' } });
    expect(parseParameters(documents, { format: 'XLSX' }).ok).toBe(false);
  });

  it('refuses a text filter longer than a filter', () => {
    const audit = reportFor('audit');
    expect(audit).not.toBeNull();
    expect(parseParameters(audit!, { action: 'A'.repeat(500) }).ok).toBe(false);
  });
});
