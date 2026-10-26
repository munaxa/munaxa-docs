import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { OperationKind } from '@munaxa/licensing';

import { DocsFeature, type DocsFeatureKey } from '@edms/domain';

import { PUBLIC_ROUTE } from '../auth/public.decorator';
import { currentContext } from '../tenancy/tenant-context';
import { EntitlementService } from './entitlement.service';
import { LICENSED_OPERATION, REQUIRED_FEATURE } from './licensed.decorator';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Does the tenant's subscription permit this request at all? — ADR-0012, ADR-0026.
 *
 * Global, after authentication and tenant isolation and before the permission, in that order on
 * purpose: the tenant it asks about is the verified one from the token and never one the client
 * named, and "your plan does not include this" is a better answer than "forbidden" for a feature
 * nobody in the organisation can use.
 *
 * Every route is covered without being annotated: a read verb needs `READ`, anything else `WRITE`.
 * So an expired subscription is read-only on the day it expires, on routes written after this
 * guard as much as before. A route that grows a quota or must survive into export-only says so with
 * `@LicensedAs`. Health, metrics and sign-in are `@Public` and never reach a licensing decision —
 * an installation that cannot report its health, or let somebody sign in to export, cannot be
 * recovered.
 *
 * A machine caller additionally needs `api.access`: an API key minted while the plan included it
 * stops working when the plan stops including it, without anybody revoking it.
 */
@Injectable()
export class EntitlementGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: EntitlementService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<string | undefined>(PUBLIC_ROUTE, targets)) return true;
    const requestContext = currentContext();
    // Unauthenticated requests never get here past `AuthenticationGuard`; nothing to ask about.
    if (requestContext === null) return true;

    const declared = this.reflector.getAllAndOverride<{ operation: OperationKind } | undefined>(
      LICENSED_OPERATION,
      targets,
    );
    const method = context.switchToHttp().getRequest<{ method: string }>().method.toUpperCase();
    const operation =
      declared?.operation ?? (READ_METHODS.has(method) ? OperationKind.READ : OperationKind.WRITE);

    const features: DocsFeatureKey[] = [];
    const feature = this.reflector.getAllAndOverride<DocsFeatureKey | undefined>(
      REQUIRED_FEATURE,
      targets,
    );
    if (feature !== undefined) features.push(feature);
    if (requestContext.apiClientId !== undefined) features.push(DocsFeature.API_ACCESS);

    await this.entitlements.require(operation, features);
    return true;
  }
}
