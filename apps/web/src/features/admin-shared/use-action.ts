'use client';

import { useCallback } from 'react';

import { useToast } from '@munaxa/ui';

import { useTranslate } from '../../app/providers';
import type { ActionResult } from '../../lib/admin/action-result';
import type { ListState } from '../../lib/admin/list-state';
import { useListNavigation } from './list-url';

/**
 * Runs a one-shot action from a row menu — activate, disable, publish, retire.
 *
 * These have no form and therefore no dialogue to show a failure in, which is exactly why they need
 * this: a `void action().then(refresh)` would report success and silence identically, and a refused
 * publish that looks like a successful one is the worst possible outcome for an approval workflow.
 *
 * Success refreshes rather than patching a row in place, so what the screen shows always came from
 * the server.
 */
export function useAction(state: ListState): (run: () => Promise<ActionResult<unknown>>) => void {
  const translate = useTranslate();
  const toast = useToast();
  const { refresh } = useListNavigation(state);

  return useCallback(
    (run: () => Promise<ActionResult<unknown>>) => {
      void run().then((result) => {
        if (result.ok) {
          refresh();
          return;
        }
        toast.error(result.detail ?? translate(`error.${result.code}`));
      });
    },
    [refresh, toast, translate],
  );
}
