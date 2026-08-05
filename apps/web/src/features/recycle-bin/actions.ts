'use server';

import type { ActionResult } from '../../lib/admin/action-result';
import { adminWrite } from '../../lib/admin/api';

/**
 * Putting something back.
 *
 * Two calls rather than one, and to the *owning* module's endpoint rather than to a bin-specific
 * one. Restoring a document revalidates its folder is live and brings the revisions its delete
 * took; restoring a folder reverses exactly one cascade. Both sets of rules live in the phase that
 * built them, and a single `POST /recycle-bin/{id}/restore` would have been a third place they are
 * decided.
 */
export async function restoreFromBin(
  kind: 'DOCUMENT' | 'FOLDER',
  id: string,
  version: number,
): Promise<ActionResult> {
  const path = kind === 'DOCUMENT' ? `/documents/${id}/restore` : `/admin/folders/${id}/restore`;
  return adminWrite({ path, method: 'POST', version });
}
