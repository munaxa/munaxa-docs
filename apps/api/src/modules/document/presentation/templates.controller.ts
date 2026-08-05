import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import {
  type Collection,
  type CreateDocumentTemplateBody,
  type CreateFromTemplateBody,
  type Document,
  type DocumentTemplate,
  type UpdateDocumentTemplateBody,
  createDocumentTemplateSchema,
  createFromTemplateSchema,
  documentTemplateListQuerySchema,
  updateDocumentTemplateSchema,
} from '@edms/contracts';
import { Permission } from '@edms/domain';

import { RequirePermission } from '../../../core/authorization/permission.decorator';
import { IfMatch } from '../../../core/http/admin-request';
import { ZodValidationPipe } from '../../../core/http/zod-validation.pipe';
import type { DocumentTemplateRecord } from '../application/template.ports';
import { DocumentTemplateService } from '../application/template.service';
import { toDocument } from './documents.controller';

/**
 * Document templates — authoring them, and starting a document from one.
 *
 * **Two permissions on one controller, which is the shape the split needs.** `template:manage`
 * governs the five administrative routes: a template is tenant configuration, and deciding what a
 * new deviation report starts as is the document controller's job. `POST /:id/documents` is gated
 * on `document:create` instead, because *using* a template is an ordinary create — and a template
 * confers no reach, so holding one lets nobody file a document anywhere they could not already.
 *
 * A class-level gate would have had to be the looser of the two, which would either let everybody
 * who can file a document edit the templates, or hide templates from everybody who can only use
 * them. That is the same reasoning `DocumentsController` gives for its per-operation gates.
 *
 * The create-from route deliberately carries no `@ScopedTo`: the folder is in the body, may be
 * absent (falling back to the template's default), and `AclGuard` reads route parameters. The reach
 * check happens where it always does for a create — inside `DefaultDocumentService.create`, against
 * the folder that was actually resolved.
 */
@Controller({ path: 'document-templates', version: '1' })
export class DocumentTemplatesController {
  constructor(private readonly templates: DocumentTemplateService) {}

  @Get()
  @RequirePermission(Permission.TEMPLATE_MANAGE)
  async list(
    @Query(new ZodValidationPipe(documentTemplateListQuerySchema))
    query: ReturnType<typeof documentTemplateListQuerySchema.parse>,
  ): Promise<Collection<DocumentTemplate>> {
    const page = await this.templates.list(query);
    return { data: page.data.map(toTemplate), meta: page.meta };
  }

  @Get(':id')
  @RequirePermission(Permission.TEMPLATE_MANAGE)
  async get(@Param('id') id: string): Promise<DocumentTemplate> {
    return toTemplate(await this.templates.get(id));
  }

  @Post()
  @RequirePermission(Permission.TEMPLATE_MANAGE)
  async create(
    @Body(new ZodValidationPipe(createDocumentTemplateSchema)) body: CreateDocumentTemplateBody,
  ): Promise<DocumentTemplate> {
    return toTemplate(await this.templates.create(body));
  }

  @Patch(':id')
  @RequirePermission(Permission.TEMPLATE_MANAGE)
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateDocumentTemplateSchema)) body: UpdateDocumentTemplateBody,
    @IfMatch() version: number | undefined,
  ): Promise<DocumentTemplate> {
    return toTemplate(await this.templates.update(id, body, version));
  }

  @Delete(':id')
  @RequirePermission(Permission.TEMPLATE_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @IfMatch() version: number | undefined): Promise<void> {
    await this.templates.remove(id, version);
  }

  @Post(':id/restore')
  @RequirePermission(Permission.TEMPLATE_MANAGE)
  async restore(
    @Param('id') id: string,
    @IfMatch() version: number | undefined,
  ): Promise<DocumentTemplate> {
    return toTemplate(await this.templates.restore(id, version));
  }

  /**
   * A new document, from this template.
   *
   * `document:create`, not `template:manage`. Everything the manual create enforces still runs —
   * the folder's reach, the type's rules, the confidentiality floor, the metadata validation, the
   * duplicate warning, the first revision and its blob reference, the audit event.
   */
  @Post(':id/documents')
  @RequirePermission(Permission.DOCUMENT_CREATE)
  async createDocument(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(createFromTemplateSchema)) body: CreateFromTemplateBody,
  ): Promise<Document> {
    return toDocument(await this.templates.createFrom(id, body));
  }
}

function toTemplate(record: DocumentTemplateRecord): DocumentTemplate {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    documentTypeId: record.documentTypeId,
    documentTypeName: record.documentTypeName,
    categoryId: record.categoryId,
    confidentialityId: record.confidentialityId,
    confidentialityName: record.confidentialityName,
    defaultFolderId: record.defaultFolderId,
    defaultFolderPath: record.defaultFolderPath,
    fileObjectId: record.fileObjectId,
    filename: record.filename,
    defaultMetadata: record.defaultMetadata as DocumentTemplate['defaultMetadata'],
    isActive: record.isActive,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    version: record.version,
  };
}
