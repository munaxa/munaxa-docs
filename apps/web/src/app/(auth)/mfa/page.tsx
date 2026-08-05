import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { en } from '@edms/i18n';

import { currentSession } from '../../../lib/session';
import { mfaStatus } from './actions';
import { MfaScreen } from './mfa-screen';

export const metadata: Metadata = {
  title: `${en.auth.mfaTitle} · ${en.app.name}`,
};

/**
 * `16-frontend-architecture.md` §2's `(auth)/mfa` — named in Phase 0, empty until now.
 *
 * **This is enrolment, not the challenge.** The challenge lives on the sign-in form, and that is a
 * decision rather than a shortcut: a challenge on its own page would need either the password again
 * or a short-lived token standing in for it, and that token is a credential with a lifetime and a
 * revocation story minted for one purpose — exactly the kind that gets reused. One post spends the
 * password and the code together and issues nothing until both are right.
 *
 * It sits under `(auth)` rather than in the workspace because it is about *getting in* rather than
 * about working: the shell around it has no navigation and no tenant chrome, which is right for a
 * screen somebody reaches while securing an account they may have just been told is at risk.
 *
 * A caller with no session is sent to sign in. Managing a factor is an act on an account, and the
 * account has to be established first — which is also why there is no "enrol before first sign-in"
 * path: an unauthenticated caller enrolling a factor against an address would be enrolling one
 * against somebody else's.
 */
export default async function MfaPage(): Promise<ReactNode> {
  if (!(await currentSession())) {
    redirect('/login');
  }

  const status = await mfaStatus();
  return (
    <MfaScreen
      status={
        status.ok ? status.value : { enrolled: false, pending: false, recoveryCodesRemaining: 0 }
      }
    />
  );
}
