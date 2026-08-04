import { MetadataDataType, type MetadataDataTypeKey } from '@edms/domain';

/**
 * Turning what a form posted into what a typed column can hold — or refusing it.
 *
 * The tenant defines which fields exist; the product knows what a date is. That division is why
 * `document_metadata_value` has typed columns rather than a `jsonb` bag, and this is the code that
 * makes the division hold: a value arrives as whatever JSON carried it, and leaves as exactly one
 * populated column of the right type, or as a rejection naming the field.
 *
 * **Nothing here coerces silently.** A `NUMBER` field sent the string `"twelve"` is a rejection,
 * not a `null` and not a zero. Both of those would lose the person's data and hide the defect that
 * produced it, and a document-control system whose metadata is quietly wrong is worse than one
 * that refuses a save.
 *
 * Pure: no database, no Prisma, no framework. The whole of "is this a legal value for that field"
 * is decidable from the field's definition and the value, which is what lets it be tested
 * exhaustively.
 */

/** As much of a field's definition as validating a value requires. */
export interface FieldDefinition {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly dataType: MetadataDataTypeKey;
  readonly isRequired: boolean;
  /** The permitted options, for `SELECT` and `MULTI_SELECT`. Empty for every other type. */
  readonly options: readonly string[];
  readonly validation: FieldValidation;
}

export interface FieldValidation {
  readonly minLength?: number | undefined;
  readonly maxLength?: number | undefined;
  readonly min?: number | undefined;
  readonly max?: number | undefined;
  /** Compiled at save time by Administration, so an invalid expression never reaches here. */
  readonly pattern?: string | undefined;
}

/** Exactly one of these is populated, decided by the field's own type. */
export interface MetadataColumns {
  readonly textValue: string | null;
  readonly numberValue: string | null;
  readonly dateValue: Date | null;
  readonly booleanValue: boolean | null;
  readonly referenceValue: string | null;
  readonly selectValues: readonly string[];
}

export interface MetadataRejection {
  readonly field: string;
  readonly message: string;
}

export const EMPTY_COLUMNS: MetadataColumns = Object.freeze({
  textValue: null,
  numberValue: null,
  dateValue: null,
  booleanValue: null,
  referenceValue: null,
  selectValues: [],
});

export type MetadataInputValue = string | number | boolean | readonly string[] | null;

/**
 * Every field the type requires, checked against what was supplied.
 *
 * Returns the columns to write *and* the rejections, rather than throwing on the first problem. A
 * form with four bad fields should say so once: reporting them one save at a time is how a
 * fifteen-field document type becomes fifteen round trips.
 */
export function coerceMetadata(
  fields: readonly FieldDefinition[],
  supplied: Readonly<Record<string, MetadataInputValue>>,
): {
  readonly values: ReadonlyMap<string, MetadataColumns>;
  readonly rejections: readonly MetadataRejection[];
} {
  const values = new Map<string, MetadataColumns>();
  const rejections: MetadataRejection[] = [];

  for (const field of fields) {
    // Addressed by key, which is what a tenant writes in a form and an import file — the
    // identifier is ours, and requiring a caller to know it would make an import unwritable.
    const raw = supplied[field.key];
    const absent = raw === undefined || raw === null || raw === '';

    if (absent) {
      if (field.isRequired) {
        rejections.push({ field: field.key, message: `${field.name} is required.` });
      }
      // A cleared optional field is written as an all-null row rather than left out, so that
      // "never set" and "deliberately cleared" are the same observable state. They are: the
      // document has no value for the field either way, and pretending otherwise would need a
      // third state nothing renders.
      values.set(field.id, EMPTY_COLUMNS);
      continue;
    }

    const coerced = coerceOne(field, raw);
    if ('message' in coerced) {
      rejections.push({ field: field.key, message: coerced.message });
      continue;
    }
    values.set(field.id, coerced);
  }

  // A field that is not on the document's type is not a field this document has. Reported rather
  // than dropped: a caller sending `priority` to a type with no such field has a bug or an
  // out-of-date form, and silently discarding it means the value is gone and nothing said so.
  const known = new Set(fields.map((field) => field.key));
  for (const key of Object.keys(supplied)) {
    if (!known.has(key)) {
      rejections.push({ field: key, message: 'That field is not on this document type.' });
    }
  }

  return { values, rejections };
}

