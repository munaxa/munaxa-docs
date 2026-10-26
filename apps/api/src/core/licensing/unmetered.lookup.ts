import { ALL_DOCS_FEATURES, ALL_DOCS_LIMITS, DOCS_PRODUCT_KEY } from '@edms/domain';
import type { EntitlementSnapshot } from '@munaxa/licensing';

import type { EntitlementLookup, EntitlementLookupResult } from './licensing.ports';

/**
 * `LICENSING_MODE=NONE`: every tenant on an unlimited plan.
 *
 * ADR-0012 §2 — "there is no no-subscription code path". A deployment that sells nothing still
 * evaluates a snapshot through the same contract, so turning licensing on later changes the
 * snapshot and nothing else. Every feature this product defines, every limit unlimited.
 */
export class UnmeteredLookup implements EntitlementLookup {
  readonly source = 'UNMETERED' as const;
  readonly cachesSnapshots = false;

  constructor(private readonly deployment: 'SAAS' | 'ON_PREMISES') {}

  lookup(
    tenantId: string,
    _lastObservedAt: Date | null,
    now: Date,
  ): Promise<EntitlementLookupResult> {
    const snapshot: EntitlementSnapshot = {
      schemaVersion: 1,
      customerId: 'unmetered',
      tenantId,
      product: DOCS_PRODUCT_KEY,
      deployment: this.deployment,
      subscriptionId: 'unmetered',
      plan: { code: 'unmetered', version: 1 },
      status: 'ACTIVE',
      trialEndsAt: null,
      expiresAt: null,
      graceUntil: null,
      features: ALL_DOCS_FEATURES,
      limits: Object.fromEntries(ALL_DOCS_LIMITS.map((key) => [key, null])),
      resolvedAt: now.toISOString(),
    };
    return Promise.resolve({ kind: 'SNAPSHOT', snapshot });
  }
}
