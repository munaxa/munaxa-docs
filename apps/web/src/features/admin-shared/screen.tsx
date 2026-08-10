'use client';

import type { ReactNode } from 'react';

import { useRouter } from 'next/navigation';

import { Alert, Button, ErrorState, Page, PageHeader, Stack } from '@munaxa/ui';

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
 * What a page renders when the API refused one of its reads with `429 RATE_LIMITED` — Phase 7.1C.
 *
 * A rate limit is the one API refusal that is *neither* a fault nor a permission decision: the
 * request was correct, the caller is who they say they are, and the same request succeeds again in
 * under a minute. Left to escape, it reaches the route error boundary, and the reader is told
 * "Something went wrong. The problem has been recorded." — which is untrue twice over. Nothing went
 * wrong, and there is nothing for anybody to record.
 *
 * The product already draws this distinction on the client: `RATE_LIMITED` is in the API's
 * `RETRYABLE_ERROR_CODES`, and the signing ceremony renders it as a wait-and-retry state rather than
 * a failure. This is the same answer for a server render, and the same shape `AdminForbidden` uses
 * for the other refusal a page can honestly draw.
 *
 * `router.refresh()` rather than an automatic retry: retrying on the reader's behalf would spend
 * more of the budget that is already spent, and hiding a limit is how a limit stops working. The
 * button is there for when they choose to.
 */
export function RateLimited(): ReactNode {
  const translate = useTranslate();
  const router = useRouter();
  return (
    <Page gap={6}>
      <ErrorState
        title={translate('state.rateLimited')}
        // The API's own sentence, from the catalogue the problem detail is translated with, so the
        // browser says exactly what the server said.
        description={translate('error.RATE_LIMITED')}
        action={
          <Button
            onClick={() => {
              router.refresh();
            }}
            variant="secondary"
          >
            {translate('state.retry')}
          </Button>
        }
      />
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
