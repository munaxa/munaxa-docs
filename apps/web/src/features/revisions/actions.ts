'use server';

import {
  type Document,
  type RevisionCompare,
  type RevisionHistory,
  checkInDocumentSchema,
  forceCheckInSchema,
  publishDocumentSchema,
  restoreRevisionSchema,
} from '@edms/contracts';

import type { ActionResult } from '../../lib/admin/action-result';
import { adminGet, adminWrite } from '../../lib/admin/api';
import { validated } from '../../lib/admin/validated';

/**
 * Revision control, from the browser's side.
 *
 * Server actions like every other write in this product, so the access token stays in its
 * `httpOnly` cookie. Check-in content follows the same rule as creation: the bytes went to
 * storage through the upload handshake before any of these run, and what crosses here is a
 * reference.
 */

export async function checkOutDocument(id: string): Promise<ActionResult<Document>> {
  return adminWrite<Document>({ path: `/documents/${id}/checkout`, method: 'POST' });
}

export async function cancelCheckOut(id: string): Promise<ActionResult<Document>> {
  return adminWrite<Document>({ path: `/documents/${id}/checkout/cancel`, method: 'POST' });
}

export async function checkInDocument(id: string, input: unknown): Promise<ActionResult<Document>> {
  return validated(checkInDocumentSchema, input, (body) =>
    adminWrite<Document>({ path: `/documents/${id}/checkin`, method: 'POST', body }),
  );
}

/** Releases somebody else's lock, with the reason the audit trail requires. */
export async function forceCheckIn(id: string, input: unknown): Promise<ActionResult<Document>> {
  return validated(forceCheckInSchema, input, (body) =>
    adminWrite<Document>({ path: `/documents/${id}/force-checkin`, method: 'POST', body }),
  );
}

export async function publishDocument(id: string, input: unknown): Promise<ActionResult<Document>> {
  return validated(publishDocumentSchema, input, (body) =>
    adminWrite<Document>({ path: `/documents/${id}/publish`, method: 'POST', body }),
  );
}

/** Restore never rewinds: this creates the next draft revision carrying the old content. */
export async function restoreRevision(
  id: string,
  revisionId: string,
  input: unknown,
): Promise<ActionResult<Document>> {
  return validated(restoreRevisionSchema, input, (body) =>
    adminWrite<Document>({
      path: `/documents/${id}/revisions/${revisionId}/restore`,
      method: 'POST',
      body,
    }),
  );
}

/** The timeline, refetched after a write without reloading the whole page's data. */
export async function fetchRevisionHistory(id: string): Promise<RevisionHistory> {
  return adminGet<RevisionHistory>(`/documents/${id}/revisions`);
}

/** Two revisions compared, by ordinal — content by checksum, metadata by published snapshot. */
export async function compareRevisions(
  id: string,
  from: number,
  to: number,
): Promise<RevisionCompare> {
  return adminGet<RevisionCompare>(
    `/documents/${id}/revisions/compare?from=${String(from)}&to=${String(to)}`,
  );
}

/**
 * A short-lived link to one revision's bytes. Issued at the moment of clicking — issuing one
 * is an audited event, and a timeline must not write an entry per row it happened to render.
 */
export async function requestRevisionDownload(
  id: string,
  revisionId: string,
): Promise<ActionResult<{ url: string; expiresAt: string }>> {
  return adminWrite<{ url: string; expiresAt: string }>({
    path: `/documents/${id}/revisions/${revisionId}/content`,
    method: 'POST',
  });
}
