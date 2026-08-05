'use client';

import { type ReactNode, useId, useState } from 'react';

import {
  Checkbox,
  Combobox,
  type ComboboxOption,
  Field,
  Input,
  MultiSelect,
  Select,
  Switch,
  Textarea,
} from '@munaxa/ui';

import { useTranslate } from '../../app/providers';

/**
 * The form controls Administration is built from, each wired to a `<Field>` and a `name`.
 *
 * Two things are shared by all of them, and both are the reason this file exists rather than each
 * screen assembling `Field` and `Input` itself. The label and the control are associated by a
 * generated id, so clicking a label focuses its control and a screen reader announces the pair —
 * eighteen screens doing that by hand is eighteen chances to forget. And every control posts into
 * `FormData` under `name`, including the ones that are not native inputs: a `Switch` has no form
 * value of its own, so it mirrors itself into a hidden input rather than being read from React state
 * the submit handler cannot see.
 */

interface Common {
  readonly name: string;
  readonly label: string;
  readonly hint?: string | undefined;
  readonly required?: boolean | undefined;
  readonly disabled?: boolean | undefined;
}

export function TextField({
  name,
  label,
  hint,
  required,
  disabled,
  defaultValue,
  maxLength,
  pattern,
  placeholder,
  type = 'text',
  readOnly,
}: Common & {
  readonly defaultValue?: string | undefined;
  readonly maxLength?: number | undefined;
  readonly pattern?: string | undefined;
  readonly placeholder?: string | undefined;
  /**
   * `date` was added by Phase 3, for a tenant-defined metadata field of that type.
   *
   * A native date input rather than a picker component: it posts `YYYY-MM-DD`, which is one of the
   * two spellings the API accepts, and every browser and every mobile keyboard already knows how to
   * enter one. A JavaScript calendar would be a worse control that also has to be localised.
   *
   * `datetime-local` was added by Phase 11, for a delegation's period. A delegation is bounded to
   * an *instant* rather than a day — "until Friday" is ambiguous by up to twenty-four hours, and
   * an authority that lingers for a day longer than somebody meant is the wrong side to be
   * ambiguous on. It posts without a zone, so the value is read as the browser's own time, which
   * is the time the person typing it meant.
   */
  readonly type?: 'text' | 'email' | 'password' | 'date' | 'datetime-local';
  readonly readOnly?: boolean | undefined;
}): ReactNode {
  const id = useId();
  return (
    <Field
      label={label}
      htmlFor={id}
      {...(hint !== undefined && { hint })}
      {...(required !== undefined && { required })}
      {...(readOnly !== undefined && { readOnly })}
    >
      <Input
        id={id}
        name={name}
        type={type}
        defaultValue={defaultValue}
        required={required}
        disabled={disabled}
        readOnly={readOnly}
        maxLength={maxLength}
        pattern={pattern}
        placeholder={placeholder}
      />
    </Field>
  );
}

export function NumberField({
  name,
  label,
  hint,
  required,
  disabled,
  defaultValue,
  minimum,
  maximum,
}: Common & {
  readonly defaultValue?: number | undefined;
  readonly minimum?: number | undefined;
  readonly maximum?: number | undefined;
}): ReactNode {
  const id = useId();
  return (
    <Field
      label={label}
      htmlFor={id}
      {...(hint !== undefined && { hint })}
      {...(required !== undefined && { required })}
    >
      <Input
        id={id}
        name={name}
        type="number"
        inputMode="numeric"
        defaultValue={defaultValue === undefined ? '' : String(defaultValue)}
        required={required}
        disabled={disabled}
        min={minimum}
        max={maximum}
        step={1}
      />
    </Field>
  );
}

export function TextAreaField({
  name,
  label,
  hint,
  required,
  disabled,
  defaultValue,
  maxLength = 2000,
  rows = 3,
}: Common & {
  readonly defaultValue?: string | undefined;
  readonly maxLength?: number | undefined;
  readonly rows?: number | undefined;
}): ReactNode {
  const id = useId();
  return (
    <Field
      label={label}
      htmlFor={id}
      {...(hint !== undefined && { hint })}
      {...(required !== undefined && { required })}
    >
      <Textarea
        id={id}
        name={name}
        rows={rows}
        maxLength={maxLength}
        defaultValue={defaultValue}
        required={required}
        disabled={disabled}
      />
    </Field>
  );
}

