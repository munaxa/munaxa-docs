'use server';

import {
  type BulkExportLinks,
  type BulkOperationResult,
  bulkExportSchema,
  bulkMetadataSchema,
  bulkRestoreSchema,
} from '@edms/contracts';

import type { ActionResult } from '../../lib/admin/action-result';
import { adminRead, adminWrite } from '../../lib/admin/api';
import { validated } from '../../lib/admin/validated';

/**
 * Bulk writes, as server actions like every other write in this product.
 *
 * **None of these answers `void`, and that is the whole point of the surface.** A bulk operation's
 * interesting half is what did *not* happen, so each returns the tally and the per-object outcomes
 * — and the screen renders them rather than a toast saying "done". A bulk restore of forty
 * documents that put back thirty-eight is not a success and is not a failure; it is thirty-eight
 * restored, one refused because the caller does not reach it, and one blocked by a legal hold, and
 * a person needs to be told which is which.
 *
 * The identifier list is validated here as well as at the API. Not defensively — the API is the
 * authority and refuses anything malformed — but because `validated` is what turns a schema
 * violation into a field-level message a form can render, and a selection that somehow carried a
 * non-identifier should say so here rather than round-tripping.
 */

export async function bulkSetMetadata(input: unknown): Promise<ActionResult<BulkOperationResult>> {
  return validated(bulkMetadataSchema, input, (body) =>
    adminWrite<BulkOperationResult>({ path: '/documents/bulk/metadata', method: 'POST', body }),
  );
}

export async function bulkRestore(
  ids: readonly string[],
): Promise<ActionResult<BulkOperationResult>> {
  return validated(bulkRestoreSchema, { ids }, (body) =>
    adminWrite<BulkOperationResult>({ path: '/documents/bulk/restore', method: 'POST', body }),
  );
}

export async function bulkExport(
  ids: readonly string[],
): Promise<ActionResult<BulkOperationResult>> {
  return validated(bulkExportSchema, { ids }, (body) =>
    adminWrite<BulkOperationResult>({ path: '/documents/bulk/exports', method: 'POST', body }),
  );
}

/**
 * The signed links for a completed export.
 *
 * A second call rather than part of the export's answer, mirroring the API's own split: the export
 * is the *record* of a release having been decided, and a link is the release happening. Minting
 * durable links when the export ran would let somebody whose access was revoked afterwards still
 * take the content, so they are minted per request against the caller's reach as it stands now.
 */
export async function bulkExportLinks(operationId: string): Promise<ActionResult<BulkExportLinks>> {
  return adminRead<BulkExportLinks>(`/documents/bulk/${operationId}/links`);
}
