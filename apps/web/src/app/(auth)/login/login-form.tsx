'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

import { Alert, Button, Field, Input } from '@munaxa/ui';

import type { MessageKey } from '@edms/i18n';

import { useTranslate } from '../../providers';
import { type SignInFormState, signInAction } from './actions';

/**
 * The form's state before the first attempt.
 *
 * Here rather than beside the action, and that is a defect fix rather than a preference — see the
 * Phase 6.6 report. A `'use server'` module may export **async functions only**: Next turns every
 * export into a callable server reference, and a plain object cannot be one. Exported from
 * `actions.ts`, as it was from Phase 14 until now, the production build refused the module at
 * runtime and `/login` answered `500` — so sign-in was broken in every built deployment while the
 * whole test suite stayed green. Nothing below the login page could see it, because nothing below
 * the login page boots the application.
 */
const EMPTY_FORM_STATE: SignInFormState = { reason: null };

const REASON_MESSAGE: Record<string, MessageKey> = {
  REJECTED: 'auth.signInRejected',
  UNAVAILABLE: 'auth.signInUnavailable',
  MFA_REQUIRED: 'auth.mfaRequired',
};

/**
 * The sign-in form.
 *
 * A plain `<form>` bound to a server action, so it submits and works before — and without —
 * hydration. The credentials never pass through client JavaScript, and neither do the tokens
 * that come back: both stay between the form post and the server.
 *
 * There is deliberately no client-side validation of the password beyond "not empty". The
 * password policy governs what may be *set*; enforcing it here would reject someone whose
 * existing password predates the current rules, and would tell an attacker which candidate
 * strings are worth trying.
 */
export function LoginForm({ next }: { next: string }): React.ReactNode {
  const translate = useTranslate();
  const [state, action] = useActionState<SignInFormState, FormData>(signInAction, EMPTY_FORM_STATE);

  return (
    <form action={action} className="flex flex-col gap-6" noValidate>
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{translate('auth.signInHeading')}</h1>
        <p className="text-muted-foreground text-sm">{translate('auth.signInSubheading')}</p>
      </header>

      {state.reason ? (
        // `alert` rather than `status`: a failed sign-in is something the person must act on
        // now, and it is the only reason this region ever renders.
        <Alert tone="danger" live="alert">
          {translate(REASON_MESSAGE[state.reason] ?? 'auth.signInRejected')}
        </Alert>
      ) : null}

      <input type="hidden" name="next" value={next} />

      <Field label={translate('auth.emailLabel')} required>
        <Input
          name="email"
          type="email"
          autoComplete="username"
          required
          // The first field of the only form on the page: focusing it saves a keystroke and
          // costs nothing, because there is nothing else here to skip past.
          autoFocus
        />
      </Field>

      <Field label={translate('auth.passwordLabel')} required>
        <Input name="password" type="password" autoComplete="current-password" required />
      </Field>

      {state.mfaRequired === true ? (
        <Field label={translate('auth.mfaCodeLabel')} hint={translate('auth.mfaCodeHint')} required>
          <Input
            name="mfaCode"
            // `one-time-code` so a password manager and an SMS autofill both offer the right thing,
            // and `inputMode` so a phone shows digits — a six-digit field behind a QWERTY keyboard
            // is the most-reported friction in every MFA rollout.
            autoComplete="one-time-code"
            inputMode="numeric"
            spellCheck={false}
            required
            autoFocus
          />
        </Field>
      ) : null}

      <Field label={translate('auth.organisationLabel')} hint={translate('auth.organisationHint')}>
        {/* Optional: on a tenant subdomain the API reads it from the host. It is here for the
            shared hostname a development or single-tenant deployment uses. */}
        <Input name="tenant" autoComplete="organization" spellCheck={false} />
      </Field>

      <SubmitButton />
    </form>
  );
}

/**
 * Split out because `useFormStatus` reports the status of the form it is rendered *inside*.
 * Called from `LoginForm` itself it would always report idle.
 */
function SubmitButton(): React.ReactNode {
  const translate = useTranslate();
  const { pending } = useFormStatus();

  return (
    <Button type="submit" disabled={pending}>
      {pending ? translate('auth.signingIn') : translate('auth.signIn')}
    </Button>
  );
}
