import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { PUBLIC_ROUTE } from '../auth/public.decorator';
import { ForbiddenError } from '../errors/application-errors';
import { currentContext } from './tenant-context';

/**
 * Isolation layer 3: rejects any *authenticated* request that names a tenant.
 *
 * The tenant is taken from the signed token and from nowhere else. A body, query or path
 * carrying `tenantId` is not filtered out and ignored — it is refused, because a client
 * sending one is either broken or probing, and both deserve a hard answer
 * (`docs/architecture/17-security-architecture.md` §4).
 *
 * A route marked `@Public` is exempt, and has to be. This layer stops a request from acting
 * outside the tenant its token asserts; an unauthenticated request has no token and therefore
 * no tenant to exceed. Sign-in is the case that proves it: something has to say which
 * organisation the credentials belong to, and with no token yet, the only candidates are the
 * host and the request itself. Naming one buys nothing either way — the credentials still have
 * to be that organisation's, and the tenant in the issued token comes from the user record
 * rather than from what was asked for.
 *
 * Without this exemption every public route that mentions a tenant returns 403, which is how
 * it was found: sign-in refused every caller, including correct ones.
 */
const TENANT_FIELDS = ['tenantId', 'tenant_id', 'tenant'];

@Injectable()
export class TenantIsolationGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (
      this.reflector.getAllAndOverride<string | undefined>(PUBLIC_ROUTE, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const claimed = currentContext()?.tenantId ?? null;

    for (const source of [request.query, request.body, request.params]) {
      const named = this.namedTenant(source);
      if (named !== null && named !== claimed) {
        throw new ForbiddenError('act on behalf of another organisation');
      }
    }
    return true;
  }

  private namedTenant(source: unknown): string | null {
    if (typeof source !== 'object' || source === null) {
      return null;
    }
    const record = source as Record<string, unknown>;
    for (const field of TENANT_FIELDS) {
      const value = record[field];
      if (typeof value === 'string' && value.length > 0) {
        return value;
      }
    }
    return null;
  }
}
