'use client';

import { useRouter } from 'next/navigation';
import { type ReactNode, useState } from 'react';

import { Alert, Button, Card, Field, Input, useToast } from '@munaxa/ui';

import { useTranslate } from '../../providers';
import {
  type MfaOffer,
  type MfaStatus,
  beginEnrolment,
  confirmEnrolment,
  removeEnrolment,
} from './actions';

/**
 * Setting up, and taking away, a second factor.
 *
 * ## Three states, and the middle one is the one that matters
 *
 * **Not enrolled** offers to start. **Pending** — a secret has been issued and not yet proved —
 * shows the secret and asks for a code; it grants nothing, which is why refreshing the page mints a
 * new secret rather than resuming the old one. **Enrolled** shows how many recovery codes are left
 * and offers to remove the factor.
 *
 * ## The secret is shown as text, not as a QR image
 *
 * A QR code would be better for the person setting this up, and it is not here, and the reason is
 * worth stating rather than leaving as an apparent omission: rendering one needs a QR library, and
 * the environment this phase was built in cannot add a dependency. The `otpauth://` URI is rendered
 * as a link, which every mobile authenticator opens directly, and the base32 secret is shown for
 * manual entry — which is the fallback every authenticator already offers and the only path that
 * works on a desktop authenticator anyway.
 *
 * ## The recovery codes are shown exactly once
 *
 * They are hashed on the way in and there is no read path that returns them. The screen says so
 * before it shows them, because "copy these now" after the fact is how people end up with a factor
 * and no way past it.
 */
export function MfaScreen({ status }: { status: MfaStatus | null }): ReactNode {
  const translate = useTranslate();
  const toast = useToast();
  const router = useRouter();

  const [offer, setOffer] = useState<MfaOffer | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<readonly string[] | null>(null);
  const [code, setCode] = useState('');
  const [working, setWorking] = useState(false);

  const start = async (): Promise<void> => {
    setWorking(true);
    const result = await beginEnrolment();
    setWorking(false);
    if (result.ok) {
      setOffer(result.value);
      return;
    }
    toast.error(result.detail ?? translate(`error.${result.code}`));
  };

  const confirm = async (): Promise<void> => {
    setWorking(true);
    const result = await confirmEnrolment({ code });
    setWorking(false);
    if (result.ok) {
      setRecoveryCodes(result.value.recoveryCodes);
      setOffer(null);
      setCode('');
      return;
    }
    toast.error(result.detail ?? translate(`error.${result.code}`));
  };

  const remove = async (): Promise<void> => {
    setWorking(true);
    const result = await removeEnrolment();
    setWorking(false);
    if (result.ok) {
      toast.success(translate('auth.mfaRemoved'));
      router.refresh();
      return;
    }
    toast.error(result.detail ?? translate(`error.${result.code}`));
  };

  if (recoveryCodes !== null) {
    return (
      <Card className="flex flex-col gap-4 p-4">
        <h1 className="text-lg font-semibold">{translate('auth.mfaRecoveryTitle')}</h1>
        {/* Said before they are shown, not after. */}
        <Alert tone="warning">{translate('auth.mfaRecoveryWarning')}</Alert>
        <ul className="grid grid-cols-2 gap-2 font-mono text-sm">
          {recoveryCodes.map((value) => (
            <li key={value}>{value}</li>
          ))}
        </ul>
        <Alert tone="info">{translate('auth.mfaSessionsEnded')}</Alert>
        <Button
          type="button"
          onClick={() => {
            router.refresh();
          }}
        >
          {translate('auth.mfaDone')}
        </Button>
      </Card>
    );
  }

  if (offer !== null) {
    return (
      <Card className="flex flex-col gap-4 p-4">
        <h1 className="text-lg font-semibold">{translate('auth.mfaSetUpTitle')}</h1>
        <p className="text-sm">{translate('auth.mfaSetUpHint')}</p>
        <p className="break-all font-mono text-sm">{offer.secret}</p>
        <a className="text-sm underline" href={offer.uri}>
          {translate('auth.mfaOpenInApp')}
        </a>
        <Field label={translate('auth.mfaCodeLabel')} required>
          <Input
            value={code}
            onChange={(event) => {
              setCode(event.currentTarget.value);
            }}
            autoComplete="one-time-code"
            inputMode="numeric"
            spellCheck={false}
            required
          />
        </Field>
        <Button
          type="button"
          disabled={working || code === ''}
          onClick={() => {
            void confirm();
          }}
        >
          {translate('auth.mfaConfirm')}
        </Button>
      </Card>
    );
  }

  return (
    <Card className="flex flex-col gap-4 p-4">
      <h1 className="text-lg font-semibold">{translate('auth.mfaTitle')}</h1>
      {status === null ? (
        /*
         * Unknown, so neither action is offered — Slice 26. Enrolling and removing are both acts on
         * a factor whose existence this page could not establish, and the server refuses the first
         * outright when one is already enrolled. A button that cannot know what it does is worse
         * than no button.
         */
        <p className="text-sm">{translate('auth.mfaStatusUnavailable')}</p>
      ) : status.enrolled ? (
        <>
          <p className="text-sm">
            {translate('auth.mfaEnrolledHint', { count: status.recoveryCodesRemaining })}
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={working}
            onClick={() => {
              void remove();
            }}
          >
            {translate('auth.mfaRemove')}
          </Button>
        </>
      ) : (
        <>
          <p className="text-sm">{translate('auth.mfaNotEnrolledHint')}</p>
          <Button
            type="button"
            disabled={working}
            onClick={() => {
              void start();
            }}
          >
            {translate(status.pending ? 'auth.mfaStartAgain' : 'auth.mfaStart')}
          </Button>
        </>
      )}
    </Card>
  );
}
