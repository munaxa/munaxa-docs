import { Inject, Injectable } from '@nestjs/common';

import { type AnyId, AuditSubjectType, DocumentOrigin, Settings, asId } from '@edms/domain';
import { type Page, squish } from '@edms/utils';

import {
  DuplicateError,
  NotFoundError,
  ValidationError,
} from '../../../core/errors/application-errors';
import {
  AdministeredWriter,
  AdministrativeOperation,
  type AdministrativeOperationKey,
  checkVersion,
} from '../../../core/persistence';
import { SETTINGS_READER, type SettingsReader } from '../../../core/settings/settings.port';
import { DocumentAudit } from '../domain/audit-actions';
import type { MetadataInputValue } from '../domain/metadata';
import { DOCUMENT_CONFIGURATION, type DocumentConfiguration } from './configuration.port';
import { DOCUMENT_PLACEMENT, type DocumentPlacement } from './placement.port';
import {
  DOCUMENT_TEMPLATE_REPOSITORY,
  type DocumentTemplateListRequest,
  type DocumentTemplateRecord,
  type DocumentTemplateRepository,
} from './template.ports';
import type { DocumentRow } from './ports';
// A value import: a type-only one erases the `design:paramtypes` metadata Nest resolves by.
import { DefaultDocumentService } from './document.service';

/**
 * Authoring templates, and creating documents from them.
 *
 * ## Two permissions, and the split is the design
 *
 * Authoring a template is `template:manage` — it is tenant configuration, and the person who
 * decides what a new deviation report starts as is the document controller rather than everybody
 * who can file one. *Using* a template is `document:create` on the destination folder, unchanged
 * and unwidened: a template confers no reach, so somebody holding one cannot file a document
 * anywhere they could not already.
 *
 * That split is why `createFrom` calls `DefaultDocumentService.create` rather than inserting a
 * document itself. Every rule the manual path enforces still runs — the folder's reach, the
 * type's active flag, the confidentiality floor, the metadata validation, the duplicate warning,
 * the first revision, the reference count, the thumbnail, the audit event, the outbox event. A
 * template that took a shortcut past any of them would be a way to create documents that skipped
 * the rules, which is the opposite of what a *controlled* starting point is for.
 *
 * ## The body is a reference, never a copy
 *
 * `file_object_id` is the same content-addressed blob ADR-0007 deduplicates. Creating a document
 * from a template passes that identifier to `create`, which takes a reference on it — so a thousand
 * documents from one template are **one blob with a thousand and one references**, not a thousand
 * copies. No code here does anything to obtain that; it is what not writing a copy path buys, and
 * it is the clearest instance in this phase of the storage optimisation the brief asked about being
 * already paid for.
 *
 * The consequence worth stating: editing the template's body does not change documents already
 * created from it, because they hold their own revision pointing at the blob the template had *at
 * the time*. That is correct for a controlled-document system — a form issued last year is not
 * silently reissued — and it is the behaviour a copy would have given too, obtained without the
 * storage.
 */
@Injectable()
export class DocumentTemplateService {
  constructor(
    @Inject(DOCUMENT_TEMPLATE_REPOSITORY) private readonly templates: DocumentTemplateRepository,
    @Inject(DOCUMENT_CONFIGURATION) private readonly configuration: DocumentConfiguration,
    @Inject(DOCUMENT_PLACEMENT) private readonly placement: DocumentPlacement,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    private readonly documents: DefaultDocumentService,
    private readonly writer: AdministeredWriter,
  ) {}

  list(request: DocumentTemplateListRequest): Promise<Page<DocumentTemplateRecord>> {
    return this.writer.read(() => this.templates.list(request));
  }

  async get(id: string): Promise<DocumentTemplateRecord> {
    const found = await this.writer.read(() => this.templates.findById(id, true));
    if (found === null) {
      throw new NotFoundError('The requested template');
    }
    return found;
  }

  async create(input: {
    readonly name: string;
    readonly description?: string | undefined;
    readonly documentTypeId: string;
    readonly categoryId?: string | null | undefined;
    readonly confidentialityId: string;
    readonly defaultFolderId?: string | null | undefined;
    readonly fileObjectId?: string | null | undefined;
    readonly filename?: string | null | undefined;
    readonly defaultMetadata?: Readonly<Record<string, MetadataInputValue>> | undefined;
    readonly isActive?: boolean | undefined;
  }): Promise<DocumentTemplateRecord> {
    await this.requireEnabled();
    return this.writer.write<DocumentTemplateRecord>(async () => {
      const name = this.requireName(input.name);
      if (await this.templates.nameTaken(name, null)) {
        throw new DuplicateError('template', 'name', { name });
      }
      await this.validateReferences(input);

      const id = this.writer.clock.nextId();
      await this.templates.insert({
        id,
        name,
        description: input.description === undefined ? null : squish(input.description),
        documentTypeId: input.documentTypeId,
        categoryId: input.categoryId ?? null,
        confidentialityId: input.confidentialityId,
        defaultFolderId: input.defaultFolderId ?? null,
        fileObjectId: input.fileObjectId ?? null,
        filename: input.filename ?? null,
        defaultMetadata: input.defaultMetadata ?? {},
        isActive: input.isActive ?? true,
      });
      return {
        result: await this.require(id),
        change: this.changed(id, AdministrativeOperation.CREATED, undefined, {
          name,
          documentTypeId: input.documentTypeId,
        }),
      };
    });
  }

