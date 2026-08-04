'use server';

import type { PreviewContent, PreviewManifest, PreviewText } from '@edms/contracts';

import type { ActionResult } from '../../lib/admin/action-result';
import { adminGet, adminWrite } from '../../lib/admin/api';

/**
 * The viewer's data path, from the browser's side.
 *
 * Reads are server actions too — the access token lives in its `httpOnly` cookie and there is
 * no browser API client — and the *content* requests are writes on the API because issuing a
 * link is an audited act: the viewer asks per open and per print, never per render, exactly as
 * the download button does. What comes back is a short-lived URL onto the preview stream; the
 * browser redeems it directly, which is the one hop that carries no session because the token
 * in it is the credential.
 */

export async function fetchPreviewManifest(
  documentId: string,
  revisionId?: string,
): Promise<PreviewManifest | null> {
  try {
    return await adminGet<PreviewManifest>(
      revisionId === undefined
        ? `/documents/${documentId}/preview`
        : `/documents/${documentId}/revisions/${revisionId}/preview`,
    );
  } catch {
    return null;
  }
}

export async function requestPreviewContent(
  documentId: string,
  revisionId?: string,
): Promise<ActionResult<PreviewContent>> {
  return adminWrite<PreviewContent>({
    path:
      revisionId === undefined
        ? `/documents/${documentId}/preview/content`
        : `/documents/${documentId}/revisions/${revisionId}/preview/content`,
    method: 'POST',
  });
}

/** A print, through the preview path — watermarked where the level demands, always audited. */
export async function requestPreviewPrint(
  documentId: string,
): Promise<ActionResult<PreviewContent>> {
  return adminWrite<PreviewContent>({
    path: `/documents/${documentId}/preview/print`,
    method: 'POST',
  });
}

export async function fetchPreviewText(
  documentId: string,
  revisionId?: string,
): Promise<PreviewText | null> {
  try {
    return await adminGet<PreviewText | null>(
      revisionId === undefined
        ? `/documents/${documentId}/preview/text`
        : `/documents/${documentId}/revisions/${revisionId}/preview/text`,
    );
  } catch {
    return null;
  }
}
