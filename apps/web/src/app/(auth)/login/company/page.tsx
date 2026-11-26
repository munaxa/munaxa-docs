import type { Metadata, Route } from 'next';
import type { ReactNode } from 'react';

import { en } from '@edms/i18n';

import { safeDestination } from '../../../../lib/destination';
import { CompanyForm } from './company-form';

export const metadata: Metadata = {
  title: `${en.auth.signInWithMunaxa} · ${en.app.name}`,
};

/** Sign-in through Munaxa Identity (Identity ADR-0008). `?failed=1` after a refused callback. */
export default async function CompanySignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const params = await searchParams;
  return (
    <CompanyForm next={safeDestination(params.next) as Route} failed={params.failed === '1'} />
  );
}
