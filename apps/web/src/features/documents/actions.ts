'use server';

import {
  type Category,
  type CompletedUpload,
  type ConfidentialityLevel,
  type Department,
  type Document,
  type DocumentType,
  type DuplicateReport,
  type Folder,
  type MetadataField,
  type UploadTarget,
  type User,
  assignDocumentNumberSchema,
  completeUploadSchema,
  createDocumentSchema,
  createUploadSchema,
  archiveDocumentSchema,
  deleteDocumentSchema,
  moveDocumentSchema,
  updateDocumentSchema,
} from '@edms/contracts';

import { type ActionResult, succeeded, toActionResult } from '../../lib/admin/action-result';
import { adminGet, adminList, adminOptions, adminWrite } from '../../lib/admin/api';
import { validated } from '../../lib/admin/validated';
import type { DocumentEditOptions, DocumentMoveOptions } from './options';

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

/**
 * The pickers the properties dialogue needs, fetched when it opens — Phase 7.1C.
 *
 * These six reads used to happen in the record page's server render, on every document anybody
 * opened, for a form most readers never open. Phase 7.1B measured what that cost: fifteen API
 * requests for one page view, seven of them for two closed dialogues, all of them against the one
 * rate-limit bucket the caller's identity owns.
 *
 * Deferred rather than removed, and deferred to a *server action* rather than to a browser fetch,
 * because the access token lives in an `httpOnly` cookie and a script cannot carry it. That is the
 * same reason `loadShippedTemplate` exists on the notification templates screen, and this follows
 * its shape exactly: awaited before the dialogue opens, so there is no half-rendered form, and a
 * refusal becomes a message rather than a discarded screen.
 *
 * Nothing about authorization changes. The endpoints are the same, the token is the same, and each
 * one still enforces its own permission — a caller who could not read the tenant's departments
 * before still cannot, they simply learn it when they ask to edit rather than when they open the
 * record.
 */
export async function loadEditOptions(
  documentTypeId: string | null,
  confidentialityRank: number,
): Promise<ActionResult<DocumentEditOptions>> {
  try {
    const [categories, levels, users, departments, fields, types] = await Promise.all([
      adminOptions<Category>('/admin/categories', 'name'),
      adminOptions<ConfidentialityLevel>('/admin/confidentiality-levels', 'name'),
      adminOptions<User>('/admin/users', 'displayName'),
      adminOptions<Department>('/admin/departments', 'path'),
      adminOptions<MetadataField>('/admin/fields', 'name'),
      adminOptions<DocumentType>('/admin/document-types', 'name'),
    ]);
    const fieldsById = new Map(fields.data.map((field) => [field.id, field]));
    const type = types.data.find((candidate) => candidate.id === documentTypeId);
    return succeeded({
      categories: categories.data.map((category) => ({
        value: category.id,
        label: category.name,
      })),
      confidentialityLevels: levels.data
        .filter((level) => level.rank >= confidentialityRank)
        .map((level) => ({ value: level.id, label: level.name })),
      users: users.data.map((user) => ({ value: user.id, label: user.displayName })),
      departments: departments.data.map((department) => ({
        value: department.id,
        label: department.name,
      })),
      fields: (type?.fields ?? []).flatMap((entry) => {
        const definition = fieldsById.get(entry.metadataFieldId);
        return definition === undefined
          ? []
          : [
              {
                id: definition.id,
                key: definition.key,
                name: definition.name,
                dataType: definition.dataType,
                isRequired: entry.isRequired,
                options: definition.options.map((option) => ({
                  value: option.value,
                  label: option.label,
                })),
                description: definition.description,
                defaultValue: entry.defaultValue,
              },
            ];
      }),
    });
  } catch (error) {
    return toActionResult<DocumentEditOptions>(error);
  }
}

/**
 * The folders a move may choose between, fetched when that dialogue opens.
 *
 * Bounded to the document's own library, as it always was: a document does not cross libraries —
 * its contents would move into a different permission chain, and there is no confirmation dialogue
 * that can honestly summarise that.
 */
export async function loadMoveOptions(
  libraryId: string,
): Promise<ActionResult<DocumentMoveOptions>> {
  try {
    const folders = await adminList<Folder>('/admin/folders', {
      page: 1,
      // The API's maximum, and it has to be: `MAX_PAGE_SIZE` is 100 and the pagination schema
      // rejects anything above it.
      pageSize: 100,
      sortBy: 'path',
      sortDirection: 'asc',
      search: '',
      deleted: 'live',
      filters: { libraryId },
    });
    return succeeded({
      folders: folders.data.map((folder) => ({ value: folder.id, label: folder.name })),
    });
  } catch (error) {
    return toActionResult<DocumentMoveOptions>(error);
  }
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

/**
 * Retires a record from the live shelf, or puts it back — Phase 6.1.
 *
 * Two thin wrappers over one schema rather than one function with a direction argument, so a call
 * site reads as the decision it is taking. Both carry the version, so an archive decided against a
 * document somebody has since edited loses rather than overwriting.
 */
export async function archiveDocument(
  id: string,
  version: number,
  reason: string,
): Promise<ActionResult> {
  return validated(archiveDocumentSchema, { reason }, (body) =>
    adminWrite({ path: `/documents/${id}/archive`, method: 'POST', version, body }),
  );
}

export async function reinstateDocument(
  id: string,
  version: number,
  reason: string,
): Promise<ActionResult> {
  return validated(archiveDocumentSchema, { reason }, (body) =>
    adminWrite({ path: `/documents/${id}/reinstate`, method: 'POST', version, body }),
  );
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