  async update(
    id: string,
    patch: {
      readonly name?: string;
      readonly description?: string;
      readonly documentTypeId?: string;
      readonly categoryId?: string | null;
      readonly confidentialityId?: string;
      readonly defaultFolderId?: string | null;
      readonly fileObjectId?: string | null;
      readonly filename?: string | null;
      readonly defaultMetadata?: Readonly<Record<string, MetadataInputValue>>;
      readonly isActive?: boolean;
    },
    expectedVersion: number | undefined,
  ): Promise<DocumentTemplateRecord> {
    await this.requireEnabled();
    return this.writer.write<DocumentTemplateRecord>(async () => {
      const current = await this.require(id);
      checkVersion(expectedVersion, current.version);
      const name = patch.name === undefined ? undefined : this.requireName(patch.name);
      if (name !== undefined && (await this.templates.nameTaken(name, id))) {
        throw new DuplicateError('template', 'name', { name });
      }
      await this.validateReferences({
        documentTypeId: patch.documentTypeId ?? current.documentTypeId,
        confidentialityId: patch.confidentialityId ?? current.confidentialityId,
        ...(patch.categoryId !== undefined && { categoryId: patch.categoryId }),
        ...(patch.defaultFolderId !== undefined && { defaultFolderId: patch.defaultFolderId }),
      });

      await this.templates.update(id, current.version, {
        ...(name !== undefined && { name }),
        ...(patch.description !== undefined && { description: squish(patch.description) }),
        ...(patch.documentTypeId !== undefined && { documentTypeId: patch.documentTypeId }),
        ...(patch.categoryId !== undefined && { categoryId: patch.categoryId }),
        ...(patch.confidentialityId !== undefined && {
          confidentialityId: patch.confidentialityId,
        }),
        ...(patch.defaultFolderId !== undefined && { defaultFolderId: patch.defaultFolderId }),
        ...(patch.fileObjectId !== undefined && { fileObjectId: patch.fileObjectId }),
        ...(patch.filename !== undefined && { filename: patch.filename }),
        ...(patch.defaultMetadata !== undefined && { defaultMetadata: patch.defaultMetadata }),
        ...(patch.isActive !== undefined && { isActive: patch.isActive }),
      });
      return {
        result: await this.require(id),
        change: this.changed(id, AdministrativeOperation.UPDATED, { name: current.name }, patch),
      };
    });
  }

  async remove(id: string, expectedVersion: number | undefined): Promise<void> {
    await this.requireEnabled();
    await this.writer.write<void>(async () => {
      const current = await this.require(id);
      checkVersion(expectedVersion, current.version);
      await this.templates.setDeleted(id, current.version, true);
      return {
        result: undefined,
        change: this.changed(
          id,
          AdministrativeOperation.DELETED,
          { name: current.name },
          undefined,
        ),
      };
    });
  }

  async restore(id: string, expectedVersion: number | undefined): Promise<DocumentTemplateRecord> {
    await this.requireEnabled();
    return this.writer.write<DocumentTemplateRecord>(async () => {
      const current = await this.require(id);
      checkVersion(expectedVersion, current.version);
      await this.templates.setDeleted(id, current.version, false);
      return {
        result: await this.require(id),
        change: this.changed(id, AdministrativeOperation.RESTORED, undefined, {
          name: current.name,
        }),
      };
    });
  }

