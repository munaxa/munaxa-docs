'use client';

import { type ReactNode } from 'react';

import type { MetadataDataTypeKey } from '@edms/domain';

import {
  type Choice,
  CheckboxGroupField,
  NumberField,
  PickerField,
  SelectField,
  SwitchField,
  TextAreaField,
  TextField,
} from '../admin-shared';

/**
 * A document type's own fields, rendered from its definition.
 *
 * This is the one form in the product whose shape is **data**: a tenant defines the fields, and the
 * type decides which of them a document carries. Everything else in `admin-shared` renders a form
 * somebody wrote; this renders one somebody configured.
 *
 * It is composed from the shared field set rather than reimplementing controls, which is what keeps
 * a configured `SELECT` looking and behaving like a hand-written one — same label association, same
 * hidden-input mirroring, same `FormData` shape. The only thing added here is the mapping from a
 * data type to the control that fits it, and that mapping is exhaustive by the compiler: a new
 * `MetadataDataType` is a build error here rather than a field that silently renders as text.
 *
 * Every control posts under `metadata.<key>`, so a caller reads a whole document type's worth of
 * values out of one `FormData` without knowing what the type declared.
 */
export interface MetadataFieldDefinition {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly dataType: MetadataDataTypeKey;
  readonly isRequired: boolean;
  readonly options: readonly Choice[];
  readonly description: string | null;
  /** Pre-filled on a new document. Stored as text and parsed against the field's own type. */
  readonly defaultValue: string | null;
}

/** The `name` a field posts under. One convention, two readers — this file and `readMetadata`. */
export const METADATA_PREFIX = 'metadata.';

export function metadataName(key: string): string {
  return `${METADATA_PREFIX}${key}`;
}

/**
 * Everything a document type declares, in the order it declares it.
 *
 * The order is the type's, because it is the order the person who configured it chose — and the
 * order somebody tabs through a form is part of what makes a fifteen-field type usable.
 */
export function MetadataFields({
  fields,
  values,
  userChoices,
  departmentChoices,
}: {
  readonly fields: readonly MetadataFieldDefinition[];
  /** Existing values, when editing. Absent for a new document. */
  readonly values?: Readonly<Record<string, unknown>> | undefined;
  readonly userChoices: readonly Choice[];
  readonly departmentChoices: readonly Choice[];
}): ReactNode {
  return (
    <>
      {fields.map((field) => (
        <MetadataField
          key={field.id}
          field={field}
          value={values?.[field.key]}
          userChoices={userChoices}
          departmentChoices={departmentChoices}
        />
      ))}
    </>
  );
}

function MetadataField({
  field,
  value,
  userChoices,
  departmentChoices,
}: {
  readonly field: MetadataFieldDefinition;
  readonly value: unknown;
  readonly userChoices: readonly Choice[];
  readonly departmentChoices: readonly Choice[];
}): ReactNode {
  const name = metadataName(field.key);
  const common = {
    name,
    label: field.name,
    required: field.isRequired,
    ...(field.description !== null && { hint: field.description }),
  };
  // The stored value when there is one, the type's default when there is not. `??` rather than `||`
  // because `false` and `0` are values somebody chose.
  const initial = value ?? field.defaultValue ?? undefined;

  switch (field.dataType) {
    case 'TEXT':
      return <TextField {...common} defaultValue={asText(initial)} />;

    case 'LONG_TEXT':
      return <TextAreaField {...common} defaultValue={asText(initial)} />;

    case 'NUMBER':
      return (
        <NumberField
          {...common}
          {...(typeof initial === 'number' ? { defaultValue: initial } : {})}
        />
      );

    case 'DATE':
      // A native date input, which posts `YYYY-MM-DD` — one of the two spellings the API accepts,
      // and the one every browser and every mobile keyboard already knows how to enter. `TextField`
      // grew the type for this rather than a second control being written beside it.
      return <TextField {...common} type="date" defaultValue={asDate(initial)} />;

    case 'BOOLEAN':
      // A switch rather than a checkbox: a checkbox posts nothing when unchecked, so turning a
      // field *off* would be indistinguishable from leaving it alone in a PATCH.
      return <SwitchField {...common} defaultChecked={initial === true} />;

    case 'SELECT':
      return (
        <SelectField
          {...common}
          defaultValue={asText(initial)}
          choices={field.options}
          // Present makes it clearable; a required field gets no empty option, so the browser's own
          // validation refuses a submission with nothing chosen.
          {...(field.isRequired ? {} : { emptyLabel: '—' })}
        />
      );

    case 'MULTI_SELECT':
      return (
        <CheckboxGroupField
          {...common}
          defaultValue={Array.isArray(initial) ? initial.filter(isText) : []}
          choices={field.options}
        />
      );

    case 'USER':
      // A searching picker, not a select: an organisation has hundreds of people and a dropdown of
      // hundreds is a dropdown nobody can use.
      return (
        <PickerField {...common} defaultValue={asText(initial)} options={userChoices} clearable />
      );

    case 'DEPARTMENT':
      return (
        <PickerField
          {...common}
          defaultValue={asText(initial)}
          options={departmentChoices}
          clearable
        />
      );
  }
}

/**
 * Reads a document type's fields out of a submission.
 *
 * Absent keys are omitted rather than sent as empty strings, except where a field was rendered and
 * left blank — which is a *clear*, and the API distinguishes the two. The shape is exactly what
 * `metadataInputSchema` accepts, so what the form builds is what the contract validates.
 */
export function readMetadata(
  data: FormData,
  fields: readonly MetadataFieldDefinition[],
): Record<string, string | number | boolean | string[] | null> {
  const values: Record<string, string | number | boolean | string[] | null> = {};
  for (const field of fields) {
    const name = metadataName(field.key);
    switch (field.dataType) {
      case 'MULTI_SELECT': {
        values[field.key] = data
          .getAll(name)
          .filter(isText)
          .map((value) => value.trim());
        break;
      }
      case 'BOOLEAN': {
        values[field.key] = readText(data, name) === 'true';
        break;
      }
      case 'NUMBER': {
        const raw = readText(data, name);
        // Sent as a string when it is not a number, so the API refuses it and says which field —
        // rather than this quietly dropping the value the person typed.
        values[field.key] = raw === '' ? null : Number.isNaN(Number(raw)) ? raw : Number(raw);
        break;
      }
      default: {
        const raw = readText(data, name);
        values[field.key] = raw === '' ? null : raw;
      }
    }
  }
  return values;
}

function readText(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asDate(value: unknown): string | undefined {
  // The API returns a full timestamp; a date input takes the day. Trimming here rather than at the
  // API is right: the stored value genuinely is an instant, and only this control needs less.
  return typeof value === 'string' ? value.slice(0, 10) : undefined;
}
