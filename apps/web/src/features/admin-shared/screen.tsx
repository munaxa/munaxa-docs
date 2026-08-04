'use client';

import type { ReactNode } from 'react';

import { Alert, ErrorState, Page, PageHeader, Stack } from '@munaxa/ui';

import type { MessageKey } from '@edms/i18n';

import { useTranslate } from '../../app/providers';

/**
 * The frame every administration screen sits in: a heading, a sentence about what the area is for,
 * and the list beneath it.
 *
 * The sentence is not filler. "A location. Its code appears in document numbers, but permission does
 * not flow through it" is the difference between an administrator putting a department under a branch
 * and understanding why they cannot.
 */
export function AdminScreen({
  titleKey,
  descriptionKey,
  actions,
  children,
}: {
  titleKey: MessageKey;
  descriptionKey: MessageKey;
  actions?: ReactNode;
  children: ReactNode;
}): ReactNode {
  const translate = useTranslate();
  return (
    <Page gap={6}>
      <PageHeader
        title={translate(titleKey)}
        description={translate(descriptionKey)}
        {...(actions !== undefined && { actions })}
      />
      <Stack gap={4}>{children}</Stack>
    </Page>
  );
}

/**
 * What an administration page renders when the caller does not hold its permission.
 *
 * Stated plainly rather than dressed as an error. Nothing went wrong: somebody followed a link to an
 * area their roles do not cover, and the useful thing to tell them is which sentence to take to
 * whoever grants roles.
 */
export function AdminForbidden(): ReactNode {
  const translate = useTranslate();
  return (
    <Page gap={6}>
      <ErrorState title={translate('auth.forbidden')} description={translate('admin.subtitle')} />
    </Page>
  );
}

/**
 * A note that this area cannot be used yet because something it depends on does not exist.
 *
 * Stated at the top of the screen rather than discovered inside the form. An entity needs a company,
 * a document type needs both a numbering rule and a confidentiality level; a picker with no options
 * in a dialogue that cannot be submitted tells somebody they are stuck without telling them why.
 */
export function Prerequisite({ nameKey }: { nameKey: MessageKey }): ReactNode {
  const translate = useTranslate();
  return (
    <Alert tone="warning">
      {translate('admin.list.needsPrerequisite', { name: translate(nameKey) })}
    </Alert>
  );
}
