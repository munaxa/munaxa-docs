import type { ReactNode } from 'react';
import { vi } from 'vitest';

/**
 * Setup for the browser suites, which render to static markup in Node.
 *
 * Only Next's navigation is doubled, and only because its hooks throw outside an app router. There
 * is deliberately no DOM shim here: this project renders on the server and the *browser* supplies
 * the DOM, which is the whole point of it being separate from the jsdom suites.
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
  notFound: vi.fn(),
}));

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
