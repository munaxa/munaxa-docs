import { DOCS_PRODUCT_KEY } from '@edms/domain';
import { entitlementsPath, readEntitlementResponse, unreachable } from '@munaxa/licensing';

import type { OutboundHttpPort } from '../../ports/outbound-http.port';
import type { EntitlementLookup, EntitlementLookupResult } from './licensing.ports';

const TIMEOUT_MS = 3_000;

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
  ) {}

  async lookup(tenantId: string): Promise<EntitlementLookupResult> {
    const result = await this.http.send({
      url: `${this.settings.url}${entitlementsPath(DOCS_PRODUCT_KEY, tenantId)}`,
      method: 'GET',
      headers: { authorization: `Bearer ${this.settings.token}`, accept: 'application/json' },
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
