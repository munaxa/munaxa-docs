import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';

import {
  type Category,
  type Collection,
  type ConfidentialityLevel,
  type CreateCategoryBody,
  type CreateConfidentialityLevelBody,
  type CreateDocumentTypeBody,
  type CreateMetadataFieldBody,
  type CreateNumberingRuleBody,
  type CreateRetentionPolicyBody,
  type DocumentType,
  type MetadataField,
  type MoveCategoryBody,
  type NumberingPreview,
  type NumberingRule,
  type PreviewNumberingRuleBody,
  type ResetSettingBody,
  type RetentionPolicy,
  type Setting,
  type SettingsResponse,
  type UpdateCategoryBody,
  type UpdateConfidentialityLevelBody,
  type UpdateDocumentTypeBody,
  type UpdateMetadataFieldBody,
  type UpdateNumberingRuleBody,
  type UpdateRetentionPolicyBody,
  type UpdateSettingBody,
  categoryListQuerySchema,
  confidentialityLevelListQuerySchema,
  createCategorySchema,
  createConfidentialityLevelSchema,
  createDocumentTypeSchema,
  createMetadataFieldSchema,
  createNumberingRuleSchema,
  createRetentionPolicySchema,
  documentTypeListQuerySchema,
  metadataFieldListQuerySchema,
  moveCategorySchema,
  numberingRuleListQuerySchema,
  previewNumberingRuleSchema,
  resetSettingSchema,
  retentionPolicyListQuerySchema,
  updateCategorySchema,
  updateConfidentialityLevelSchema,
  updateDocumentTypeSchema,
  updateMetadataFieldSchema,
  updateNumberingRuleSchema,
  updateRetentionPolicySchema,
  updateSettingSchema,
} from '@edms/contracts';
import { Permission } from '@edms/domain';

import { RequirePermission } from '../../../core/authorization/permission.decorator';
import { IfMatch } from '../../../core/http/admin-request';
import { ZodValidationPipe } from '../../../core/http/zod-validation.pipe';
import {
  CONFIGURATION_SERVICE,
  ConfigurationKind,
  NUMBERING_ADMIN_SERVICE,
  SETTINGS_ADMIN_SERVICE,
} from '../application/administration.ports';
import type { ConfigurationService } from '../application/configuration.service';
import type { NumberingAdminService } from '../application/numbering-admin.service';
import type { SettingsAdminService } from '../application/settings-admin.service';
import {
  toCategory,
  toCollection,
  toConfidentialityLevel,
  toDocumentType,
  toMetadataField,
  toNumberingPreview,
  toNumberingRule,
  toRetentionPolicy,
  toSetting,
  toSettings,
} from './administration.view';

/**
 * Tenant configuration.
 *
 * Split by permission rather than by resource, which is why there are four controllers here and not
 * one or six. `settings:manage`, `numbering:manage` and `retention:manage` are separate keys in the
 * catalogue with separate rows in the matrix — a document controller owns numbering and retention, and
 * only a tenant administrator owns settings — so gating a class is gating the right set of routes.
 *
 * Document types, categories and fields are all `settings:manage`: they are the vocabulary a tenant
 * administrator defines, and the matrix gives them no narrower key.
 */
@Controller({ path: 'admin', version: '1' })
@RequirePermission(Permission.SETTINGS_MANAGE)
export class ConfigurationController {
  constructor(@Inject(CONFIGURATION_SERVICE) private readonly config: ConfigurationService) {}

  // --- Confidentiality levels ------------------------------------------------------------

  @Get('confidentiality-levels')
  async listConfidentiality(
    @Query(new ZodValidationPipe(confidentialityLevelListQuerySchema))
    query: ReturnType<typeof confidentialityLevelListQuerySchema.parse>,
  ): Promise<Collection<ConfidentialityLevel>> {
    return toCollection(await this.config.listConfidentiality(query), toConfidentialityLevel);
  }

  @Get('confidentiality-levels/:id')
  async getConfidentiality(@Param('id') id: string): Promise<ConfidentialityLevel> {
    return toConfidentialityLevel(await this.config.getConfidentiality(id));
  }

