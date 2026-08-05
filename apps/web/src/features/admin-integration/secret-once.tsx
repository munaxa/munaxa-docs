'use client';

import type { ReactNode } from 'react';

import { Alert, Button, Dialog } from '@munaxa/ui';

import { useTranslate } from '../../app/providers';

/**
 * A credential, shown once.
 *
 * Its own component rather than an `Alert` inside each form, because the *behaviour* is the point
 * and it has to be identical wherever a secret is minted: the value exists in this response and in
 * no other, so the dialogue has to be dismissible only by a deliberate act, and it has to say
 * plainly that there is no second chance.
 *
 * Two decisions worth reading:
 *
 * **The value is selectable text rather than a "copy" button alone.** A copy button that silently
 * fails — a non-secure origin, a browser that refuses the clipboard API — leaves somebody with no
 * credential and no idea why, at the one moment they cannot ask for it again. The button is there
 * as a convenience over text that can always be selected.
 *
 * **There is no "show/hide" toggle.** Masking a value the reader has this instant asked to be
 * shown, and which they cannot retrieve later, is ceremony that makes it easier to close the
 * dialogue without ever having read it.
 */
export function SecretOnce({
  open,
  title,
  description,
  secret,
  onClose,
}: {
  open: boolean;
  title: string;
  description: string;
  secret: string;
  onClose: () => void;
}): ReactNode {
  const translate = useTranslate();

  if (!open) {
    return null;
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <Button type="button" onClick={onClose}>
          {translate('admin.integration.secretDismiss')}
        </Button>
      }
    >
      <Alert tone="warning" live="alert">
        {translate('admin.integration.secretWarning')}
      </Alert>
      {/*
        `break-all` rather than a scroll: a credential that runs off the right of a box is a
        credential somebody copies half of. Monospace so an `l` and a `1` are distinguishable by
        anybody reading it aloud.
      */}
      <code className="mt-4 block rounded-md bg-muted p-3 font-mono text-sm break-all select-all">
        {secret}
      </code>
    </Dialog>
  );
}
