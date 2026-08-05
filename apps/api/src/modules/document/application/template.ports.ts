import type { AnyId } from '@edms/domain';
import type { Page, PageRequest } from '@edms/utils';

/**
 * Document templates — a controlled starting point, which is not a document.
 *
 * A template has no number, no revision, no approval, no lifecycle and no place in search. It is
 * configuration that *produces* documents, in the same family as a document type or a numbering
 * rule, and modelling it as a document in a hidden folder — which is half the code — would have
 * given every blank form a workflow, a retention schedule and a row in everybody's search results.
 */
export const DOCUMENT_TEMPLATE_REPOSITORY = Symbol('DocumentTemplateRepository');

export interface DocumentTemplateRecord {
  readonly id: AnyId;
  readonly name: string;
  readonly description: string | null;
  readonly documentTypeId: string;
  readonly documentTypeName: string;
  readonly categoryId: string | null;
  readonly confidentialityId: string;
  readonly confidentialityName: string;
  readonly defaultFolderId: string | null;
  readonly defaultFolderPath: string | null;
  readonly fileObjectId: string | null;
  readonly filename: string | null;
  readonly defaultMetadata: Readonly<Record<string, unknown>>;
  readonly isActive: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
  readonly version: number;
}

export interface NewDocumentTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly documentTypeId: string;
  readonly categoryId: string | null;
  readonly confidentialityId: string;
  readonly defaultFolderId: string | null;
  readonly fileObjectId: string | null;
  readonly filename: string | null;
  readonly defaultMetadata: Readonly<Record<string, unknown>>;
  readonly isActive: boolean;
}

export interface DocumentTemplateListRequest extends PageRequest {
  readonly search?: string | undefined;
  readonly deleted: 'live' | 'deleted' | 'all';
  readonly documentTypeId?: string | undefined;
  readonly sortBy?: string | undefined;
  readonly sortDirection: 'asc' | 'desc';
}

export interface DocumentTemplateRepository {
  findById(id: string, includeDeleted: boolean): Promise<DocumentTemplateRecord | null>;
  list(request: DocumentTemplateListRequest): Promise<Page<DocumentTemplateRecord>>;
  insert(template: NewDocumentTemplate): Promise<void>;
  update(
    id: string,
    expectedVersion: number,
    patch: Partial<Omit<NewDocumentTemplate, 'id'>>,
  ): Promise<void>;
  setDeleted(id: string, expectedVersion: number, deleted: boolean): Promise<void>;
  /** Whether another live template already holds this name. The uniqueness the screen enforces. */
  nameTaken(name: string, excludingId: string | null): Promise<boolean>;
}
