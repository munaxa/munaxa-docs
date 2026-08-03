'use client';

import { type ReactNode, useId, useState } from 'react';

import { Button, Field, Input, Select } from '@munaxa/ui';

import type { MetadataField } from '@edms/contracts';
import { MetadataDataType, type MetadataDataTypeKey, requiresOptions } from '@edms/domain';
import type { MessageKey } from '@edms/i18n';

import { useTranslate } from '../../app/providers';
import { NumberField, SwitchField, TextAreaField, TextField } from '../admin-shared';

export const DATA_TYPE_LABELS: Readonly<Record<MetadataDataTypeKey, MessageKey>> = {
  TEXT: 'admin.metadataFields.typeText',
  LONG_TEXT: 'admin.metadataFields.typeLongText',
  NUMBER: 'admin.metadataFields.typeNumber',
  DATE: 'admin.metadataFields.typeDate',
  BOOLEAN: 'admin.metadataFields.typeBoolean',
  SELECT: 'admin.metadataFields.typeSelect',
  MULTI_SELECT: 'admin.metadataFields.typeMultiSelect',
  USER: 'admin.metadataFields.typeUser',
  DEPARTMENT: 'admin.metadataFields.typeDepartment',
};

/**
 * The body of the metadata-field dialogue.
 *
 * Its own component because the type decides what the rest of the form is: a choice field needs
 * options and nothing else, a text field takes lengths and a pattern, a number takes bounds. Rendering
 * all of them and letting the API reject the irrelevant ones would teach an administrator that they
 * had configured something.
 *
 * On an existing field the type is shown and locked. Changing the type of a field documents already
 * carry values for makes every stored value either wrong or unreadable — the value columns are typed,
 * so a `TEXT` value has nowhere to go in a `NUMBER` field. A field of the wrong type is deleted and
 * replaced while it is unused, and the API has no endpoint for anything else.
 */
export function MetadataFieldForm({ field }: { field: MetadataField | null }): ReactNode {
  const translate = useTranslate();
  const dataTypeId = useId();
  const [dataType, setDataType] = useState<MetadataDataTypeKey>(
    field?.dataType ?? MetadataDataType.TEXT,
  );
  const [options, setOptions] = useState<{ value: string; label: string }[]>(
    field === null ? [] : field.options.map((option) => ({ ...option })),
  );

  const needsOptions = requiresOptions(dataType);
  const textual = dataType === MetadataDataType.TEXT || dataType === MetadataDataType.LONG_TEXT;
  const numeric = dataType === MetadataDataType.NUMBER;

  return (
    <>
      {field === null ? (
        <TextField
          name="key"
          label={translate('admin.fields.key')}
          hint={translate('admin.fields.keyHint')}
          maxLength={64}
          required
        />
      ) : (
        <TextField
          name="keyDisplay"
          label={translate('admin.fields.key')}
          defaultValue={field.key}
          readOnly
        />
      )}

      <TextField
        name="name"
        label={translate('admin.fields.name')}
        defaultValue={field?.name}
        maxLength={200}
        required
      />

      {field === null ? (
        <Field label={translate('admin.metadataFields.dataType')} htmlFor={dataTypeId}>
          <Select
            id={dataTypeId}
            name="dataType"
            value={dataType}
            onChange={(event) => {
              const next = event.currentTarget.value as MetadataDataTypeKey;
              setDataType(next);
              // Options belong to a choice field and nothing else. Keeping them across a change to
              // `TEXT` would submit a combination the contract refuses — correctly, since silently
              // ignoring them is how somebody comes to believe they configured a constraint.
              if (!requiresOptions(next)) {
                setOptions([]);
              }
            }}
          >
            {Object.values(MetadataDataType).map((candidate) => (
              <option key={candidate} value={candidate}>
                {translate(DATA_TYPE_LABELS[candidate])}
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        <TextField
          name="dataTypeDisplay"
          label={translate('admin.metadataFields.dataType')}
          hint={translate('admin.metadataFields.typeFixed')}
          defaultValue={translate(DATA_TYPE_LABELS[field.dataType])}
          readOnly
        />
      )}

      <TextAreaField
        name="description"
        label={translate('admin.fields.description')}
        defaultValue={field?.description ?? ''}
      />

      {needsOptions ? (
        <Field label={translate('admin.metadataFields.options')}>
          <div className="flex flex-col gap-2">
            {options.map((option, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  aria-label={translate('admin.metadataFields.optionValue')}
                  placeholder={translate('admin.metadataFields.optionValue')}
                  value={option.value}
                  maxLength={100}
                  onChange={(event) => {
                    replace(index, { ...option, value: event.currentTarget.value });
                  }}
                />
                <Input
                  aria-label={translate('admin.metadataFields.optionLabel')}
                  placeholder={translate('admin.metadataFields.optionLabel')}
                  value={option.label}
                  maxLength={200}
                  onChange={(event) => {
                    replace(index, { ...option, label: event.currentTarget.value });
                  }}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={translate('admin.actions.delete')}
                  onClick={() => {
                    setOptions(options.filter((_, position) => position !== index));
                  }}
                >
                  <span aria-hidden>✕</span>
                </Button>
                {/*
                  Posted as a paired value and label under one index, so the submit handler rebuilds
                  the list in the order it is shown — the order the options appear to whoever fills
                  the field in.
                */}
                <input type="hidden" name="optionValue" value={option.value} />
                <input type="hidden" name="optionLabel" value={option.label} />
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setOptions([...options, { value: '', label: '' }]);
              }}
            >
              {translate('admin.metadataFields.addOption')}
            </Button>
          </div>
        </Field>
      ) : null}

      {textual ? (
        <>
          <NumberField
            name="minLength"
            label={translate('admin.metadataFields.minLength')}
            defaultValue={field?.validation.minLength}
            minimum={0}
            maximum={10_000}
          />
          <NumberField
            name="maxLength"
            label={translate('admin.metadataFields.maxLength')}
            defaultValue={field?.validation.maxLength}
            minimum={1}
            maximum={10_000}
          />
          <TextField
            name="pattern"
            label={translate('admin.metadataFields.pattern')}
            hint={translate('admin.metadataFields.patternHint')}
            defaultValue={field?.validation.pattern ?? ''}
            maxLength={200}
          />
        </>
      ) : null}

      {numeric ? (
        <>
          <NumberField
            name="minimum"
            label={translate('admin.metadataFields.minimum')}
            defaultValue={field?.validation.minimum}
          />
          <NumberField
            name="maximum"
            label={translate('admin.metadataFields.maximum')}
            defaultValue={field?.validation.maximum}
          />
        </>
      ) : null}

      <SwitchField
        name="isSearchable"
        label={translate('admin.metadataFields.searchable')}
        hint={translate('admin.metadataFields.searchableHint')}
        defaultChecked={field?.isSearchable ?? true}
      />
    </>
  );

  function replace(index: number, next: { value: string; label: string }): void {
    setOptions(options.map((option, position) => (position === index ? next : option)));
  }
}