  @Post('confidentiality-levels')
  @HttpCode(HttpStatus.CREATED)
  async createConfidentiality(
    @Body(new ZodValidationPipe(createConfidentialityLevelSchema))
    body: CreateConfidentialityLevelBody,
  ): Promise<ConfidentialityLevel> {
    return toConfidentialityLevel(await this.config.createConfidentiality(body));
  }

  @Patch('confidentiality-levels/:id')
  async updateConfidentiality(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateConfidentialityLevelSchema))
    body: UpdateConfidentialityLevelBody,
    @IfMatch() version: number | undefined,
  ): Promise<ConfidentialityLevel> {
    return toConfidentialityLevel(await this.config.updateConfidentiality(id, body, version));
  }

  @Delete('confidentiality-levels/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteConfidentiality(
    @Param('id') id: string,
    @IfMatch() version: number | undefined,
  ): Promise<void> {
    await this.config.delete(ConfigurationKind.CONFIDENTIALITY, id, version);
  }

  @Post('confidentiality-levels/:id/restore')
  @HttpCode(HttpStatus.NO_CONTENT)
  async restoreConfidentiality(
    @Param('id') id: string,
    @IfMatch() version: number | undefined,
  ): Promise<void> {
    await this.config.restore(ConfigurationKind.CONFIDENTIALITY, id, version);
  }

  // --- Categories ------------------------------------------------------------------------

  @Get('categories')
  async listCategories(
    @Query(new ZodValidationPipe(categoryListQuerySchema))
    query: ReturnType<typeof categoryListQuerySchema.parse>,
  ): Promise<Collection<Category>> {
    return toCollection(await this.config.listCategories(query), toCategory);
  }

  @Get('categories/:id')
  async getCategory(@Param('id') id: string): Promise<Category> {
    return toCategory(await this.config.getCategory(id));
  }

  @Post('categories')
  @HttpCode(HttpStatus.CREATED)
  async createCategory(
    @Body(new ZodValidationPipe(createCategorySchema)) body: CreateCategoryBody,
  ): Promise<Category> {
    return toCategory(await this.config.createCategory(body));
  }

  @Patch('categories/:id')
  async updateCategory(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateCategorySchema)) body: UpdateCategoryBody,
    @IfMatch() version: number | undefined,
  ): Promise<Category> {
    return toCategory(await this.config.updateCategory(id, body, version));
  }

  /** Re-parenting, as its own action: it rewrites the whole subtree's paths. */
  @Post('categories/:id/move')
  async moveCategory(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(moveCategorySchema)) body: MoveCategoryBody,
    @IfMatch() version: number | undefined,
  ): Promise<Category> {
    return toCategory(await this.config.moveCategory(id, body.parentId, version));
  }

  @Delete('categories/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteCategory(
    @Param('id') id: string,
    @IfMatch() version: number | undefined,
  ): Promise<void> {
    await this.config.delete(ConfigurationKind.CATEGORY, id, version);
  }

  @Post('categories/:id/restore')
  @HttpCode(HttpStatus.NO_CONTENT)
  async restoreCategory(
    @Param('id') id: string,
    @IfMatch() version: number | undefined,
  ): Promise<void> {
    await this.config.restore(ConfigurationKind.CATEGORY, id, version);
  }

  // --- Metadata fields -------------------------------------------------------------------

  @Get('fields')
  async listFields(
    @Query(new ZodValidationPipe(metadataFieldListQuerySchema))
    query: ReturnType<typeof metadataFieldListQuerySchema.parse>,
  ): Promise<Collection<MetadataField>> {
    return toCollection(await this.config.listMetadataFields(query), toMetadataField);
  }

  @Get('fields/:id')
  async getField(@Param('id') id: string): Promise<MetadataField> {
    return toMetadataField(await this.config.getMetadataField(id));
  }

  @Post('fields')
  @HttpCode(HttpStatus.CREATED)
  async createField(
    @Body(new ZodValidationPipe(createMetadataFieldSchema)) body: CreateMetadataFieldBody,
  ): Promise<MetadataField> {
    return toMetadataField(await this.config.createMetadataField(body));
  }

  @Patch('fields/:id')
  async updateField(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateMetadataFieldSchema)) body: UpdateMetadataFieldBody,
    @IfMatch() version: number | undefined,
  ): Promise<MetadataField> {
    return toMetadataField(await this.config.updateMetadataField(id, body, version));
  }

  @Delete('fields/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteField(
    @Param('id') id: string,
    @IfMatch() version: number | undefined,
  ): Promise<void> {
    await this.config.delete(ConfigurationKind.METADATA_FIELD, id, version);
  }

  @Post('fields/:id/restore')
  @HttpCode(HttpStatus.NO_CONTENT)
  async restoreField(
    @Param('id') id: string,
    @IfMatch() version: number | undefined,
  ): Promise<void> {
    await this.config.restore(ConfigurationKind.METADATA_FIELD, id, version);
  }

  // --- Document types --------------------------------------------------------------------

  @Get('document-types')
  async listDocumentTypes(
    @Query(new ZodValidationPipe(documentTypeListQuerySchema))
    query: ReturnType<typeof documentTypeListQuerySchema.parse>,
  ): Promise<Collection<DocumentType>> {
    // `isActive` arrives as `'true' | 'false'`, because a query string has no booleans. Narrowed once
    // here rather than in the service, which has no business knowing how HTTP spells a flag — and
    // removed from the spread first, or the string would survive alongside the boolean.
    const { isActive, ...rest } = query;
    return toCollection(
      await this.config.listDocumentTypes({
        ...rest,
        ...(isActive !== undefined && { isActive: isActive === 'true' }),
      }),
      toDocumentType,
    );
  }

  @Get('document-types/:id')
  async getDocumentType(@Param('id') id: string): Promise<DocumentType> {
    return toDocumentType(await this.config.getDocumentType(id));
  }

  @Post('document-types')
  @HttpCode(HttpStatus.CREATED)
  async createDocumentType(
    @Body(new ZodValidationPipe(createDocumentTypeSchema)) body: CreateDocumentTypeBody,
  ): Promise<DocumentType> {
    return toDocumentType(await this.config.createDocumentType(body));
  }

  @Patch('document-types/:id')
  async updateDocumentType(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateDocumentTypeSchema)) body: UpdateDocumentTypeBody,
    @IfMatch() version: number | undefined,
  ): Promise<DocumentType> {
    return toDocumentType(await this.config.updateDocumentType(id, body, version));
  }

  @Delete('document-types/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteDocumentType(
    @Param('id') id: string,
    @IfMatch() version: number | undefined,
  ): Promise<void> {
    await this.config.delete(ConfigurationKind.DOCUMENT_TYPE, id, version);
  }

  @Post('document-types/:id/restore')
  @HttpCode(HttpStatus.NO_CONTENT)
  async restoreDocumentType(
    @Param('id') id: string,
    @IfMatch() version: number | undefined,
  ): Promise<void> {
    await this.config.restore(ConfigurationKind.DOCUMENT_TYPE, id, version);
  }
}

