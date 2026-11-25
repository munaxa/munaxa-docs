import { DOCS_PRODUCT_KEY } from '@edms/domain';
import { entitlementsPath, readEntitlementResponse, unreachable } from '@munaxa/licensing';

import type { OutboundHttpPort } from '../../ports/outbound-http.port';
import type { EntitlementLookup, EntitlementLookupResult } from './licensing.ports';

const TIMEOUT_MS = 3_000;

/**
 * Sent beside each question: this deployment's name for the tenant (its organisation's slug). Munaxa
 * Control keeps it only for a tenant no customer holds yet, so an operator linking the tenant picks
 * it by name from a list instead of copying its identifier. It changes nothing about the answer.
 */
export const TENANT_LABEL_HEADER = 'munaxa-tenant-label';

/** How the lookup learns a tenant's name for Control. `null` sends none. */
export type TenantLabelOf = (tenantId: string) => Promise<string | null>;

/**
 * `LICENSING_MODE=CONTROL_PLANE`: the hosted mode, asking the central subscription service.
 *
 * Through the outbound port, so the service's host must be on the deployment's allow-list like any
 * other destination — a licensing client is not an exception to the SSRF boundary.
 *
 * `404` is an answer (this tenant has no Docs subscription), every other failure is an outage, and
 * a snapshot that does not parse is an outage too: the safe reading of a body nobody can parse is
 * that nothing was learned, not that nothing is included.
 */
export class ControlPlaneLookup implements EntitlementLookup {
  readonly source = 'CONTROL_PLANE' as const;
  readonly cachesSnapshots = true;

  constructor(
    private readonly http: OutboundHttpPort,
    private readonly settings: { readonly url: string; readonly token: string },
    private readonly labelOf: TenantLabelOf = () => Promise.resolve(null),
  ) {}

  async lookup(tenantId: string): Promise<EntitlementLookupResult> {
    const label = await this.labelOf(tenantId).catch(() => null);
    const result = await this.http.send({
      url: `${this.settings.url}${entitlementsPath(DOCS_PRODUCT_KEY, tenantId)}`,
      method: 'GET',
      headers: {
        authorization: `Bearer ${this.settings.token}`,
        accept: 'application/json',
        ...(label !== null && { [TENANT_LABEL_HEADER]: label }),
      },
      timeoutMs: TIMEOUT_MS,
    });
    if (!result.ok) return unreachable(result.failure.kind);
    // The shared reading (`@munaxa/licensing`), so this product draws the outage/cancellation line
    // exactly where School and Work do.
    return readEntitlementResponse(result.response, {
      product: DOCS_PRODUCT_KEY,
      tenantId,
    });
  }
}
