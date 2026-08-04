'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { Route } from 'next';
import { useCallback, useTransition } from 'react';

import {
  type ListState,
  listQueryString,
  withChange,
  withFilter,
} from '../../lib/admin/list-state';

/**
 * Moving a list's state, which means changing the URL.
 *
 * The state is in the address bar, so paging, sorting and filtering are *navigations*. That is the
 * point rather than an implementation detail: the back button walks the filters a user tried, and a
 * link they copy reproduces what they were looking at.
 *
 * `pending` comes from `useTransition`, so the grid dims and stays interactive while the server
 * renders the next page instead of being replaced by a spinner. Replacing a table with a spinner
 * loses the reader's place on every keystroke of a search.
 */
export interface ListNavigation {
  readonly pending: boolean;
  readonly apply: (change: Partial<ListState>) => void;
  readonly setFilter: (key: string, value: string) => void;
  /** Re-runs the current request — what a write needs once the server action has returned. */
  readonly refresh: () => void;
}

export function useListNavigation(state: ListState): ListNavigation {
  const router = useRouter();
  const pathname = usePathname();
  // Subscribed to deliberately: without it this hook renders once and then pushes URLs derived from
  // a stale `state` after a back-button navigation.
  useSearchParams();
  const [pending, startTransition] = useTransition();

  const push = useCallback(
    (next: ListState) => {
      startTransition(() => {
        // `push`, not `replace`: each filter a user tries is a place they can come back from.
        router.push(`${pathname}${listQueryString(next)}` as Route);
      });
    },
    [pathname, router],
  );

  const apply = useCallback(
    (change: Partial<ListState>) => {
      push(withChange(state, change));
    },
    [push, state],
  );

  const setFilter = useCallback(
    (key: string, value: string) => {
      push(withFilter(state, key, value));
    },
    [push, state],
  );

  const refresh = useCallback(() => {
    startTransition(() => {
      router.refresh();
    });
  }, [router]);

  return { pending, apply, setFilter, refresh };
}
