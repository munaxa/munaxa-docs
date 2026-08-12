import type { ReactNode } from 'react';

import { ProductLogo } from '@munaxa/ui';

/**
 * The unauthenticated shell: no navigation, no tenant chrome, nothing that implies a session.
 *
 * It does now carry the product's identity, and that is the point of the branding phase rather
 * than decoration. Sign-in, two-step verification and every error they can land on were the one
 * set of screens with no way of telling you *which* Munaxa product you were about to enter — a
 * plain heading and a form, identical in all three. Somebody who followed a link from an email is
 * being asked for a password by a page that has not said who it is.
 *
 * The stacked lockup, because this is vertical space and that is the lockup drawn for it. It is
 * the logo's own accessible name that says "Munaxa Docs"; the heading below states the task
 * ("Sign in"), so the two do not repeat each other.
 */
export default function AuthLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <div className="flex w-full max-w-sm flex-col gap-8">
        <div className="flex justify-center">
          <ProductLogo variant="stacked" height={76} priority />
        </div>
        {children}
      </div>
    </main>
  );
}
