'use server';

import {
  type BulkExportItems,
  type BulkExportLink,
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
 * A completed export's released documents, a page at a time, as the caller may see them now. No
 * URL in it: a link is a release happening, issued when one item is clicked (below).
 */
export async function bulkExportItems(
  operationId: string,
  page: number,
): Promise<ActionResult<BulkExportItems>> {
  return adminRead<BulkExportItems>(
    `/documents/bulk/${encodeURIComponent(operationId)}/items?page=${String(page)}&pageSize=50`,
  );
}

/** A verified download link for one released document, issued as it is clicked. */
export async function bulkExportItemLink(
  operationId: string,
  documentId: string,
): Promise<ActionResult<BulkExportLink>> {
  return adminWrite<BulkExportLink>({
    path: `/documents/bulk/${encodeURIComponent(operationId)}/items/${encodeURIComponent(documentId)}/link`,
    method: 'POST',
  });
}

/** A verified download link for the export's manifest — the requester's own. */
export async function bulkExportManifestLink(
  operationId: string,
): Promise<ActionResult<BulkExportLink>> {
  return adminWrite<BulkExportLink>({
    path: `/documents/bulk/${encodeURIComponent(operationId)}/manifest/link`,
    method: 'POST',
  });
}
