import { Global, Module } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../config';
import { POLICY_EVALUATOR } from '../authorization/policy.port';
import { OUTBOUND_HTTP_PORT, type OutboundHttpPort } from '../../ports/outbound-http.port';
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

/**
 * Chooses the lookup `LICENSING_MODE` names. Boot validation has already refused a mode whose
 * inputs are missing, so a missing input here is a programming error and is thrown as one rather
 * than quietly falling back to the unlimited plan.
 */
export function entitlementLookupFor(config: AppConfig, http: OutboundHttpPort): EntitlementLookup {
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
      return new ControlPlaneLookup(http, controlPlane);
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
      inject: [APP_CONFIG, OUTBOUND_HTTP_PORT],
      useFactory: entitlementLookupFor,
    },
    { provide: ENTITLEMENT_STATE_STORE, useClass: PrismaEntitlementStateStore },
    EntitlementService,
    { provide: POLICY_EVALUATOR, useExisting: EntitlementService },
    EntitlementGuard,
  ],
  exports: [EntitlementService, POLICY_EVALUATOR, EntitlementGuard],
})
export class LicensingModule {}
