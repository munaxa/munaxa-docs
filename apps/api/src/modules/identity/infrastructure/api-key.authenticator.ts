import { Inject, Injectable } from '@nestjs/common';

import { type TenantId, asId } from '@edms/domain';

import {
  type ApiKeyAuthenticator,
  type ApiKeyPrincipal,
} from '../../../core/auth/api-key.authenticator';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { TENANT_REGISTRY, type TenantRegistry } from '../../../core/tenancy/tenant-registry.port';
import { API_CLIENT_SERVICE, type ApiClientAuthenticator } from '../application/api-client.ports';

/**
 * Binds `API_KEY_AUTHENTICATOR` to the Identity module's own resolution.
 *
 * Its whole job is the thing `DefaultAuthenticationService.withinTenant` does for sign-in: **a
 * context has to exist before any query can run**, because every read is inside a transaction
 * carrying `app.tenant_id` and under row-level security keyed on it. A key is presented before any
 * context exists — that is what it is for — so the tenant is resolved from the host through the
 * registry, a context is established with no user in it, and only then is the credential read.
 *
 * The context established here is *provisional*: no user, no roles, no permissions. Nothing can be
 * authorised inside it. What the caller may actually do comes from the principal this returns,
 * which the middleware then builds the real context from.
 */
@Injectable()
export class IdentityApiKeyAuthenticator implements ApiKeyAuthenticator {
  constructor(
    @Inject(API_CLIENT_SERVICE) private readonly clients: ApiClientAuthenticator,
    @Inject(TENANT_REGISTRY) private readonly registry: TenantRegistry,
  ) {}

  async authenticate(tenantSlug: string, presented: string): Promise<ApiKeyPrincipal | null> {
    const placement = await this.resolvePlacement(tenantSlug);
    if (!placement) {
      return null;
    }
    const tenantId = asId<TenantId>(placement);

    const provisional: RequestContext = {
      tenantId,
      // Nobody is acting yet — resolving the key is what decides who. `RequestContext` allows it,
      // and the only things that read this context are the Prisma extension and the settings
      // reader, both of which read `tenantId` alone.
      userId: null,
      roles: [],
      permissions: [],
      sessionId: null,
      correlationId: `api-key:${tenantId}`,
      permissionVersion: 0,
      locale: 'en',
    };

    const principal = await runWithContext(provisional, () =>
      this.clients.authenticate(tenantId, presented),
    );
    if (!principal) {
      return null;
    }

    return {
      apiClientId: principal.apiClientId,
      tenantId: principal.tenantId,
      subjectUserId: principal.subjectUserId,
      roleKeys: principal.roleKeys,
      permissions: principal.permissions,
      permissionVersion: principal.permissionVersion,
    };
  }

  /**
   * The tenant the host names, or — for a host with no label to spare — the deployment's only one.
   *
   * The fallback exists because a single-tenant installation is served at `docs.customer.example`
   * with nothing to the left of it, and requiring such a customer to invent a subdomain in order
   * to use an API key would be configuration for its own sake. It is safe precisely because it is
   * only reachable when the deployment has exactly one tenant: with two, an unqualified host is
   * ambiguous and the key is refused rather than resolved against a guess.
   */
  private async resolvePlacement(slug: string): Promise<string | null> {
    if (slug !== '') {
      const named = await this.registry.bySlug(slug);
      return named?.id ?? null;
    }
    const all = await this.registry.all();
    return all.length === 1 ? (all[0]?.id ?? null) : null;
  }
}
