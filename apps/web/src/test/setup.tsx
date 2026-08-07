import '@testing-library/dom';

import { cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, vi } from 'vitest';

/**
 * The shared setup for rendered tests.
 *
 * Only two things are doubled, and both are the environment rather than the product: Next's
 * router, which needs a real navigation stack that does not exist here, and the browser APIs
 * jsdom does not implement. Everything else — the providers, the translator, the platform's
 * components — is the real thing, because a test that renders doubles asserts the doubles.
 */

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------------------
// Next's navigation. The screens read the URL and push to it; neither exists in jsdom.
// ---------------------------------------------------------------------------------------

const searchParams = new URLSearchParams();

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
  useSearchParams: () => searchParams,
  useParams: () => ({}),
  redirect: vi.fn(),
  notFound: vi.fn(),
}));

// `next/link` renders an anchor once the router is stubbed, but it also reaches for prefetch
// machinery that needs an app router context. A plain anchor is what it renders in the DOM.
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: ReactNode;
  } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// ---------------------------------------------------------------------------------------
// Browser APIs jsdom does not implement. Each is used by a platform component.
// ---------------------------------------------------------------------------------------

/**
 * A viewport-aware `matchMedia`.
 *
 * This is not a convenience. The shell decides whether to render the desktop rail or the drawer
 * through `useMediaQuery('(min-width: …)')`, so a stub that answers `false` to every query renders
 * the *mobile* layout — no sidebar, no navigation landmark, no `aria-current` — and a test written
 * against it would be asserting things about a layout nobody thought they were testing. It cost an
 * hour to notice, which is the argument for making the width explicit and settable.
 */
let viewportWidth = 1280;

/** Re-render after calling this: the hooks read the width when they subscribe. */
export function setViewportWidth(width: number): void {
  viewportWidth = width;
}

Object.defineProperty(globalThis.window, 'matchMedia', {
  writable: true,
  value: (query: string) => {
    const min = /\(min-width:\s*(\d+)px\)/.exec(query);
    const max = /\(max-width:\s*(\d+)px\)/.exec(query);
    let matches = false;
    if (min !== null) matches = viewportWidth >= Number(min[1]);
    else if (max !== null) matches = viewportWidth <= Number(max[1]);

    return {
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
  },
});

globalThis.ResizeObserver ??= class {
  observe(): void {
    /* no layout in jsdom */
  }
  unobserve(): void {
    /* no layout in jsdom */
  }
  disconnect(): void {
    /* no layout in jsdom */
  }
} as unknown as typeof ResizeObserver;

globalThis.IntersectionObserver ??= class {
  readonly root = null;
  readonly rootMargin = '';
  readonly thresholds: readonly number[] = [];
  observe(): void {
    /* no viewport in jsdom */
  }
  unobserve(): void {
    /* no viewport in jsdom */
  }
  disconnect(): void {
    /* no viewport in jsdom */
  }
  takeRecords(): [] {
    return [];
  }
} as unknown as typeof IntersectionObserver;

// Radix primitives call these during open/close transitions. Defined rather than assigned so the
// lint rule about unbound methods has nothing to object to — these are stubs, not methods that
// read `this`.
for (const method of ['scrollIntoView', 'releasePointerCapture', 'hasPointerCapture'] as const) {
  if (!(method in globalThis.window.HTMLElement.prototype)) {
    Object.defineProperty(globalThis.window.HTMLElement.prototype, method, {
      writable: true,
      value: () => undefined,
    });
  }
}