function coerceOne(
  field: FieldDefinition,
  raw: MetadataInputValue,
): MetadataColumns | { readonly message: string } {
  switch (field.dataType) {
    case MetadataDataType.TEXT:
    case MetadataDataType.LONG_TEXT: {
      if (typeof raw !== 'string') {
        return { message: `${field.name} must be text.` };
      }
      const text = raw.trim();
      const { minLength, maxLength, pattern } = field.validation;
      if (minLength !== undefined && text.length < minLength) {
        return { message: `${field.name} must be at least ${String(minLength)} characters.` };
      }
      if (maxLength !== undefined && text.length > maxLength) {
        return { message: `${field.name} must be at most ${String(maxLength)} characters.` };
      }
      if (pattern !== undefined && !safeMatch(pattern, text)) {
        return { message: `${field.name} is not in the expected format.` };
      }
      return { ...EMPTY_COLUMNS, textValue: text };
    }

    case MetadataDataType.NUMBER: {
      // A string is accepted because an HTML form posts one, and refusing it would make the web
      // client responsible for a conversion the API is better placed to check. What is not
      // accepted is a string that is not a number — that is the coercion this refuses.
      const value =
        typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
      if (!Number.isFinite(value)) {
        return { message: `${field.name} must be a number.` };
      }
      const { min, max } = field.validation;
      if (min !== undefined && value < min) {
        return { message: `${field.name} must be at least ${String(min)}.` };
      }
      if (max !== undefined && value > max) {
        return { message: `${field.name} must be at most ${String(max)}.` };
      }
      // Stored as a string on the way to a `numeric` column: a float64 cannot hold every value a
      // `decimal(38,10)` can, and rounding somebody's quantity on the way in is exactly the silent
      // corruption typed columns exist to avoid.
      return { ...EMPTY_COLUMNS, numberValue: String(value) };
    }

    case MetadataDataType.DATE: {
      if (typeof raw !== 'string') {
        return { message: `${field.name} must be a date.` };
      }
      const date = parseDate(raw);
      if (date === null) {
        return { message: `${field.name} must be a date.` };
      }
      return { ...EMPTY_COLUMNS, dateValue: date };
    }

    case MetadataDataType.BOOLEAN: {
      if (typeof raw === 'boolean') {
        return { ...EMPTY_COLUMNS, booleanValue: raw };
      }
      // The four spellings a form legitimately sends, and nothing else. JavaScript truthiness is
      // wrong here in the way it is wrong everywhere: `Boolean('false')` is `true`.
      if (raw === 'true' || raw === '1') {
        return { ...EMPTY_COLUMNS, booleanValue: true };
      }
      if (raw === 'false' || raw === '0') {
        return { ...EMPTY_COLUMNS, booleanValue: false };
      }
      return { message: `${field.name} must be yes or no.` };
    }

    case MetadataDataType.SELECT: {
      if (typeof raw !== 'string' || !field.options.includes(raw)) {
        return { message: `${field.name} must be one of the options offered.` };
      }
      return { ...EMPTY_COLUMNS, textValue: raw };
    }

    case MetadataDataType.MULTI_SELECT: {
      if (!Array.isArray(raw)) {
        return { message: `${field.name} must be a list of options.` };
      }
      const chosen = raw.filter((option): option is string => typeof option === 'string');
      if (chosen.length !== raw.length) {
        return { message: `${field.name} must be a list of options.` };
      }
      const unknown = chosen.filter((option) => !field.options.includes(option));
      if (unknown.length > 0) {
        return { message: `${field.name} does not offer ${unknown.join(', ')}.` };
      }
      // Deduplicated and ordered by the field's own option order, so two documents with the same
      // selections compare equal and a filter does not have to care what order somebody clicked in.
      const unique = field.options.filter((option) => chosen.includes(option));
      return { ...EMPTY_COLUMNS, selectValues: unique };
    }

    case MetadataDataType.USER:
    case MetadataDataType.DEPARTMENT: {
      if (typeof raw !== 'string' || !UUID.test(raw)) {
        return { message: `${field.name} must name a ${field.dataType.toLowerCase()}.` };
      }
      // That the identifier *exists* is checked by the service, which can ask the owning module.
      // Shape is decidable here; existence is not, and pretending otherwise would put a database
      // call in the domain layer.
      return { ...EMPTY_COLUMNS, referenceValue: raw };
    }
  }
}

/** What a stored row means, on the way back out. The inverse of `coerceOne`. */
export function readMetadata(
  dataType: MetadataDataTypeKey,
  columns: MetadataColumns,
): MetadataInputValue {
  switch (dataType) {
    case MetadataDataType.TEXT:
    case MetadataDataType.LONG_TEXT:
    case MetadataDataType.SELECT:
      return columns.textValue;
    case MetadataDataType.NUMBER:
      return columns.numberValue === null ? null : Number(columns.numberValue);
    case MetadataDataType.DATE:
      return columns.dateValue === null ? null : columns.dateValue.toISOString();
    case MetadataDataType.BOOLEAN:
      return columns.booleanValue;
    case MetadataDataType.MULTI_SELECT:
      return [...columns.selectValues];
    case MetadataDataType.USER:
    case MetadataDataType.DEPARTMENT:
      return columns.referenceValue;
  }
}

/** The field kinds whose value is an identifier the service has to resolve. */
export function referenceFieldsIn(
  fields: readonly FieldDefinition[],
  values: ReadonlyMap<string, MetadataColumns>,
): readonly { readonly field: FieldDefinition; readonly id: string }[] {
  return fields
    .filter(
      (field) =>
        field.dataType === MetadataDataType.USER || field.dataType === MetadataDataType.DEPARTMENT,
    )
    .flatMap((field) => {
      const id = values.get(field.id)?.referenceValue;
      return id === undefined || id === null ? [] : [{ field, id }];
    });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A date, from either of the two spellings a client sends.
 *
 * `2026-08-04` is what a date input posts and means midnight UTC; a full timestamp is what an
 * integration sends. Anything else is refused rather than handed to `new Date()`, which parses an
 * alarming range of strings into plausible-looking wrong answers — `new Date('QA-014')` is not an
 * error, it is `Invalid Date`, and `new Date('2026')` is a valid date nobody meant.
 */
function parseDate(raw: string): Date | null {
  const value = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/**
 * A tenant's own pattern, applied with a bound on the input rather than on the expression.
 *
 * Administration compiles the pattern at save time, so it is a valid expression — but a valid
 * expression can still backtrack catastrophically on a long input, and the input here is whatever
 * somebody typed into a form. Capping the length is the cheap half of the defence and the half
 * that does not require rewriting the tenant's regular expression for them.
 */
function safeMatch(pattern: string, value: string): boolean {
  if (value.length > 4096) {
    return false;
  }
  return new RegExp(pattern).test(value);
}
