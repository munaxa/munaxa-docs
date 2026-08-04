import { Global, Module } from '@nestjs/common';

import { SETTINGS_READER } from '../../core/settings/settings.port';
import {
  CONFIGURATION_REPOSITORY,
  CONFIGURATION_SERVICE,
  NUMBERING_ADMIN_SERVICE,
  SETTINGS_ADMIN_SERVICE,
} from './application/administration.ports';
import { ConfigurationService } from './application/configuration.service';
import { NumberingAdminService } from './application/numbering-admin.service';
import { SettingsAdminService } from './application/settings-admin.service';
import { TENANT_SETTINGS_REPOSITORY } from './application/ports';
import { CachedSettingsReader } from './infrastructure/cached-settings.reader';
import { PrismaConfigurationRepository } from './infrastructure/prisma-configuration.repository';
import { PrismaTenantSettingsRepository } from './infrastructure/prisma-tenant-settings.repository';
import {
  ConfigurationController,
  NumberingAdminController,
  RetentionAdminController,
  SettingsAdminController,
} from './presentation/administration.controller';

/**
 * Administration — How is this tenant configured?
 *
 * **Owns:** DocumentType, Category, MetadataField, NumberingRule and its sequences,
 * RetentionPolicy, ConfidentialityLevel, TenantSettings
 * **Depends on:** Organization
 *
 * `SETTINGS_READER` — settings are tenant configuration, which this module owns. The port is
 * declared in `core/` because every module reads settings, and the catalogue lives in
 * `@edms/domain` so that a module can name the setting it needs without importing this
 * module's internals. Global, for the same reason audit is: configuration is a cross-cutting
 * read, not a dependency each module should have to remember to import.
 *
 * `POLICY_EVALUATOR` and `FEATURE_FLAGS` — entitlements, also this module's, still unbound.
 * They are a different question from settings: a flag hides unfinished work, an entitlement
 * expresses what a customer bought, and a setting is what the customer chose.
 *
 * Phase 1 implemented the settings read path. Phase 2 adds everything else this module owns: document
 * types, categories, metadata fields, confidentiality levels, retention policies and numbering rules,
 * plus the write path over settings themselves — each with soft delete, restore, search, paging and
 * filtering.
 *
 * Only the settings **read** port is exported. The administration services are this module's own, and
 * a module that could reach `ConfigurationService` could delete a confidentiality level while
 * resolving a document's handling rules against it.
 */
@Global()
@Module({
  controllers: [
    ConfigurationController,
    RetentionAdminController,
    NumberingAdminController,
    SettingsAdminController,
  ],
  providers: [
    { provide: TENANT_SETTINGS_REPOSITORY, useClass: PrismaTenantSettingsRepository },
    { provide: SETTINGS_READER, useClass: CachedSettingsReader },
    { provide: CONFIGURATION_REPOSITORY, useClass: PrismaConfigurationRepository },
    { provide: CONFIGURATION_SERVICE, useClass: ConfigurationService },
    { provide: NUMBERING_ADMIN_SERVICE, useClass: NumberingAdminService },
    { provide: SETTINGS_ADMIN_SERVICE, useClass: SettingsAdminService },
  ],
  exports: [
    SETTINGS_READER,
    TENANT_SETTINGS_REPOSITORY,
    // Phase 3: a document is assembled from a document type, a category and a confidentiality
    // level, and Document asks about all three through this service rather than by reading the
    // rows behind it.
    CONFIGURATION_SERVICE,
  ],
})
export class AdministrationModule {}
