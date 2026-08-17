import { Controller, Get, Inject, Query } from '@nestjs/common';

import {
  type CategoryOption,
  type Collection,
  type ConfidentialityOption,
  type DocumentTypeOption,
  categoryOptionQuerySchema,
  confidentialityOptionQuerySchema,
  documentTypeOptionQuerySchema,
} from '@edms/contracts';
import { Permission, depthOf } from '@edms/domain';

import { RequirePermission } from '../../../core/authorization/permission.decorator';
import { ZodValidationPipe } from '../../../core/http/zod-validation.pipe';
import { CONFIGURATION_SERVICE } from '../application/administration.ports';
import type {
  CategoryRow,
  ConfidentialityLevelRow,
  DocumentTypeRow,
} from '../application/administration.ports';
import type { ConfigurationService } from '../application/configuration.service';
import { toCollection } from './administration.view';

/**
 * The tenant's document vocabulary, for the people who file documents rather than define it.
 *
 * ## Why a second controller over the same service
 *
 * `ConfigurationController` is `settings:manage` from its class decorator down, and correctly so —
 * it creates, renames and deletes the vocabulary. The problem it caused was measured rather than
 * theorised: a document controller holds `document:create` and `document:edit`, needs a type, a
 * category and a confidentiality level to exercise them, and could read none of the three. Every
 * request answered 403 and `/documents` rendered the route's error boundary. Only a tenant
 * administrator could open the workspace at all.
 *
 * The first two fixes in this sequence relaxed the *existing* route — libraries in Phase 6.3,
 * folders in `588d851` — because in both cases the administrative response was also the right
 * response for a reader. Here it is not. `DocumentType` carries the numbering rule, the workflow
 * and the retention schedule; `ConfidentialityLevel` carries the handling policy that decides
 * whether anybody may download or print. Relaxing those routes would have handed a filing clerk the
 * tenant's security configuration because a dropdown needed a label.
 *
 * So the administrative routes are untouched and keep `settings:manage`, and these three return the
 * subset that was measured to be consumed. The rows come from `ConfigurationService` — the same
 * reads, the same tenant scoping, the same soft-delete rules — and only the projection differs.
 * Nothing here duplicates a decision that module already makes.
 *
 * ## Why no `@ScopedTo`
 *
 * Because there is no node to scope to. A document type belongs to the tenant, not to a folder;
 * `RbacGuard`'s tenant-wide answer *is* the whole answer, exactly as it is for `/admin/libraries`'s
 * list. Adding a scope check here would be inventing a reach question the domain does not have.
 */
@Controller({ path: 'configuration', version: '1' })
@RequirePermission(Permission.CONFIGURATION_VIEW)
export class ConfigurationReadController {
  constructor(@Inject(CONFIGURATION_SERVICE) private readonly config: ConfigurationService) {}

  /**
   * The types a document may be filed as.
   *
   * `isActive` is a filter rather than a fixed `true`, and the *edit* path is why. A type that has
   * been retired stays attached to the documents already filed under it, and the properties form
   * resolves a document's own type by id to know which fields to draw. Serving only active types
   * would leave every one of those documents with an empty metadata section — a silent trap, not a
   * tightening. The workspace asks for `isActive=true` because that is what a *new* document may
   * choose; the properties form asks for all of them.
   */
  @Get('document-types')
  async documentTypes(
    @Query(new ZodValidationPipe(documentTypeOptionQuerySchema))
    query: ReturnType<typeof documentTypeOptionQuerySchema.parse>,
  ): Promise<Collection<DocumentTypeOption>> {
    return toCollection(
      await this.config.listDocumentTypes({
        ...query,
        isActive: query.isActive === undefined ? undefined : query.isActive === 'true',
        deleted: 'live',
      }),
      toDocumentTypeOption,
    );
  }

  @Get('categories')
  async categories(
    @Query(new ZodValidationPipe(categoryOptionQuerySchema))
    query: ReturnType<typeof categoryOptionQuerySchema.parse>,
  ): Promise<Collection<CategoryOption>> {
    return toCollection(
      await this.config.listCategories({ ...query, deleted: 'live' }),
      toCategoryOption,
    );
  }

  @Get('confidentiality-levels')
  async confidentialityLevels(
    @Query(new ZodValidationPipe(confidentialityOptionQuerySchema))
    query: ReturnType<typeof confidentialityOptionQuerySchema.parse>,
  ): Promise<Collection<ConfidentialityOption>> {
    return toCollection(
      await this.config.listConfidentiality({ ...query, deleted: 'live' }),
      toConfidentialityOption,
    );
  }
}

// --- Projections --------------------------------------------------------------------------
//
// Written out field by field rather than spread-and-omit. A projection built by deleting keys from
// an administrative row grows a new field every time the administrative row does, silently; one
// built by naming what it carries does not, and the contract's spec asserts the difference.

function toDocumentTypeOption(row: DocumentTypeRow): DocumentTypeOption {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    isActive: row.isActive,
    defaultConfidentialityId: row.defaultConfidentialityId,
    fields: row.fields.map((field) => ({
      metadataFieldId: field.metadataFieldId,
      key: field.key,
      name: field.name,
      dataType: field.dataType,
      isRequired: field.isRequired,
      sortOrder: field.sortOrder,
      defaultValue: field.defaultValue,
      options: field.options.map((option) => ({ value: option.value, label: option.label })),
      description: field.description,
    })),
  };
}

function toCategoryOption(row: CategoryRow): CategoryOption {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    parentId: row.parentId,
    path: row.path,
    // Derived from the path, as `toCategory` derives it: there is no `depth` column, and two
    // sources for one number is one source too many after a move.
    depth: depthOf(row.path),
  };
}

function toConfidentialityOption(row: ConfidentialityLevelRow): ConfidentialityOption {
  return { id: row.id, code: row.code, name: row.name, rank: row.rank };
}
