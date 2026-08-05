import { Body, Controller, Delete, Get, Inject, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import {
  type FederationCallbackBody,
  type FederationDiscovery,
  type IdentityProvider as WireIdentityProvider,
  type UpsertIdentityProviderBody,
  federationCallbackSchema,
  federationDiscoverySchema,
  upsertIdentityProviderSchema,
} from '@edms/contracts';
import { Permission } from '@edms/domain';
import { negotiateLocale } from '@edms/i18n';

import { Public } from '../../../core/auth/public.decorator';
import { RequirePermission } from '../../../core/authorization/permission.decorator';
import { correlationIdOf } from '../../../core/http/correlation-id.middleware';
import { ZodValidationPipe } from '../../../core/http/zod-validation.pipe';
import { FEDERATION_SERVICE, type FederationService } from '../application/federation.ports';
import {
  IDENTITY_PROVIDER_ADMIN_SERVICE,
  type IdentityProviderAdminService,
} from '../application/identity-provider-admin.service';
import type { IdentityProviderRecord } from '../application/federation.ports';
import type { AuthenticationResponse } from './auth.dto';
import { respondWith } from './auth.dto';

/**
 * Federated sign-in — the public half.
 *
 * Both routes are `@Public` and each says why, on the same reasoning `AuthController`'s three
 * are: they are how a caller *becomes* authenticated, so requiring authentication would be
 * circular. `RoutePermissionRegistry` accepts a mutating route with a stated public reason and
 * refuses one with neither, which is what keeps that exemption a decision rather than an
 * oversight.
 *
 * The discovery route is a `GET` with the address in the query string rather than a `POST` with a
 * body, and that is worth one line of justification because it puts an email address in a log:
 * a browser has to be able to reach it before anything is signed in, and the caller supplied the
 * address themselves on a form they can see. It answers a boolean, so it discloses nothing about
 * the tenant it was asked about.
 */
@Controller({ path: 'auth/federation', version: '1' })
export class FederationController {
  constructor(@Inject(FEDERATION_SERVICE) private readonly federation: FederationService) {}

  @Get()
  @Public('A sign-in screen asks this before anybody is signed in; requiring a token is circular.')
  async discover(
    @Query(new ZodValidationPipe(federationDiscoverySchema))
    query: ReturnType<typeof federationDiscoverySchema.parse>,
    @Req() request: Request,
  ): Promise<FederationDiscovery> {
    const offer = await this.federation.offerFor(query.email, tenantFromHost(request));
    return { federated: offer.federated, authorizationUrl: offer.authorizationUrl };
  }

  @Post('callback')
  @Public('The callback carries the provider’s code and is what produces a token.')
  async callback(
    @Body(new ZodValidationPipe(federationCallbackSchema)) body: FederationCallbackBody,
    @Req() request: Request,
  ): Promise<AuthenticationResponse> {
    const result = await this.federation.complete({
      code: body.code,
      state: body.state,
      tenantSlug: body.tenant ?? tenantFromHost(request),
      ipAddress: request.ip ?? null,
      userAgent: request.header('user-agent') ?? null,
      correlationId: correlationIdOf(request),
      locale: negotiateLocale(request.headers['accept-language']),
    });
    // The same response a password sign-in produces, deliberately: a federated session is an
    // ordinary session, so nothing downstream of authentication knows which way somebody arrived.
    return respondWith(result);
  }
}

/**
 * The tenant's identity provider — the administered half, behind `integration:manage`.
 *
 * `PUT` rather than `POST`, because there is at most one per tenant and the resource is therefore
 * addressed rather than created. A tenant migrating between providers replaces the row, which is
 * what a `PUT` means.
 */
@Controller({ path: 'admin/identity-provider', version: '1' })
@RequirePermission(Permission.INTEGRATION_MANAGE)
export class IdentityProviderController {
  constructor(
    @Inject(IDENTITY_PROVIDER_ADMIN_SERVICE)
    private readonly providers: IdentityProviderAdminService,
  ) {}

  @Get()
  async get(): Promise<WireIdentityProvider | null> {
    const provider = await this.providers.get();
    return provider ? toWire(provider) : null;
  }

  @Put()
  async upsert(
    @Body(new ZodValidationPipe(upsertIdentityProviderSchema)) body: UpsertIdentityProviderBody,
  ): Promise<WireIdentityProvider> {
    return toWire(await this.providers.upsert(body));
  }

  @Delete()
  async remove(): Promise<void> {
    await this.providers.remove();
  }
}

function toWire(record: IdentityProviderRecord): WireIdentityProvider {
  return {
    id: record.id,
    kind: record.kind,
    name: record.name,
    issuer: record.issuer,
    discoveryUrl: record.discoveryUrl,
    clientId: record.clientId,
    domains: [...record.domains],
    claimMapping: { ...record.claimMapping },
    roleMappings: record.roleMappings.map((mapping) => ({ ...mapping })),
    defaultRoleKeys: [...record.defaultRoleKeys],
    jitProvisioning: record.jitProvisioning,
    enabled: record.enabled,
    version: record.version,
    // `clientSecret` is absent from the wire type entirely, which is the enforcement: there is no
    // field a mapper could forget to omit.
  };
}

/** The same host rule `AuthController` and the API-key middleware apply. See either for why. */
function tenantFromHost(request: Request): string {
  const host = (request.hostname || '').toLowerCase();
  const labels = host.split('.');
  return labels.length > 2 ? (labels[0] ?? '') : '';
}
