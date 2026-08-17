import { Global, Module } from '@nestjs/common';

import { SETTINGS_READER } from '../../core/settings/settings.port';
import {
  CONFIGURATION_REPOSITORY,
  CONFIGURATION_SERVICE,
  NUMBERING_ADMIN_SERVICE,
  SETTINGS_ADMIN_SERVICE,
} from './application/administration.ports';
import {
  APPROVAL_ROUTING_REPOSITORY,
  APPROVAL_ROUTING_SERVICE,
} from './application/approval-routing.ports';
import { ApprovalRoutingService } from './application/approval-routing.service';
import { ConfigurationService } from './application/configuration.service';
import { NumberingAdminService } from './application/numbering-admin.service';
import { NumberingIssueService } from './application/numbering-issue.service';
import { NUMBER_ISSUE_REPOSITORY } from './application/numbering-issue.ports';
import { SettingsAdminService } from './application/settings-admin.service';
import { NUMBERING_SERVICE, TENANT_SETTINGS_REPOSITORY } from './application/ports';
import { CachedSettingsReader } from './infrastructure/cached-settings.reader';
import { PrismaApprovalRoutingRepository } from './infrastructure/prisma-approval-routing.repository';
import { PrismaConfigurationRepository } from './infrastructure/prisma-configuration.repository';
import { PrismaNumberIssueRepository } from './infrastructure/prisma-number-issue.repository';
import { PrismaTenantSettingsRepository } from './infrastructure/prisma-tenant-settings.repository';
import { ApprovalRoutingController } from './presentation/approval-routing.controller';
import { ConfigurationReadController } from './presentation/configuration-read.controller';
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
 * RetentionPolicy, ConfidentialityLevel, TenantSettings, ApprovalGroup, WorkingCalendar
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
    // The same vocabulary, projected for the people who *file* documents rather than define it.
    // A second controller because it is a second permission — `configuration:view` — and a
    // class-level gate is what lets that be true of every route on it.
    ConfigurationReadController,
    ApprovalRoutingController,
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
    { provide: NUMBER_ISSUE_REPOSITORY, useClass: PrismaNumberIssueRepository },
    { provide: NUMBERING_SERVICE, useClass: NumberingIssueService },
    { provide: SETTINGS_ADMIN_SERVICE, useClass: SettingsAdminService },
    { provide: APPROVAL_ROUTING_REPOSITORY, useClass: PrismaApprovalRoutingRepository },
    { provide: APPROVAL_ROUTING_SERVICE, useClass: ApprovalRoutingService },
  ],
  exports: [
    SETTINGS_READER,
    TENANT_SETTINGS_REPOSITORY,
    // Phase 3: a document is assembled from a document type, a category and a confidentiality
    // level, and Document asks about all three through this service rather than by reading the
    // rows behind it.
    CONFIGURATION_SERVICE,
    // Phase 4: the workflow engine resolves a `GROUP` participant and counts a deadline against a
    // working calendar. Both are this module's configuration, and both are reached through this
    // service rather than by reading the rows behind them.
    APPROVAL_ROUTING_SERVICE,
    // Phase 5: Document draws, commits and voids numbers through this service. It is the only
    // way a value leaves a sequence — the rows behind it are this module's own.
    NUMBERING_SERVICE,
  ],
})
export class AdministrationModule {}
