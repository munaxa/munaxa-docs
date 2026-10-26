import { Controller, Get } from '@nestjs/common';
import { OperationKind, accessModeOf } from '@munaxa/licensing';

import type { SubscriptionView } from '@edms/contracts';
import { DOCS_PRODUCT_KEY, Permission } from '@edms/domain';

import { RequirePermission } from '../authorization/permission.decorator';
import { requireContext } from '../tenancy/tenant-context';
import { EntitlementService } from './entitlement.service';
import { LicensedAs } from './licensed.decorator';

/**
 * `GET /v1/subscription` — what this organisation's plan includes and permits now.
 *
 * Read by a tenant administrator, about their own tenant, from the verified token's tenant and
 * never a parameter. Reachable in export-only, because the organisation whose access has been
 * narrowed is exactly the one that needs to be told why.
 */
@Controller({ path: 'subscription', version: '1' })
@RequirePermission(Permission.SETTINGS_MANAGE)
export class SubscriptionController {
  constructor(private readonly entitlements: EntitlementService) {}

  @Get()
  @LicensedAs(
    OperationKind.EXPORT,
    'An organisation whose access is narrowed must be able to see why.',
  )
  async view(): Promise<SubscriptionView> {
    const { tenantId } = requireContext();
    const resolution = await this.entitlements.resolve(tenantId);
    const { snapshot } = resolution;
    const { mode, status } = accessModeOf(snapshot, {
      now: resolution.evaluatedAt,
      tenantId,
      product: DOCS_PRODUCT_KEY,
      cap: resolution.cap,
    });
    return {
      origin: resolution.origin,
      freshness: resolution.source,
      status,
      mode,
      plan: snapshot?.plan ?? null,
      features: snapshot?.features ?? [],
      limits: snapshot?.limits ?? {},
      trialEndsAt: snapshot?.trialEndsAt ?? null,
      expiresAt: snapshot?.expiresAt ?? null,
      graceUntil: snapshot?.graceUntil ?? null,
    };
  }
}