/**
 * Retention policies, behind `retention:manage`.
 *
 * Its own controller because it is its own permission: a document controller owns how long records are
 * kept, and that is deliberately not the same authority as defining the vocabulary they are described
 * in.
 */
@Controller({ path: 'admin/retention-policies', version: '1' })
@RequirePermission(Permission.RETENTION_MANAGE)
export class RetentionAdminController {
  constructor(@Inject(CONFIGURATION_SERVICE) private readonly config: ConfigurationService) {}

  @Get()
  async list(
    @Query(new ZodValidationPipe(retentionPolicyListQuerySchema))
    query: ReturnType<typeof retentionPolicyListQuerySchema.parse>,
  ): Promise<Collection<RetentionPolicy>> {
    return toCollection(await this.config.listRetention(query), toRetentionPolicy);
  }

  @Get(':id')
  async get(@Param('id') id: string): Promise<RetentionPolicy> {
    return toRetentionPolicy(await this.config.getRetention(id));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body(new ZodValidationPipe(createRetentionPolicySchema)) body: CreateRetentionPolicyBody,
  ): Promise<RetentionPolicy> {
    return toRetentionPolicy(await this.config.createRetention(body));
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateRetentionPolicySchema)) body: UpdateRetentionPolicyBody,
    @IfMatch() version: number | undefined,
  ): Promise<RetentionPolicy> {
    return toRetentionPolicy(await this.config.updateRetention(id, body, version));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @IfMatch() version: number | undefined): Promise<void> {
    await this.config.delete(ConfigurationKind.RETENTION, id, version);
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.NO_CONTENT)
  async restore(@Param('id') id: string, @IfMatch() version: number | undefined): Promise<void> {
    await this.config.restore(ConfigurationKind.RETENTION, id, version);
  }
}

