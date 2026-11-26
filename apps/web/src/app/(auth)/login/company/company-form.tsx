'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

import { Alert, Button, Field, Input } from '@munaxa/ui';

import { useTranslate } from '../../../providers';
import { type CompanySignInState, companySignInAction } from './actions';

const EMPTY: CompanySignInState = { reason: null };

/**
 * Sign-in through Munaxa Identity: the work address and the organisation, nothing else. The
 * organisation's own sign-in (Munaxa password, Microsoft or Google, with MFA) happens at Identity.
 */
export function CompanyForm({
  next,
  failed = false,
}: {
  next: string;
  failed?: boolean;
}): React.ReactNode {
  const translate = useTranslate();
  const [state, action] = useActionState<CompanySignInState, FormData>(companySignInAction, EMPTY);
  const message =
    state.reason === 'NOT_OFFERED'
      ? translate('auth.federationNotOffered')
      : state.reason === 'UNAVAILABLE'
        ? translate('auth.signInUnavailable')
        : failed
          ? translate('auth.federationFailed')
          : null;

  return (
    <form action={action} className="flex flex-col gap-6" noValidate>
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{translate('auth.signInWithMunaxa')}</h1>
        <p className="text-muted-foreground text-sm">{translate('auth.signInWithMunaxaHint')}</p>
      </header>

      {message ? (
        <Alert tone={state.reason === 'NOT_OFFERED' ? 'info' : 'danger'} live="alert">
          {message}
        </Alert>
      ) : null}

      <input type="hidden" name="next" value={next} />

      <Field label={translate('auth.emailLabel')} required>
        <Input name="email" type="email" autoComplete="username" required autoFocus />
      </Field>

      <Field
        label={translate('auth.organisationLabel')}
        hint={translate('auth.organisationHint')}
        required
      >
        <Input name="tenant" autoComplete="organization" spellCheck={false} required />
      </Field>

      <Submit />

      <Link className="text-sm underline" href={`/login?next=${encodeURIComponent(next)}` as Route}>
        {translate('auth.signInWithPassword')}
      </Link>
    </form>
  );
}

function Submit(): React.ReactNode {
  const translate = useTranslate();
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? translate('auth.signingIn') : translate('auth.federationContinue')}
    </Button>
  );
}