export interface Choice {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

/**
 * A short, closed list — a trigger, a disposition, a revision style.
 *
 * A native `<select>` rather than a `Combobox`: the values are a handful of product-defined
 * alternatives with no searching to do, and a native control is the one every assistive technology
 * and every mobile keyboard already knows.
 */
export function SelectField({
  name,
  label,
  hint,
  required,
  disabled,
  defaultValue,
  choices,
  emptyLabel,
  value,
  onValueChange,
}: Common & {
  readonly defaultValue?: string | undefined;
  readonly choices: readonly Choice[];
  /** The "none" option's label. Present makes the field nullable; absent makes it required. */
  readonly emptyLabel?: string | undefined;
  /**
   * Controlled value, for the rare select whose answer decides which *other* fields are rendered —
   * a library's owner kind, a metadata field's data type. Every other select on every other form is
   * uncontrolled, which is what keeps `FormData` the single way a submission is read.
   */
  readonly value?: string | undefined;
  readonly onValueChange?: ((value: string) => void) | undefined;
}): ReactNode {
  const id = useId();
  const controlled = value !== undefined && onValueChange !== undefined;
  return (
    <Field
      label={label}
      htmlFor={id}
      {...(hint !== undefined && { hint })}
      {...(required !== undefined && { required })}
    >
      <Select
        id={id}
        name={name}
        {...(controlled
          ? {
              value,
              onChange: (event: { currentTarget: HTMLSelectElement }) => {
                onValueChange(event.currentTarget.value);
              },
            }
          : { defaultValue: defaultValue ?? '' })}
        required={required}
        disabled={disabled}
      >
        {emptyLabel === undefined ? null : <option value="">{emptyLabel}</option>}
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value} disabled={choice.disabled}>
            {choice.label}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/**
 * A long list that has to be searched — a department out of hundreds, a document type out of dozens.
 *
 * Controlled, so it mirrors into a hidden input to reach `FormData`.
 */
export function PickerField({
  name,
  label,
  hint,
  required,
  disabled,
  defaultValue,
  options,
  placeholder,
  clearable,
}: Common & {
  readonly defaultValue?: string | undefined;
  readonly options: readonly ComboboxOption[];
  readonly placeholder?: string | undefined;
  readonly clearable?: boolean | undefined;
}): ReactNode {
  const translate = useTranslate();
  const id = useId();
  const [value, setValue] = useState(defaultValue ?? '');

  return (
    <Field
      label={label}
      htmlFor={id}
      {...(hint !== undefined && { hint })}
      {...(required !== undefined && { required })}
    >
      <>
        <Combobox
          id={id}
          options={[...options]}
          value={value}
          onChange={setValue}
          {...(disabled !== undefined && { disabled })}
          {...(clearable !== undefined && { clearable })}
          labels={{
            ...(placeholder !== undefined && { placeholder }),
            searchPlaceholder: translate('admin.list.search'),
            empty: translate('admin.list.empty'),
            clear: translate('admin.actions.cancel'),
          }}
        />
        <input type="hidden" name={name} value={value} />
      </>
    </Field>
  );
}

/** Several out of a list — the roles a person holds, the document types a workflow serves. */
export function MultiPickerField({
  name,
  label,
  hint,
  disabled,
  defaultValue = [],
  options,
  placeholder,
}: Common & {
  readonly defaultValue?: readonly string[] | undefined;
  readonly options: readonly ComboboxOption[];
  readonly placeholder?: string | undefined;
}): ReactNode {
  const translate = useTranslate();
  const id = useId();
  const [values, setValues] = useState<string[]>([...defaultValue]);

  return (
    <Field label={label} htmlFor={id} {...(hint !== undefined && { hint })}>
      <>
        <MultiSelect
          id={id}
          options={[...options]}
          value={values}
          onChange={setValues}
          {...(disabled !== undefined && { disabled })}
          labels={{
            ...(placeholder !== undefined && { placeholder }),
            searchPlaceholder: translate('admin.list.search'),
            empty: translate('admin.list.empty'),
          }}
        />
        {/*
          One input per value rather than a joined string: `FormData.getAll` then returns the list,
          and no reader has to know which character the writer chose as a separator.
        */}
        {values.map((value) => (
          <input key={value} type="hidden" name={name} value={value} />
        ))}
      </>
    </Field>
  );
}

/**
 * A yes-or-no policy — "downloading allowed", "watermark previews".
 *
 * Always posts a value, unlike a checkbox, which posts nothing when unchecked. A `PATCH` that omits
 * a field means "leave it alone", so a checkbox turned *off* would silently fail to turn anything
 * off — the single most likely defect in a settings form, and this is what prevents it.
 */
export function SwitchField({
  name,
  label,
  hint,
  disabled,
  defaultChecked = false,
}: Common & { readonly defaultChecked?: boolean | undefined }): ReactNode {
  const id = useId();
  const [checked, setChecked] = useState(defaultChecked);

  return (
    <Field label={label} htmlFor={id} {...(hint !== undefined && { hint })}>
      <>
        <Switch
          id={id}
          checked={checked}
          onCheckedChange={setChecked}
          {...(disabled !== undefined && { disabled })}
        />
        <input type="hidden" name={name} value={checked ? 'true' : 'false'} />
      </>
    </Field>
  );
}

/** One of many, where the reader needs to see every option at once — a reset scope, a permission. */
export function CheckboxGroupField({
  name,
  label,
  hint,
  disabled,
  defaultValue = [],
  choices,
}: Common & {
  readonly defaultValue?: readonly string[] | undefined;
  readonly choices: readonly Choice[];
}): ReactNode {
  return (
    <Field label={label} {...(hint !== undefined && { hint })}>
      <div className="grid gap-2 sm:grid-cols-2">
        {choices.map((choice) => (
          <Checkbox
            key={choice.value}
            name={name}
            value={choice.value}
            defaultChecked={defaultValue.includes(choice.value)}
            disabled={disabled === true || choice.disabled === true}

            label={choice.label}
          />
        ))}
      </div>
    </Field>
  );
}

// --- Reading a submission -----------------------------------------------------------------

/**
 * Readers for `FormData`.
 *
 * `FormData` values are `string | File`, and every one of these narrows rather than casts: a field
 * that did not arrive, or arrived as a file because somebody changed an input's type, is `undefined`
 * here instead of the string `"[object File]"` reaching the API.
 */
export function text(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/** Empty means "not given" — an optional description left blank is absent, not `""`. */
export function optionalText(data: FormData, name: string): string | undefined {
  const value = text(data, name);
  return value === '' ? undefined : value;
}

/** Empty means null — clearing an optional field is a change, and `PATCH` needs it stated. */
export function nullableText(data: FormData, name: string): string | null {
  const value = text(data, name);
  return value === '' ? null : value;
}

export function integer(data: FormData, name: string): number | undefined {
  const value = text(data, name);
  if (value === '') {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function flag(data: FormData, name: string): boolean {
  return text(data, name) === 'true';
}

export function list(data: FormData, name: string): string[] {
  return data
    .getAll(name)
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    .map((value) => value.trim());
}
