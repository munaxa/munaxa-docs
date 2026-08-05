'use server';

import {
  type CompletedUpload,
  type Document,
  type DuplicateReport,
  type UploadTarget,
  assignDocumentNumberSchema,
  completeUploadSchema,
  createDocumentSchema,
  createUploadSchema,
  deleteDocumentSchema,
  moveDocumentSchema,
  updateDocumentSchema,
} from '@edms/contracts';

import type { ActionResult } from '../../lib/admin/action-result';
import { adminGet, adminWrite } from '../../lib/admin/api';
import { validated } from '../../lib/admin/validated';

/**
 * Writes to the document library.
 *
 * Every one of these is a server action, so the access token stays in its `httpOnly` cookie and
 * never reaches client JavaScript — the same rule as Administration, and the reason there is no
 * browser-side API client anywhere in this product.
 *
 * **The upload is the one place bytes do not go through here, and that is the design.** The browser
 * asks for a target, PUTs the file straight to storage, and then says it is done. The URL it PUTs to
 * is presigned: it needs no session, it names one object, and it expires in minutes — so no
 * credential leaves the server, and a 2 GB drawing never passes through a Next.js server action
 * with its own body-size limits (`11-storage-architecture.md` §4).
 */

export async function requestUploadTarget(input: unknown): Promise<ActionResult<UploadTarget>> {
  return validated(createUploadSchema, input, (body) =>
    adminWrite<UploadTarget>({ path: '/uploads', method: 'POST', body }),
  );
}

export async function completeUpload(
  uploadSessionId: string,
  input: unknown,
): Promise<ActionResult<CompletedUpload>> {
  return validated(completeUploadSchema, input, (body) =>
    adminWrite<CompletedUpload>({
      path: `/uploads/${uploadSessionId}/complete`,
      method: 'POST',
      body,
    }),
  );
}

/** Abandons a transfer the person cancelled, rather than leaving it for the sweeper. */
export async function abandonUpload(uploadSessionId: string): Promise<ActionResult> {
  return adminWrite({ path: `/uploads/${uploadSessionId}`, method: 'DELETE' });
}

/**
 * What else in this organisation is exactly these bytes.
 *
 * Asked *before* the person fills in a form, so the warning arrives while it is still cheap to act
 * on. A duplicate is frequently legitimate — the same signed form filed against two projects — so
 * this is a warning and never a refusal.
 */
export async function findDuplicates(fileObjectId: string): Promise<DuplicateReport> {
  return adminGet<DuplicateReport>(`/documents/duplicates/${fileObjectId}`);
}

export async function createDocument(input: unknown): Promise<ActionResult<Document>> {
  return validated(createDocumentSchema, input, (body) =>
    adminWrite<Document>({ path: '/documents', method: 'POST', body }),
  );
}

export async function updateDocument(
  id: string,
  version: number,
  input: unknown,
): Promise<ActionResult<Document>> {
  return validated(updateDocumentSchema, input, (body) =>
    adminWrite<Document>({ path: `/documents/${id}`, method: 'PATCH', body, version }),
  );
}

/**
 * Moves a document to another folder.
 *
 * Its own action because it is its own permission and its own consequence: the folder is the chain
 * permissions are inherited along, so a move changes who can see the document.
 */
export async function moveDocument(
  id: string,
  version: number,
  input: unknown,
): Promise<ActionResult<Document>> {
  return validated(moveDocumentSchema, input, (body) =>
    adminWrite<Document>({ path: `/documents/${id}/move`, method: 'POST', body, version }),
  );
}

/**
 * Records a number by hand — a legacy identifier, or a document approved before numbering
 * existed. Behind `numbering:manage`; the server validates the number against the document's own
 * rule and refuses any value the numbering system has ever issued.
 */
export async function assignDocumentNumber(
  id: string,
  input: unknown,
): Promise<ActionResult<Document>> {
  return validated(assignDocumentNumberSchema, input, (body) =>
    adminWrite<Document>({ path: `/documents/${id}/number`, method: 'POST', body }),
  );
}

/**
 * Soft-deletes a document, with the reason the API now requires.
 *
 * The body travels on a `DELETE`, which is unusual and deliberate: the reason is content somebody
 * typed, and a query parameter would put a sentence about a record into every access log between
 * here and the API.
 */
export async function deleteDocument(
  id: string,
  version: number,
  reason: string,
): Promise<ActionResult> {
  return validated(deleteDocumentSchema, { reason }, (body) =>
    adminWrite({ path: `/documents/${id}`, method: 'DELETE', version, body }),
  );
}

export async function restoreDocument(id: string, version: number): Promise<ActionResult> {
  return adminWrite({ path: `/documents/${id}/restore`, method: 'POST', version });
}

export async function setFavorite(id: string, favorite: boolean): Promise<ActionResult> {
  return adminWrite({
    path: `/documents/${id}/favorite`,
    method: favorite ? 'POST' : 'DELETE',
  });
}

/**
 * A short-lived link to the content.
 *
 * Requested at the moment of clicking rather than rendered with the row, because issuing one is an
 * audited event: a list of two hundred documents must not write two hundred "a download link was
 * issued" entries for links nobody used.
 */
export async function requestDownload(
  id: string,
  inline: boolean,
): Promise<ActionResult<{ url: string; expiresAt: string }>> {
  return adminWrite<{ url: string; expiresAt: string }>({
    path: `/documents/${id}/content?inline=${String(inline)}`,
    method: 'POST',
  });
}
