import {
  ExportFormat,
  FORMAT_PARAMETER,
  ReportParameterKind,
  isExportFormat,
  type ExportFormatKey,
  type ReportDefinition,
} from './report-catalogue';

/**
 * Turning `Record<string, string>` into something a query can be built from.
 *
 * Pure, and it returns its complaints rather than throwing them: the domain layer of this product
 * imports nothing from `core/`, so the application layer is what turns the list below into a
 * `ValidationError`. That also makes every rule here a unit test rather than an integration one.
 *
 * ## Unknown names are refused, not ignored
 *
 * The tempting behaviour — drop what you do not recognise — is the dangerous one for a report.
 * A misspelled `departmentId` silently produces a report over *every* department, and the person
 * reading it cannot tell by looking: it has rows, it has a total, and it is an answer to a question
 * nobody asked. Refusing costs one round trip and a message naming the parameter.
 *
 * ## An empty value is an absent one
 *
 * A form submits `status=` for a select nobody touched. Treating that as "status equals the empty
 * string" would filter every report to nothing, so it is dropped before validation and a *required*
 * parameter given an empty value is reported as missing rather than as malformed — which is the
 * message the person can act on.
 */
export interface ReportParameterError {
  readonly field: string;
  readonly message: string;
}

export interface ParsedParameters {
  readonly dates: Readonly<Record<string, Date>>;
  readonly strings: Readonly<Record<string, string>>;
  readonly booleans: Readonly<Record<string, boolean>>;
  /** Exactly what was supplied, minus the reserved `format`. What the audit row records. */
  readonly supplied: Readonly<Record<string, string>>;
  /** Present only when parsing an export request; `CSV` when nothing said otherwise. */
  readonly format: ExportFormatKey;
}

export type ParseOutcome =
  | { readonly ok: true; readonly parameters: ParsedParameters }
  | { readonly ok: false; readonly errors: readonly ReportParameterError[] };

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** As long as a report filter may be. Longer is a query, and a query is not a parameter. */
const MAX_TEXT_LENGTH = 200;

export function parseParameters(
  report: ReportDefinition,
  raw: Readonly<Record<string, string>>,
): ParseOutcome {
  const errors: ReportParameterError[] = [];
  const dates: Record<string, Date> = {};
  const strings: Record<string, string> = {};
  const booleans: Record<string, boolean> = {};
  const supplied: Record<string, string> = {};

  const declared = new Map(report.parameters.map((spec) => [spec.name, spec]));
  let format: ExportFormatKey = ExportFormat.CSV;

  for (const [name, value] of Object.entries(raw)) {
    if (value === '') {
      continue;
    }
    if (name === FORMAT_PARAMETER) {
      if (!isExportFormat(value)) {
        errors.push({ field: name, message: 'That is not a format this product produces.' });
      } else {
        format = value;
      }
      continue;
    }
    if (!declared.has(name)) {
      errors.push({ field: name, message: 'This report has no such parameter.' });
      continue;
    }
    supplied[name] = value;
  }

  for (const spec of report.parameters) {
    const value = supplied[spec.name];
    if (value === undefined) {
      if (spec.required) {
        errors.push({ field: spec.name, message: 'This report requires this parameter.' });
      }
      continue;
    }
    switch (spec.kind) {
      case ReportParameterKind.DATE: {
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) {
          errors.push({ field: spec.name, message: 'This must be a date.' });
        } else {
          dates[spec.name] = parsed;
        }
        break;
      }
      case ReportParameterKind.UUID:
        if (!UUID.test(value)) {
          errors.push({ field: spec.name, message: 'This must be an identifier.' });
        } else {
          strings[spec.name] = value;
        }
        break;
      case ReportParameterKind.ENUM:
        if (!(spec.values ?? []).includes(value)) {
          errors.push({ field: spec.name, message: 'That is not one of the allowed values.' });
        } else {
          strings[spec.name] = value;
        }
        break;
      case ReportParameterKind.BOOLEAN:
        if (value !== 'true' && value !== 'false') {
          errors.push({ field: spec.name, message: 'This must be true or false.' });
        } else {
          booleans[spec.name] = value === 'true';
        }
        break;
      case ReportParameterKind.TEXT:
        if (value.length > MAX_TEXT_LENGTH) {
          errors.push({ field: spec.name, message: 'This is too long to be a filter.' });
        } else {
          strings[spec.name] = value;
        }
        break;
    }
  }

  // A range that ends before it begins produces an empty report rather than an error, which is
  // indistinguishable from "there is nothing" — the same conflation Phase 13 refused between a
  // forbidden tile and a zero one.
  const from = dates['from'];
  const to = dates['to'];
  if (from !== undefined && to !== undefined && from.getTime() > to.getTime()) {
    errors.push({ field: 'to', message: 'The end of the range must not precede its start.' });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, parameters: { dates, strings, booleans, supplied, format } };
}
