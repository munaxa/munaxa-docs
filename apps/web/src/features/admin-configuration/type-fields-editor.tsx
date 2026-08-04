'use client';

import { type ReactNode, useState } from 'react';

import { Button, Checkbox, Field, Input, Select } from '@munaxa/ui';

import type { DocumentType } from '@edms/contracts';

import { useTranslate } from '../../app/providers';
import type { Choice } from '../admin-shared';

interface Attachment {
  metadataFieldId: string;
  isRequired: boolean;
  sortOrder: number;
  defaultValue: string;
}

/**
 * The fields attached to a document type.
 *
 * An attachment is not a field. The field says what "Reviewer" *is*; the attachment says that this
 * type has one, that it is required here, where it sits on the form and what it is pre-filled with.
 * That split is why one field definition can mean the same thing on six types with different rules.
 *
 * `sortOrder` is explicit rather than taken from the array position, because it is the API's contract
 * and because a type's fields are rendered by other screens that read the number rather than the
 * order rows happened to arrive in.
 */
export function TypeFieldsEditor({
  fields,
  defaultValue,
}: {
  fields: readonly Choice[];
  defaultValue: DocumentType['fields'];
}): ReactNode {
  const translate = useTranslate();
  const [attachments, setAttachments] = useState<Attachment[]>(
    defaultValue.map((attachment, index) => ({
      metadataFieldId: attachment.metadataFieldId,
      isRequired: attachment.isRequired,
      sortOrder: attachment.sortOrder === 0 ? index : attachment.sortOrder,
      defaultValue: attachment.defaultValue ?? '',
    })),
  );

  const chosen = new Set(attachments.map((attachment) => attachment.metadataFieldId));

  return (
    <Field
      label={translate('admin.documentTypes.fields')}
      hint={translate('admin.documentTypes.changesAffectFutureOnly')}
    >
      <div className="flex flex-col gap-2">
        {attachments.map((attachment, index) => (
          <div key={index} className="flex flex-wrap items-center gap-2">
            <Select
              aria-label={translate('admin.metadataFields.one')}
              value={attachment.metadataFieldId}
              className="min-w-40 flex-1"
              onChange={(event) => {
                replace(index, { ...attachment, metadataFieldId: event.currentTarget.value });
              }}
            >
              <option value="">{translate('admin.list.filterAny')}</option>
              {fields
                // A field already attached is not offered again: two attachments of one field to one
                // type is a duplicate the database refuses, and there is nothing it could mean.
                .filter(
                  (field) => field.value === attachment.metadataFieldId || !chosen.has(field.value),
                )
                .map((field) => (
                  <option key={field.value} value={field.value}>
                    {field.label}
                  </option>
                ))}
            </Select>
            <Input
              type="number"
              aria-label={translate('admin.documentTypes.fieldOrder')}
              value={String(attachment.sortOrder)}
              min={0}
              max={1000}
              className="w-20"
              onChange={(event) => {
                replace(index, {
                  ...attachment,
                  sortOrder: Number.parseInt(event.currentTarget.value, 10) || 0,
                });
              }}
            />
            <Input
              aria-label={translate('admin.documentTypes.fieldDefault')}
              placeholder={translate('admin.documentTypes.fieldDefault')}
              value={attachment.defaultValue}
              maxLength={2000}
              className="w-40"
              onChange={(event) => {
                replace(index, { ...attachment, defaultValue: event.currentTarget.value });
              }}
            />
            <Checkbox
              checked={attachment.isRequired}
              label={translate('admin.documentTypes.fieldRequired')}
              onChange={(event) => {
                replace(index, { ...attachment, isRequired: event.currentTarget.checked });
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={translate('admin.actions.delete')}
              onClick={() => {
                setAttachments(attachments.filter((_, position) => position !== index));
              }}
            >
              <span aria-hidden>✕</span>
            </Button>
            {/*
              Four parallel lists, read back by index. A row with no field chosen posts an empty
              identifier and is dropped by the submit handler rather than sent as a malformed
              attachment.
            */}
            <input type="hidden" name="typeFieldId" value={attachment.metadataFieldId} />
            <input type="hidden" name="typeFieldOrder" value={String(attachment.sortOrder)} />
            <input type="hidden" name="typeFieldDefault" value={attachment.defaultValue} />
            <input
              type="hidden"
              name="typeFieldRequired"
              value={attachment.isRequired ? 'true' : 'false'}
            />
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={attachments.length >= fields.length}
          onClick={() => {
            setAttachments([
              ...attachments,
              {
                metadataFieldId: '',
                isRequired: false,
                sortOrder: attachments.length,
                defaultValue: '',
              },
            ]);
          }}
        >
          {translate('admin.documentTypes.addField')}
        </Button>
      </div>
    </Field>
  );

  function replace(index: number, next: Attachment): void {
    setAttachments(
      attachments.map((attachment, position) => (position === index ? next : attachment)),
    );
  }
}