/** Numbering rules, behind `numbering:manage`. */
@Controller({ path: 'admin/numbering-rules', version: '1' })
@RequirePermission(Permission.NUMBERING_MANAGE)
export class NumberingAdminController {
  constructor(@Inject(NUMBERING_ADMIN_SERVICE) private readonly numbering: NumberingAdminService) {}

  @Get()
  async list(
    @Query(new ZodValidationPipe(numberingRuleListQuerySchema))
    query: ReturnType<typeof numberingRuleListQuerySchema.parse>,
  ): Promise<Collection<NumberingRule>> {
    const page = await this.numbering.list(query);
    return toCollection(page, (row) => toNumberingRule(row, this.numbering.sampleFor(row)));
  }

  /**
   * Renders a sample from a rule that need not exist.
   *
   * A `POST` that claims nothing: the builder previews an *unsaved* rule as it is typed, so there is
   * nothing to `GET` — and drawing a real number to show a preview would burn one. Declared with the
   * same permission as the rest, because it is part of building a rule.
   */
  @Post('preview')
  @HttpCode(HttpStatus.OK)
  preview(
    @Body(new ZodValidationPipe(previewNumberingRuleSchema)) body: PreviewNumberingRuleBody,
  ): NumberingPreview {
    return toNumberingPreview(
      this.numbering.preview({
        separator: body.separator,
        segments: body.segments,
        context: body.context,
      }),
    );
  }

  @Get(':id')
  async get(@Param('id') id: string): Promise<NumberingRule> {
    const row = await this.numbering.get(id);
    return toNumberingRule(row, this.numbering.sampleFor(row));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body(new ZodValidationPipe(createNumberingRuleSchema)) body: CreateNumberingRuleBody,
  ): Promise<NumberingRule> {
    const row = await this.numbering.create(body);
    return toNumberingRule(row, this.numbering.sampleFor(row));
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateNumberingRuleSchema)) body: UpdateNumberingRuleBody,
    @IfMatch() version: number | undefined,
  ): Promise<NumberingRule> {
    const row = await this.numbering.update(id, body, version);
    return toNumberingRule(row, this.numbering.sampleFor(row));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @IfMatch() version: number | undefined): Promise<void> {
    await this.numbering.delete(id, version);
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.NO_CONTENT)
  async restore(@Param('id') id: string, @IfMatch() version: number | undefined): Promise<void> {
    await this.numbering.restore(id, version);
  }
}

/** Tenant settings, behind `settings:manage`. */
@Controller({ path: 'admin/settings', version: '1' })
@RequirePermission(Permission.SETTINGS_MANAGE)
export class SettingsAdminController {
  constructor(@Inject(SETTINGS_ADMIN_SERVICE) private readonly settings: SettingsAdminService) {}

  @Get()
  async all(): Promise<SettingsResponse> {
    return toSettings(await this.settings.all());
  }

  /**
   * Writes one setting. `PUT`, because writing the same value twice is the same as writing it once.
   *
   * One key per request rather than the whole bag: `jsonb_set` merges in the database, so two
   * administrators saving different settings at the same moment cannot drop each other's change.
   */
  @Put()
  async set(
    @Body(new ZodValidationPipe(updateSettingSchema)) body: UpdateSettingBody,
  ): Promise<Setting> {
    return toSetting(await this.settings.set(body.key, body.value));
  }

  /** Returns a setting to the product's default by removing the override. */
  @Post('reset')
  async reset(
    @Body(new ZodValidationPipe(resetSettingSchema)) body: ResetSettingBody,
  ): Promise<Setting> {
    return toSetting(await this.settings.reset(body.key));
  }
}