  /**
   * A new document, started from a template.
   *
   * Nothing here writes a document. It resolves the template's defaults against what the caller
   * supplied and hands the result to `DefaultDocumentService.create`, which is the only path onto
   * `document` in this module — so the folder's reach, the type's rules, the confidentiality floor,
   * the metadata validation, the first revision, the blob reference, the thumbnail, the audit event
   * and the outbox event are all the same ones a manual create produces. A template is a set of
   * defaults, not a second door.
   *
   * `acknowledgeDuplicate` is **false**, unlike a bulk import's. Two documents from one template
   * with no content changes yet *are* byte-identical, and warning about it is right: somebody who
   * started a form twice by accident should be told before they fill the second one in.
   */
  async createFrom(
    templateId: string,
    input: {
      readonly folderId?: string | undefined;
      readonly title: string;
      readonly description?: string | undefined;
      readonly categoryId?: string | null | undefined;
      readonly metadata?: Readonly<Record<string, MetadataInputValue>> | undefined;
      readonly filename?: string | undefined;
    },
  ): Promise<DocumentRow> {
    await this.requireEnabled();
    const template = await this.get(templateId);
    if (template.deletedAt !== null || !template.isActive) {
      throw new ValidationError('This template is not available.', [
        { field: 'templateId', message: template.deletedAt !== null ? 'deleted' : 'inactive' },
      ]);
    }
    const folderId = input.folderId ?? template.defaultFolderId;
    if (folderId === null || folderId === undefined) {
      // A template usable anywhere has no home folder, which is legitimate — so the caller has to
      // say where. Defaulting to somewhere would file a controlled document in a place nobody chose.
      throw new ValidationError('This template names no folder, so the request has to.', [
        { field: 'folderId', message: 'required' },
      ]);
    }
    if (template.fileObjectId === null || template.filename === null) {
      // A template of defaults alone cannot start a document: a document is a controlled record
      // over content, and Phase 3's `create` requires a blob because ADR-0003 says a document with
      // no revision has no content. Such a template is still useful — it is the defaults a manual
      // upload can be prefilled from — and saying so is better than inventing an empty file.
      throw new ValidationError('This template has no body, so it cannot start a document.', [
        { field: 'fileObjectId', message: 'absent' },
      ]);
    }

    return this.documents.create({
      folderId,
      documentTypeId: template.documentTypeId,
      categoryId: input.categoryId === undefined ? template.categoryId : input.categoryId,
      confidentialityId: template.confidentialityId,
      title: input.title,
      ...(input.description !== undefined && { description: input.description }),
      fileObjectId: template.fileObjectId,
      filename: input.filename ?? template.filename,
      // The template's defaults, overridden field by field rather than wholesale: a caller who
      // supplies one value keeps the template's others, which is what a default is.
      metadata: {
        ...(template.defaultMetadata as Readonly<Record<string, MetadataInputValue>>),
        ...(input.metadata ?? {}),
      },
      origin: DocumentOrigin.UPLOAD,
      acknowledgeDuplicate: false,
    });
  }

  private async requireEnabled(): Promise<void> {
    if (!(await this.settings.get(Settings.FEATURE_DOCUMENT_TEMPLATES))) {
      throw new ValidationError('Document templates are turned off for this organisation.', [
        { field: 'feature', message: 'disabled' },
      ]);
    }
  }

  /**
   * Every identifier a template names has to exist, now.
   *
   * Validated at save time *and* again at use time by `create`, and both are needed: a document
   * type retired between the two would otherwise let a template silently produce documents of a
   * type nobody may choose manually.
   */
  private async validateReferences(input: {
    readonly documentTypeId: string;
    readonly confidentialityId: string;
    readonly categoryId?: string | null | undefined;
    readonly defaultFolderId?: string | null | undefined;
  }): Promise<void> {
    if ((await this.configuration.documentType(input.documentTypeId)) === null) {
      throw new ValidationError('That document type does not exist.', [
        { field: 'documentTypeId', message: 'unknown' },
      ]);
    }
    if ((await this.configuration.confidentiality(input.confidentialityId)) === null) {
      throw new ValidationError('That confidentiality level does not exist.', [
        { field: 'confidentialityId', message: 'unknown' },
      ]);
    }
    if (
      input.categoryId !== undefined &&
      input.categoryId !== null &&
      !(await this.configuration.categoryExists(input.categoryId))
    ) {
      throw new ValidationError('That category does not exist.', [
        { field: 'categoryId', message: 'unknown' },
      ]);
    }
    if (
      input.defaultFolderId !== undefined &&
      input.defaultFolderId !== null &&
      (await this.placement.folder(input.defaultFolderId)) === null
    ) {
      throw new ValidationError('That folder does not exist.', [
        { field: 'defaultFolderId', message: 'unknown' },
      ]);
    }
  }

  private requireName(name: string): string {
    const squished = squish(name);
    if (squished.length === 0) {
      throw new ValidationError('A template needs a name.', [
        { field: 'name', message: 'required' },
      ]);
    }
    return squished;
  }

  private async require(id: string): Promise<DocumentTemplateRecord> {
    const found = await this.templates.findById(id, true);
    if (found === null) {
      throw new NotFoundError('The requested template');
    }
    return found;
  }

  private changed(
    id: string,
    operation: AdministrativeOperationKey,
    before: Readonly<Record<string, unknown>> | undefined,
    after: Readonly<Record<string, unknown>> | undefined,
  ) {
    return {
      action: DocumentAudit.DOCUMENT_TEMPLATE_CHANGED,
      // `CONFIGURATION`, not `DOCUMENT`: a template is configuration, and filing it under the
      // document type would put it on the timeline of no document at all.
      subjectType: AuditSubjectType.CONFIGURATION,
      subjectId: asId<AnyId>(id),
      operation,
      ...(before !== undefined && { before }),
      ...(after !== undefined && { after }),
    };
  }
}
