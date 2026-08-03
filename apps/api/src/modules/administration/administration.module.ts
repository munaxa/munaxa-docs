import { Module } from '@nestjs/common';

/**
 * Administration — How is this tenant configured?
 *
 * **Owns:** DocumentType, Category, MetadataField, NumberingRule and its sequences, RetentionPolicy, ConfidentialityLevel, TenantSettings
 * **Depends on:** Organization
 *
 * `POLICY_EVALUATOR` and `FEATURE_FLAGS` — entitlements and settings are tenant configuration, which this module owns.
 *
 * Phase 0.5 establishes this module's contracts: the repository and service interfaces in
 * `application/`, and the event contracts in `domain/events.ts`. The entities, use cases,
 * Prisma repositories and controllers that satisfy them are built by the phase that owns
 * this capability — see `README.md` in this folder.
 */
@Module({})
export class AdministrationModule {}
