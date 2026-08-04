'use client';

import { type FormEvent, type ReactNode, useId, useState } from 'react';

import { Alert, Button, Dialog } from '@munaxa/ui';

import { useTranslate } from '../../app/providers';
import type { ActionResult } from '../../lib/admin/action-result';

/**
 * A create-or-edit dialogue over a real `<form>`.
 *
 * The form element is not decoration. It is what makes Enter submit, what makes the browser's own
 * `required` and `max` checks run before a request is made, and what makes `FormData` — rather than
 * a controlled value per field — the natural way to read a submission. Fields that genuinely need
 * to be controlled (a switch, a picker, a sub-editor) mirror themselves into a hidden input, so
 * every screen reads its submission the same way.
 *
 * The submit button lives in the dialogue's footer and reaches the form by `form=`, because the
 * footer is rendered outside the children. That is an HTML feature rather than a workaround: a
 * submit button is associated with a form by id, not by nesting.
 *
 * A failed submission keeps the dialogue open with the server's sentence above the fields. Closing
 * it would throw away what the administrator typed in order to show them an error about it.
 */
export function FormDialog({
  open,
  title,
  description,
  onClose,
  onSubmit,
  onSaved,
  submitLabel,
  children,
}: {
  open: boolean;
  title: string;
  description?: string | undefined;
  onClose: () => void;
  onSubmit: (data: FormData) => Promise<ActionResult<unknown>>;
  /** Called once the write succeeded — where a screen refreshes its list. */
  onSaved: () => void;
  submitLabel?: string | undefined;
  children: ReactNode;
}): ReactNode {
  const translate = useTranslate();
  const formId = useId();
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (!open) {
    return null;
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setProblem(null);
    const result = await onSubmit(new FormData(event.currentTarget));
    setSaving(false);
    if (result.ok) {
      onSaved();
      onClose();
      return;
    }
    setProblem(result.detail ?? translate(`error.${result.code}`));
  }

  return (
    <Dialog
      open
      onClose={() => {
        if (!saving) {
          onClose();
        }
      }}
      title={title}
      {...(description !== undefined && { description })}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            onClick={() => {
              if (!saving) {
                onClose();
              }
            }}
          >
            {translate('admin.actions.cancel')}
          </Button>
          <Button type="submit" form={formId} disabled={saving}>
            {saving
              ? translate('admin.actions.saving')
              : (submitLabel ?? translate('admin.actions.save'))}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate={false}
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        {problem === null ? null : (
          <Alert tone="danger" live="alert">
            {problem}
          </Alert>
        )}
        {children}
      </form>
    </Dialog>
  );
}
