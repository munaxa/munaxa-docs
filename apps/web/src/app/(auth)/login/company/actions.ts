'use server';

import type { Route } from 'next';
import { redirect } from 'next/navigation';

import { startFederatedSignIn } from '../../../../lib/auth';
import { safeDestination } from '../../../../lib/destination';

export interface CompanySignInState {
  readonly reason: 'NOT_OFFERED' | 'UNAVAILABLE' | null;
}

/**
 * Starts a sign-in through Munaxa Identity (or whichever provider the organisation configured):
 * the API decides from the address and the organisation, and the browser is sent to the provider.
 * No password is ever entered on this page.
 */
export async function companySignInAction(
  _previous: CompanySignInState,
  formData: FormData,
): Promise<CompanySignInState> {
  const field = (name: string): string => {
    const value = formData.get(name);
    return typeof value === 'string' ? value.trim() : '';
  };
  const email = field('email');
  const tenant = field('tenant').toLowerCase();
  if (email === '' || tenant === '') return { reason: 'NOT_OFFERED' };

  const started = await startFederatedSignIn({
    email,
    tenant,
    next: safeDestination(field('next')),
  });
  if (!started.ok) return { reason: started.reason };
  // Outside any try/catch: `redirect` works by throwing.
  redirect(started.authorizationUrl as Route);
}
