import { Global, Module } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../config';
import { POLICY_EVALUATOR } from '../authorization/policy.port';
import { OUTBOUND_HTTP_PORT, type OutboundHttpPort } from '../../ports/outbound-http.port';
import { TENANT_REGISTRY, type TenantRegistry } from '../tenancy/tenant-registry.port';
import { ControlPlaneLookup } from './control-plane.lookup';
import { EntitlementGuard } from './entitlement.guard';
import { EntitlementService } from './entitlement.service';
import { LicenseFileLookup } from './license-file.lookup';
import {
  ENTITLEMENT_LOOKUP,
  ENTITLEMENT_STATE_STORE,
  type EntitlementLookup,
} from './licensing.ports';
import { PrismaEntitlementStateStore } from './prisma-entitlement-state.store';
import { SubscriptionController } from './subscription.controller';
import { UnmeteredLookup } from './unmetered.lookup';
import { UsageLaneConsumer } from './usage-lane.consumer';
import { UsageMeters } from './usage-meters';

/**
 * Chooses the lookup `LICENSING_MODE` names. Boot validation has already refused a mode whose
 * inputs are missing, so a missing input here is a programming error and is thrown as one rather
 * than quietly falling back to the unlimited plan.
 */
export function entitlementLookupFor(
  config: AppConfig,
  http: OutboundHttpPort,
  registry?: TenantRegistry,
): EntitlementLookup {
  const { mode, licenseFile, controlPlane } = config.licensing;
  switch (mode) {
    case 'NONE':
      return new UnmeteredLookup(
        config.deployment.profile === 'ON_PREMISE' ? 'ON_PREMISES' : 'SAAS',
      );
    case 'LICENSE_FILE':
      if (licenseFile === null) throw new Error('LICENSING_MODE=LICENSE_FILE without its settings');
      return new LicenseFileLookup(licenseFile);
    case 'CONTROL_PLANE':
      if (controlPlane === null)
        throw new Error('LICENSING_MODE=CONTROL_PLANE without its settings');
      // The organisation's slug travels with each question, so Control can offer an unlinked tenant
      // to its operator by name. A slug is already in every sign-in URL; nothing secret is sent.
      return new ControlPlaneLookup(http, controlPlane, async (tenantId) =>
        registry === undefined ? null : ((await registry.byId(tenantId))?.slug ?? null),
      );
  }
}

/**
 * Licensing — ADR-0026. Global for the reason audit is: every module that grows a metered
 * quantity enforces its limit here, and entitlements are a cross-cutting read.
 *
 * Binds `POLICY_EVALUATOR`, which Phase 0.5 declared and nothing had bound.
 */
@Global()
@Module({
  controllers: [SubscriptionController],
  providers: [
    {
      provide: ENTITLEMENT_LOOKUP,
      inject: [APP_CONFIG, OUTBOUND_HTTP_PORT, TENANT_REGISTRY],
      useFactory: entitlementLookupFor,
    },
    { provide: ENTITLEMENT_STATE_STORE, useClass: PrismaEntitlementStateStore },
    EntitlementService,
    { provide: POLICY_EVALUATOR, useExisting: EntitlementService },
    EntitlementGuard,
    UsageMeters,
    UsageLaneConsumer,
  ],
  exports: [EntitlementService, POLICY_EVALUATOR, EntitlementGuard, UsageMeters],
})
export class LicensingModule {}
