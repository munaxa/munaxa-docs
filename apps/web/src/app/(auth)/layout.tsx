import type { ReactNode } from 'react';

/** The unauthenticated shell: no navigation, no tenant chrome, nothing that implies a session. */
export default function AuthLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-sm">{children}</div>
    </main>
  );
}
