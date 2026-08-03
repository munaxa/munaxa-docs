import { Global, Module } from '@nestjs/common';

import { SETTINGS_READER } from '../../core/settings/settings.port';
import { TENANT_SETTINGS_REPOSITORY } from './application/ports';
import { CachedSettingsReader } from './infrastructure/cached-settings.reader';
import { PrismaTenantSettingsRepository } from './infrastructure/prisma-tenant-settings.repository';

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
 * Phase 1 implements the settings read path. The administration surface over it — creating and
 * editing configuration, with soft delete, restore, search and pagination — is Phase 2, which
 * owns that capability.
 */
@Global()
@Module({
  providers: [
    { provide: TENANT_SETTINGS_REPOSITORY, useClass: PrismaTenantSettingsRepository },
    { provide: SETTINGS_READER, useClass: CachedSettingsReader },
  ],
  exports: [SETTINGS_READER, TENANT_SETTINGS_REPOSITORY],
})
export class AdministrationModule {}
