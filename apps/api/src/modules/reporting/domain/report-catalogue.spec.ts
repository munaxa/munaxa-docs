import { describe, expect, it } from 'vitest';

import { ALL_PERMISSIONS, DocumentStatus, Permission } from '@edms/domain';

import {
  EXPORT_FORMATS,
  FORMAT_PARAMETER,
  REPORTS,
  REPORT_KEYS,
  ReportParameterKind,
  ReportScoping,
  artefactNameFor,
  mediaTypeFor,
  reportFor,
} from './report-catalogue';

/**
 * The catalogue's invariants, asserted rather than reviewed.
 *
 * Every one of these is a rule stated in prose at the head of `report-catalogue.ts`. Prose is what
 * the eleventh report added by somebody else will not read, so each rule that can be checked is.
 */
describe('the report catalogue', () => {
  it('gives every report a unique key', () => {
    expect(new Set(REPORT_KEYS).size).toBe(REPORT_KEYS.length);
  });

  it('answers the nine reports the phase brief names, plus the dimension breakdown', () => {
    // Named individually rather than counted, so removing one and adding another is a failure
    // rather than a wash.
    expect([...REPORT_KEYS].sort()).toEqual([
      'approvals',
      'audit',
      'deleted-documents',
      'departments',
      'documents',
      'documents-by-dimension',
      'expired-documents',
      'storage',
      'users',
      'workflow',
    ]);
  });

  /**
   * Rule 1: a report never widens the audience of the surface it summarises.
   *
   * `report:view` on every report, and never *alone* on one whose rows an earlier phase put behind
   * a second gate. The four named here are the four the phase brief calls out as crossing an
   * earlier boundary, and each is asserted against the permission that boundary uses.
   */
  it('requires report:view on every report', () => {
    for (const report of REPORTS) {
      expect(report.permissions).toContain(Permission.REPORT_VIEW);
    }
  });

  it.each([
    // The recycle bin's own gate — ADR-0010 §2.
    ['deleted-documents', Permission.DOCUMENT_RESTORE],
    // The disposition queue's own gate — `retention.controller.ts`.
    ['expired-documents', Permission.RETENTION_MANAGE],
    // The audit search's own gate — 13 §6 and 08 §10.
    ['audit', Permission.AUDIT_VIEW],
    // The two Phase 13 gated the equivalent tiles on.
    ['users', Permission.USER_MANAGE],
    ['departments', Permission.ORG_MANAGE],
  ])('gates %s on %s as well as report:view', (key, permission) => {
    const report = reportFor(key);
    expect(report?.permissions).toContain(permission);
    expect(report?.permissions.length).toBeGreaterThan(1);
  });

  it('names only permissions that exist in the catalogue', () => {
    for (const report of REPORTS) {
      for (const permission of report.permissions) {
        expect(ALL_PERMISSIONS).toContain(permission);
      }
    }
  });

  /**
   * Rule 2's other half: a report over document rows is reach-scoped, always.
   *
   * A report added later that reads documents and is marked `TENANT_WIDE` would be the disclosure
   * this phase exists to prevent, and it would look entirely reasonable in review.
   */
  it('scopes every document-sourced report by the caller reach', () => {
    for (const report of REPORTS.filter((entry) => entry.source === 'DOCUMENT')) {
      expect(report.scoping).toBe(ReportScoping.REACH_SCOPED);
    }
  });

  it('declares at least one column for every report', () => {
    for (const report of REPORTS) {
      expect(report.columns.length).toBeGreaterThan(0);
      expect(new Set(report.columns.map((column) => column.key)).size).toBe(report.columns.length);
    }
  });

  /**
   * The reserved parameter, and the reason it is reserved.
   *
   * `requestExport(key, parameters)` is Phase 0.5's signature and takes no format argument, so the
   * format travels as a parameter. A report declaring a filter called `format` would shadow it
   * silently — the export would run in whatever format the filter's value happened to spell.
   */
  it('lets no report declare a parameter called format', () => {
    for (const report of REPORTS) {
      expect(report.parameters.map((parameter) => parameter.name)).not.toContain(FORMAT_PARAMETER);
    }
  });

  it('gives every enum parameter its values, and nothing else one', () => {
    for (const report of REPORTS) {
      for (const parameter of report.parameters) {
        if (parameter.kind === ReportParameterKind.ENUM) {
          expect(parameter.values?.length ?? 0).toBeGreaterThan(0);
        } else {
          expect(parameter.values).toBeUndefined();
        }
      }
    }
  });

  /**
   * The status parameter is spelled out in the catalogue rather than imported from `DocumentStatus`
   * — deliberately, so a state added to the enum does not silently become a report filter. This is
   * the check for the opposite mistake: a value in the catalogue that is not a real status would
   * offer a filter that can never match.
   */
  it('offers only real document statuses as a filter', () => {
    const statuses: readonly string[] = Object.values(DocumentStatus);
    const parameter = reportFor('documents')?.parameters.find((entry) => entry.name === 'status');
    expect(parameter?.values?.length ?? 0).toBeGreaterThan(0);
    for (const value of parameter?.values ?? []) {
      expect(statuses).toContain(value);
    }
  });

  it('names an artefact and a media type for every format', () => {
    for (const format of EXPORT_FORMATS) {
      expect(artefactNameFor('documents', format)).toMatch(/^documents\.[a-z]+$/);
      expect(mediaTypeFor(format)).toMatch(/\//);
    }
  });

  /**
   * The Excel decision, asserted so it cannot be quietly renamed.
   *
   * What this product produces is SpreadsheetML 2003 — a real Excel format, opened natively, and
   * genuinely not XLSX. A `.xlsx` extension or an OOXML media type here would be the product
   * claiming a ZIP container it never wrote.
   */
  it('calls the Excel format what it is', () => {
    expect(artefactNameFor('documents', 'SPREADSHEET_XML')).toBe('documents.xls');
    expect(mediaTypeFor('SPREADSHEET_XML')).toBe('application/vnd.ms-excel');
    expect(EXPORT_FORMATS).not.toContain('XLSX');
  });

  it('answers null for a key it does not have', () => {
    expect(reportFor('everything')).toBeNull();
  });
});
